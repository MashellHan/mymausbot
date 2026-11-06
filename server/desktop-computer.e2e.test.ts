// Only the desktop app's own server may use this computer. A second OpenMausBot server on the same computer (a copy run
// from source, a demo) finds the app's driver record on disk, in the folder the app keeps it in, and still never mounts
// this computer or drives it; the app's own server, which hears the record over its parent port, still can.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./atomic.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NOT_THE_APP = "Only the OpenMausBot app on this computer can let a bot use it.";

describe("this computer belongs to the desktop app's own server", () => {
  let home = "";
  let data = "";
  let ui = "";
  let stateFile = "";
  let dumpFile = "";
  let finishFile = "";
  let output = "";
  let child: ChildProcess | null = null;
  let base = "";
  type CaseTrace = {
    label: string;
    startedAt: number;
    phases: Array<{ name: string; atMs: number }>;
    serverPort: number | null;
    healthAttempts: number;
    healthStatus: number | null;
    healthError: string | null;
    child: ChildProcess | null;
    childError: Error | null;
    stdoutBytes: number;
    stderrBytes: number;
    lastOutputAtMs: number | null;
  };
  let activeTrace: CaseTrace | null = null;
  const record = { mode: "embedded", status: "ready", socketPath: "", mcpCommand: "/fixture/cua-driver", mcpArgs: ["mcp"], mcpEnv: {} };

  const active = (trace: CaseTrace) => activeTrace === trace;
  const mark = (trace: CaseTrace, name: string) => {
    if (active(trace) && trace.phases.length < 24) trace.phases.push({ name, atMs: Math.round(performance.now() - trace.startedAt) });
  };
  const beginCase = (label: string): CaseTrace => {
    const trace: CaseTrace = {
      label, startedAt: performance.now(), phases: [], serverPort: null, healthAttempts: 0,
      healthStatus: null, healthError: null, child: null, childError: null,
      stdoutBytes: 0, stderrBytes: 0, lastOutputAtMs: null,
    };
    activeTrace = trace;
    mark(trace, "case.begin");
    return trace;
  };
  const retire = (trace: CaseTrace) => { if (active(trace)) activeTrace = null; };
  const updateOwned = (trace: CaseTrace, proc: ChildProcess, update: () => void) => {
    if (active(trace) && trace.child === proc) update();
  };
  const observed = async <T>(trace: CaseTrace, name: string, run: () => Promise<T>): Promise<T> => {
    mark(trace, `${name}.begin`);
    const value = await run();
    mark(trace, `${name}.done`);
    return value;
  };
  const errorKind = (error: unknown) => {
    if (!(error instanceof Error)) return typeof error;
    const direct = (error as NodeJS.ErrnoException).code;
    const cause = (error as { cause?: { code?: unknown } }).cause?.code;
    return typeof direct === "string" ? direct : typeof cause === "string" ? cause : error.name;
  };
  const failureState = (trace: CaseTrace) => ({
    case: trace.label, elapsedMs: Math.round(performance.now() - trace.startedAt), phases: trace.phases,
    serverPort: trace.serverPort, health: { attempts: trace.healthAttempts, status: trace.healthStatus, error: trace.healthError },
    child: { pid: trace.child?.pid ?? null, live: Boolean(trace.child && trace.child.exitCode === null && trace.child.signalCode === null && !trace.childError),
      exitCode: trace.child?.exitCode ?? null, signalCode: trace.child?.signalCode ?? null, error: trace.childError && errorKind(trace.childError),
      stdoutBytes: trace.stdoutBytes, stderrBytes: trace.stderrBytes, lastOutputAtMs: trace.lastOutputAtMs },
    files: { dump: Boolean(dumpFile && existsSync(dumpFile)), finish: Boolean(finishFile && existsSync(finishFile)) },
  });

  const resetTurn = () => {
    writeFileAtomic(stateFile, JSON.stringify({ noContainers: true }));
    rmSync(dumpFile, { force: true });
    rmSync(finishFile, { force: true });
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const apiOk = async (method: string, path: string, body?: unknown) => {
    const result = await api(method, path, body);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(400);
    return result.body;
  };
  async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
    const end = Date.now() + 20_000;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${output}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  const dump = (): Promise<any> => until((): any => {
    if (!existsSync(dumpFile)) return null;
    try { return JSON.parse(readFileSync(dumpFile, "utf8")); } catch { return null; }
  }, Boolean);
  const threadState = (botId: string, threadId: string) =>
    api("GET", "/api/bots?messages=0").then(({ body }) =>
      body.bots.find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId));
  const idle = (botId: string, threadId: string) => until(() => threadState(botId, threadId), task => Boolean(task) && !task.busy);
  const rows = async (threadId: string) =>
    ((await apiOk("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[])
      .map((message) => String(message.tool?.name ?? message.text ?? ""));

  /** `desktop`: launched as the app launches its own server, hearing the driver record over the parent port. */
  async function start(trace: CaseTrace, desktop: boolean, env: Record<string, string> = {}) {
    mark(trace, "startup.configure");
    data = mkdtempSync(join(home, "data-"));
    stateFile = join(data, "vm.json");
    dumpFile = join(data, "dump.json");
    finishFile = join(data, "finish");
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: {
      driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
      environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DUMP: dumpFile,
        FAKE_CLAUDE_TEXT_DUMP: join(data, "text-dump.json"), FAKE_CLAUDE_SLOW_FINISH_GATE: finishFile },
    } } }));
    mark(trace, "startup.ports");
    const port = await freePortBlock([0, 1]);
    if (active(trace)) trace.serverPort = port;
    base = `http://127.0.0.1:${port}`;
    const healthUrl = `${base}/api/health`;
    output = "";
    const hooks = ["--import", pathToFileURL(join(ROOT, "server/testing/group-local-vm-hooks.mjs")).href,
      ...(desktop ? ["--import", pathToFileURL(join(ROOT, "server/testing/desktop-parent.mjs")).href] : [])];
    mark(trace, "startup.spawn");
    const proc = spawn(process.execPath, [...hooks, join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: data,
        APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
        TEMP: home, TMP: home, TMPDIR: home,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: ui, OMB_TEST_VM_STATE: stateFile,
        // The app's record, where the app keeps it and where this server is pointed: neither lets it in.
        OMB_USER_DATA: join(home, "user-data"),
        ...(desktop ? { OMB_TEST_DESKTOP_CUA_CONNECTION: join(home, "user-data", "cua-connection.json") } : {}),
        ...env,
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    trace.child = proc;
    proc.stdout!.on("data", chunk => updateOwned(trace, proc, () => {
      trace.stdoutBytes += chunk.length;
      trace.lastOutputAtMs = Math.round(performance.now() - trace.startedAt);
      output += chunk;
    }));
    proc.stderr!.on("data", chunk => updateOwned(trace, proc, () => {
      trace.stderrBytes += chunk.length;
      trace.lastOutputAtMs = Math.round(performance.now() - trace.startedAt);
      output += chunk;
    }));
    proc.on("error", error => updateOwned(trace, proc, () => { trace.childError = error; }));
    mark(trace, "startup.health");
    await until(async () => {
      if (trace.childError) throw trace.childError;
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      updateOwned(trace, proc, () => { trace.healthAttempts++; });
      try {
        const response = await fetch(healthUrl);
        updateOwned(trace, proc, () => { trace.healthStatus = response.status; trace.healthError = null; });
        return response.ok;
      } catch (error) { updateOwned(trace, proc, () => { trace.healthError = errorKind(error); }); return false; }
    }, Boolean);
    mark(trace, "startup.ready");
  }
  async function stop() {
    if (!child) return;
    const proc = child;
    child = null;
    writeFileSync(finishFile, "finish");
    await waitForExit(proc, { signal: "SIGTERM" });
  }
  const itHost = process.platform === "linux" ? it.skip : it;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "omb-desktop-computer-"));
    ui = join(home, "static");
    record.socketPath = join(home, "cua.sock");
    mkdirSync(join(ui, "assets"), { recursive: true });
    writeFileSync(join(ui, "index.html"), "<title>Desktop computer</title>");
    writeFileSync(join(ui, "assets", "test.css"), "body{}");
    for (const folder of [join(home, "user-data"), join(home, "Library", "Application Support", "OpenMausBot")]) {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      writeFileSync(join(folder, "cua-connection.json"), JSON.stringify(record), { mode: 0o600 });
    }
  });
  afterAll(async () => {
    await stop();
    if (home) await removeTempDir(home);
  });
  afterEach(async ({ task }) => {
    const failed = task.result?.state === "fail";
    const trace = activeTrace;
    const owned = trace?.child ?? child;
    if (failed && trace) console.error("desktop fixture failure " + JSON.stringify(failureState(trace)));
    if (trace) retire(trace);
    await stop();
    resetTurn();
    if (failed) console.error("desktop fixture cleanup " + JSON.stringify({ complete: true, exitCode: owned?.exitCode ?? null, signalCode: owned?.signalCode ?? null }));
  });

  it("a server the app did not launch mounts no computer on Auto, though the app's record is on disk", async () => {
    const trace = beginCase("non-app auto");
    await start(trace, false);
    const { bot } = await observed(trace, "bot.create", () => apiOk("POST", "/api/bots", { name: "Second Server Bot" }));
    const { task } = await observed(trace, "task.create", () => apiOk("POST", `/api/bots/${bot.id}/tasks`, {}));
    resetTurn();
    mark(trace, "turn.reset");
    await observed(trace, "turn.send", () => apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Plan my week using my calendar.", threadId: task.threadId }));
    const sent = await observed(trace, "dump.wait", dump);
    expect(sent.mcpConfig?.mcpServers?.computer).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain("/fixture/cua-driver");
    writeFileSync(finishFile, "finish");
    mark(trace, "finish.released");
    await observed(trace, "turn.idle", () => idle(bot.id, task.threadId));
  });

  it("a server the app did not launch refuses this computer even when the person picks it, in plain words", async () => {
    const trace = beginCase("non-app refusal");
    await start(trace, false);
    const { bot } = await observed(trace, "bot.create", () => apiOk("POST", "/api/bots", { name: "Second Server Pin Bot" }));
    const { task } = await observed(trace, "task.create", () => apiOk("POST", `/api/bots/${bot.id}/tasks`, {}));
    await observed(trace, "surface.set", () => apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "local" }));
    resetTurn();
    mark(trace, "turn.reset");
    await observed(trace, "turn.send", () => apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Open Chrome on this computer.", threadId: task.threadId }));
    const failed = await observed(trace, "refusal.wait", () => until(() => rows(task.threadId), (lines) => lines.some((line) => line.includes(NOT_THE_APP))));
    expect(failed.join("\n")).not.toMatch(/CUA|Cua Driver|DevTools|descriptor/);
    expect(existsSync(dumpFile)).toBe(false);
    await observed(trace, "turn.idle", () => idle(bot.id, task.threadId));
  });

  itHost("the app's own server still uses this computer, from the record the app hands it", async () => {
    const trace = beginCase("app-owned");
    await start(trace, true);
    const { bot } = await observed(trace, "bot.create", () => apiOk("POST", "/api/bots", { name: "Desktop Server Bot" }));
    const { task } = await observed(trace, "task.create", () => apiOk("POST", `/api/bots/${bot.id}/tasks`, {}));
    await observed(trace, "surface.set", () => apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "local" }));
    resetTurn();
    mark(trace, "turn.reset");
    await observed(trace, "turn.send", () => apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Open Chrome on this computer.", threadId: task.threadId }));
    const sent = await observed(trace, "dump.wait", dump);
    expect(sent.mcpConfig.mcpServers.computer.env.OMB_CUA_COMMAND).toBe("/fixture/cua-driver");
    writeFileSync(finishFile, "finish");
    mark(trace, "finish.released");
    await observed(trace, "turn.idle", () => idle(bot.id, task.threadId));
  });

  it("retired diagnostic work cannot enter the next case", async () => {
    stateFile = join(home, "trace-vm.json");
    dumpFile = join(home, "trace-dump.json");
    finishFile = join(home, "trace-finish");
    const first = beginCase("first");
    const oldChild = {} as ChildProcess;
    first.child = oldChild;
    let complete!: (value: string) => void;
    const pending = observed(first, "dump.wait", () => new Promise<string>(resolve => { complete = resolve; }));
    updateOwned(first, oldChild, () => { first.healthAttempts++; first.stdoutBytes += 5; });
    retire(first);
    const next = beginCase("next");
    next.child = {} as ChildProcess;
    mark(next, "task.wait");
    const nextBefore = { phases: [...next.phases], healthAttempts: next.healthAttempts, stdoutBytes: next.stdoutBytes, stderrBytes: next.stderrBytes };
    complete("done");
    expect(await pending).toBe("done");
    updateOwned(first, oldChild, () => { first.healthAttempts++; first.stdoutBytes += 7; });
    updateOwned(next, oldChild, () => { next.stderrBytes++; });
    expect(next).toMatchObject(nextBefore);
    expect(first.phases.map(({ name }) => name)).toEqual(["case.begin", "dump.wait.begin"]);
    expect(first.healthAttempts).toBe(1);
    expect(first.stdoutBytes).toBe(5);
  });
});
