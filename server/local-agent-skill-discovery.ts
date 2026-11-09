import { basename, isAbsolute } from "node:path";

import { augmentedPath } from "./env-path.ts";
import { killCliTree, spawnCli } from "./procs.ts";

export type CodexSkillDiscovery = {
  status: "ready" | "partial" | "unavailable" | "timeout" | "error";
  skills: Array<{ name: string; path: string }>;
};

const failed = (status: CodexSkillDiscovery["status"]): CodexSkillDiscovery => ({ status, skills: [] });

export function discoverCodexSkills(cwd: string, options: { cli?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<CodexSkillDiscovery> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(options.cli ?? "codex", ["app-server"], {
        cwd, env: options.env ?? { ...process.env, PATH: augmentedPath() }, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch { resolve(failed("unavailable")); return; }
    let settled = false;
    let initialized = false;
    let buffer = "";
    let outputBytes = 0;
    const finish = (result: CodexSkillDiscovery) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void killCliTree(child, 1_000).then((stopped) => resolve(stopped ? result : failed("error")),
        () => resolve(failed("error")));
    };
    const send = (message: unknown) => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); }
      catch { finish(failed("error")); }
    };
    const timer = setTimeout(() => finish(failed("timeout")), options.timeoutMs ?? 10_000);
    timer.unref?.();
    child.stdin.on("error", () => finish(failed("error")));
    child.stderr.resume();
    child.on("error", (error) => finish(failed((error as NodeJS.ErrnoException).code === "ENOENT" ? "unavailable" : "error")));
    child.on("close", () => finish(failed("error")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 1024 * 1024) { finish(failed("error")); return; }
      buffer += chunk;
      let newline: number;
      while (!settled && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: any;
        try { message = JSON.parse(line); } catch { finish(failed("error")); return; }
        if (!initialized && message?.id === 1) {
          if (message.error || !message.result) { finish(failed("error")); return; }
          initialized = true;
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "skills/list", params: { cwds: [cwd], forceReload: true } });
        } else if (initialized && message?.id === 2) {
          const rows = message.error ? null : message.result?.data;
          if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.cwd !== cwd ||
              !Array.isArray(rows[0]?.skills) || rows[0].skills.length > 256 || !Array.isArray(rows[0]?.errors)) {
            finish(failed("error")); return;
          }
          const seen = new Set<string>();
          const skills: CodexSkillDiscovery["skills"] = [];
          let partial = rows[0].errors.length > 0;
          for (const item of rows[0].skills) {
            if (item?.enabled !== true) continue;
            if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 100 ||
                typeof item.path !== "string" || item.path.length > 4096 || !isAbsolute(item.path) || basename(item.path) !== "SKILL.md") {
              partial = true;
              continue;
            }
            if (seen.has(item.path)) continue;
            seen.add(item.path);
            skills.push({ name: item.name, path: item.path });
          }
          finish({ status: partial ? "partial" : "ready", skills });
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "openmausbot", version: "1" } } });
  });
}
