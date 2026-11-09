import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { discoverCodexSkills } from "./local-agent-skill-discovery.ts";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await removeTempDir(folder); });

it("uses Codex skills/list for one cwd and includes only enabled, named skill paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mausbot-codex-skills-"));
  folders.push(cwd);
  const cli = join(cwd, "fake-codex");
  await writeFile(cli, `#!/usr/bin/env node
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    const request = JSON.parse(line);
    if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
    if (request.method === "skills/list") process.stdout.write(JSON.stringify({ id: request.id, result: { data: [{
      cwd: request.params.cwds[0], skills: [
        { name: "agent-desktop", path: "/synthetic/agent-desktop/SKILL.md", enabled: true },
        { name: "disabled", path: "/synthetic/disabled/SKILL.md", enabled: false },
        { name: "duplicate", path: "/synthetic/agent-desktop/SKILL.md", enabled: true },
      ], errors: [] }] } }) + "\\n");
  }
});
`);
  await chmod(cli, 0o755);
  expect(await discoverCodexSkills(cwd, { cli })).toEqual({ status: "ready", skills: [
    { name: "agent-desktop", path: "/synthetic/agent-desktop/SKILL.md" },
  ] });
});

it("returns a truthful timeout and stops a Codex app-server that never answers skills/list", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mausbot-codex-slow-skills-"));
  folders.push(cwd);
  const cli = join(cwd, "fake-codex");
  const pidFile = join(cwd, "pid");
  const requested = join(cwd, "skills-requested");
  await writeFile(cli, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) !== -1) {
    const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
    if (request.method === "skills/list") fs.writeFileSync(${JSON.stringify(requested)}, "observed");
  }
});
`);
  await chmod(cli, 0o755);
  const started = Date.now();
  expect(await discoverCodexSkills(cwd, { cli })).toEqual({ status: "timeout", skills: [] });
  expect(Date.now() - started).toBeLessThan(8_000);
  expect(await readFile(requested, "utf8")).toBe("observed");
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});
