import { realpathSync } from "node:fs";
import { createConnection } from "node:net";

import { PI_CONTEXT_KEY, PI_CONTEXT_TTL_MS, piContextToken, readPiProcessStart } from "./local-agent-pi-context.ts";

type PiContext = {
  mode: string;
  cwd: string;
  model?: { provider: string; id: string; api: string; contextWindow?: number };
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getLeafId(): string | null;
  };
  getContextUsage(): { contextWindow: number } | undefined;
};
type PiExtension = { on(event: string, handler: (event: unknown, ctx: PiContext) => void | Promise<void>): void };

export default function installPiContext(pi: PiExtension): void {
  const endpoint = process.env.HERDR_SOCKET_PATH ?? "";
  const pane = process.env.HERDR_PANE_ID ?? "";
  if (process.platform !== "darwin" || process.env.HERDR_ENV !== "1" || !endpoint.startsWith("/") ||
      !/^w\d+:p[0-9A-Za-z]+$/.test(pane)) return;

  let context: PiContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let start: Promise<string | null> | undefined;
  let queue = Promise.resolve();
  let publishing = false;
  let observed: { ctx: PiContext; model: PiContext["model"]; declared: number | undefined; ceiling: number | undefined } | undefined;
  let possibleExpiry = 0;
  let seq = Date.now() * 1_000;

  function request(method: string, params: object): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const socket = createConnection(endpoint);
      const finish = (result: Record<string, unknown> | null) => {
        clearTimeout(deadline);
        socket.destroy();
        resolve(result);
      };
      const deadline = setTimeout(() => finish(null), 750);
      socket.on("error", () => finish(null));
      socket.on("close", () => finish(null));
      socket.on("connect", () => socket.write(JSON.stringify({ id: "omb-pi-context", method, params }) + "\n"));
      let output = "";
      socket.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
        if (output.length > 16_384) { finish(null); return; }
        const end = output.indexOf("\n");
        if (end < 0) return;
        try { finish(JSON.parse(output.slice(0, end)).result ?? null); }
        catch { finish(null); }
      });
    });
  }

  function report(token: string | null): Promise<Record<string, unknown> | null> {
    return request("pane.report_metadata", {
      pane_id: pane, source: "mausbot:pi-context", agent: "pi", applies_to_source: "herdr:pi",
      tokens: { [PI_CONTEXT_KEY]: token }, seq: ++seq, ttl_ms: PI_CONTEXT_TTL_MS,
    });
  }

  function publish(): void {
    const active = context;
    if (!active || publishing) return;
    publishing = true;
    queue = queue.then(async () => {
      if (context !== active) return;
      const identity = await (start ??= readPiProcessStart(process.pid));
      if (!identity || context !== active) return;
      try {
        const { sessionManager, model } = active;
        const leaf = sessionManager.getLeafId();
        const file = sessionManager.getSessionFile();
        const now = Date.now();
        if (observed?.ctx !== active || observed.model !== model || observed.declared !== model?.contextWindow) {
          const ceiling = model?.api && model.api !== "pi-virtual" ? active.getContextUsage()?.contextWindow : undefined;
          observed = { ctx: active, model, declared: model?.contextWindow,
            ceiling: ceiling === model?.contextWindow ? ceiling : undefined };
        }
        const window = observed.ceiling;
        const token = model && leaf && file && window !== undefined ? piContextToken({
          pane, sessionId: sessionManager.getSessionId(), file: realpathSync(file), cwd: realpathSync(active.cwd),
          leaf, provider: model.provider, model: model.id,
        }, process.pid, identity, window, now) : null;
        if (token) possibleExpiry = now + PI_CONTEXT_TTL_MS;
        await report(token);
      } catch {}
    }).finally(() => {
      publishing = false;
      if (context && context !== active) publish();
    });
  }

  function observe(_event: unknown, ctx: PiContext): void {
    if (ctx.mode !== "tui") return;
    context = ctx;
    if (!timer) {
      timer = setInterval(publish, PI_CONTEXT_TTL_MS / 2);
      timer.unref();
    }
    publish();
  }

  async function withdraw(): Promise<void> {
    context = undefined;
    if (timer) { clearInterval(timer); timer = undefined; }
    await queue;
    if (possibleExpiry <= Date.now()) return;
    const result = await report(null);
    const info = result?.type === "ok" ? (await request("pane.get", { pane_id: pane }))?.pane : null;
    const readback = info as { pane_id?: string; tokens?: Record<string, string> } | null;
    if (readback?.pane_id !== pane || readback.tokens?.[PI_CONTEXT_KEY] !== undefined) {
      // Pi can move its live leaf without writing JSONL, so an unwithdrawn sample must expire first.
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, possibleExpiry - Date.now())));
    }
    possibleExpiry = 0;
  }

  for (const event of ["session_start", "session_tree", "model_select", "agent_settled", "session_compact"]) {
    pi.on(event, observe);
  }
  for (const event of ["session_before_tree", "session_before_switch", "session_before_fork", "session_shutdown"]) {
    pi.on(event, withdraw);
  }
}
