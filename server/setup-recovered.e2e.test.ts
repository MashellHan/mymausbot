import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { requestKey } from "./saved-steps/key.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

type Task = { threadId: string; activity?: string; busy?: boolean };
type Bot = Task & { id: string; mainThreadId?: string; tasks: Task[] };

function makeApi(url: string) {
  return async <T>(method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() as T };
  };
}

it("clears a teammate's setup failure after a different conversation succeeds on the signed-in engine", async () => {
  const script = mkdtempSync(join(tmpdir(), "omb-setup-recovered-"));
  const signedOut = join(script, "signed-out");
  const reply = join(script, "reply.txt");
  writeFileSync(reply, "Signed in again.");
  let fixture: VerificationServer | undefined;
  try {
    fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_SIGNED_OUT_FILE: signedOut, FAKE_CLAUDE_REPLY_FILE: reply });
    const api = makeApi(fixture.info.url);
    expect((await api("PUT", "/api/config", { automaticRecovery: { enabled: false } })).status).toBe(200);
    const created = await api<{ bot: Bot }>("POST", "/api/bots", { name: "Quill" });
    expect(created.status).toBe(201);
    const { id, threadId, mainThreadId = threadId } = created.body.bot;
    const other = await api<{ task: Task }>("POST", `/api/bots/${id}/tasks`, { title: "Later" });
    expect(other.status).toBeLessThan(300);
    const later = other.body.task.threadId;
    const bot = async () => (await api<{ bots: Bot[] }>("GET", "/api/bots")).body.bots.find((entry) => entry.id === id);
    const send = async (target: string, text: string) => {
      expect((await api("POST", `/api/bots/${id}/messages`, { text, threadId: target })).status).toBe(202);
    };

    writeFileSync(signedOut, "");
    await send(mainThreadId, "Sign-in lapsed");
    await expect.poll(async () => (await bot())?.activity, { timeout: 15_000 }).toBe("dead");
    expect((await bot())?.tasks.find((task) => task.threadId === mainThreadId)?.activity).toBe("dead");

    rmSync(signedOut);
    await send(later, "Sign-in restored");
    await expect.poll(async () => {
      const current = await bot();
      return { activity: current?.activity, failed: current?.tasks.find((task) => task.threadId === mainThreadId)?.activity };
    }, { timeout: 15_000 }).toEqual({ activity: "idle", failed: "idle" });
  } finally {
    await fixture?.close();
    rmSync(script, { recursive: true, force: true });
  }
}, hostTimeout(60_000));

it("keeps a teammate's setup mark after an unsolicited provider-side ACP cancellation", async () => {
  const script = mkdtempSync(join(tmpdir(), "omb-setup-acp-cancel-"));
  const rpcFailure = join(script, "rpc-failure.json");
  const stopReason = join(script, "stop-reason.txt");
  let fixture: VerificationServer | undefined;
  let server: ChildProcess | undefined;
  try {
    fixture = await launchVerificationServer();
    const { dataDir, url, logPath } = fixture.info;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.myAgent = {
      driver: "customAcp",
      displayName: "Verification custom ACP",
      config: { cli: fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)) },
      environment: {
        FAKE_ACP_MODELS: "fixture-fast",
        FAKE_ACP_RPC_FAILURE_FILE: rpcFailure,
        FAKE_ACP_STOP_REASON_FILE: stopReason,
      },
    };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)),
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);

    const api = makeApi(url);
    expect((await api("PUT", "/api/config", { automaticRecovery: { enabled: false } })).status).toBe(200);
    const created = await api<{ bot: Bot }>("POST", "/api/bots", {
      name: "Quill",
      modelSelection: { instanceId: "myAgent", model: "fixture-fast" },
    });
    expect(created.status).toBe(201);
    const { id, threadId, mainThreadId = threadId } = created.body.bot;
    const other = await api<{ task: Task }>("POST", `/api/bots/${id}/tasks`, { title: "Later" });
    expect(other.status).toBeLessThan(300);
    const later = other.body.task.threadId;
    const bot = async () => (await api<{ bots: Bot[] }>("GET", "/api/bots")).body.bots.find((entry) => entry.id === id);
    const send = async (target: string, text: string) => {
      expect((await api("POST", `/api/bots/${id}/messages`, { text, threadId: target })).status).toBe(202);
    };

    writeFileSync(rpcFailure, JSON.stringify({ code: -32000, message: '402 {"type":"error","error":{"type":"billing_error","message":"Your credit balance is too low."}}' }));
    await send(mainThreadId, "Out of credits");
    await expect.poll(async () => (await bot())?.activity, { timeout: 15_000 }).toBe("dead");

    rmSync(rpcFailure);
    writeFileSync(stopReason, "cancelled");
    await send(later, "Provider cancels this turn");
    await expect.poll(async () => {
      const current = await bot();
      const laterTask = current?.tasks.find((task) => task.threadId === later);
      return laterTask && !laterTask.busy ? laterTask.activity : undefined;
    }, { timeout: 15_000 }).toBe("idle");
    expect((await bot())?.activity).toBe("dead");
    expect((await bot())?.tasks.find((task) => task.threadId === mainThreadId)?.activity).toBe("dead");

    rmSync(stopReason);
    await send(later, "Provider completes normally");
    await expect.poll(async () => {
      const current = await bot();
      return { activity: current?.activity, failed: current?.tasks.find((task) => task.threadId === mainThreadId)?.activity };
    }, { timeout: 15_000 }).toEqual({ activity: "idle", failed: "idle" });
  } finally {
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    else await fixture?.close();
    rmSync(script, { recursive: true, force: true });
  }
}, hostTimeout(60_000));

const itDarwin = process.platform === "darwin" ? it : it.skip;

itDarwin("keeps a setup mark on pure saved-steps replay and clears it when saved steps fall back to the engine", async () => {
  const script = mkdtempSync(join(tmpdir(), "omb-setup-saved-steps-"));
  const signedOut = join(script, "signed-out");
  const reply = join(script, "reply.txt");
  const cuaState = join(script, "cua-state.json");
  const cuaFail = join(script, "cua-fail");
  const cuaRecord = join(script, "cua-connection.json");
  const cuaMjs = join(script, "cua-driver.mjs");
  const cuaWrapper = join(script, "cua-driver");
  const fakeCuaUrl = pathToFileURL(fileURLToPath(new URL("./testing/fake-cua-driver.ts", import.meta.url))).href;
  writeFileSync(reply, "Signed in again.");
  writeFileSync(cuaState, JSON.stringify({ snapshot: 0, text: "" }));
  writeFileSync(cuaMjs, [
    `process.env.FAKE_CUA_STATE = ${JSON.stringify(cuaState)};`,
    `process.env.FAKE_CUA_FAIL = ${JSON.stringify(cuaFail)};`,
    `await import(${JSON.stringify(fakeCuaUrl)});`,
  ].join("\n"), { mode: 0o600 });
  writeFileSync(cuaWrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cuaMjs)} "$@"\n`, { mode: 0o700 });
  writeFileSync(cuaRecord, JSON.stringify({
    mode: "embedded",
    status: "ready",
    socketPath: join(script, "cua.sock"),
    mcpCommand: cuaWrapper,
    mcpArgs: ["mcp"],
    mcpEnv: {},
  }), { mode: 0o600 });

  let fixture: VerificationServer | undefined;
  try {
    fixture = await launchVerificationServer({
      ...process.env,
      FAKE_CLAUDE_SIGNED_OUT_FILE: signedOut,
      FAKE_CLAUDE_REPLY_FILE: reply,
      OMB_TEST_DESKTOP_CUA_CONNECTION: cuaRecord,
    });
    const api = makeApi(fixture.info.url);
    expect((await api("PUT", "/api/config", { automaticRecovery: { enabled: false } })).status).toBe(200);
    const created = await api<{ bot: Bot }>("POST", "/api/bots", { name: "Quill" });
    expect(created.status).toBe(201);
    const { id, threadId, mainThreadId = threadId } = created.body.bot;
    expect((await api("PATCH", `/api/bots/${id}`, { computer: "local" })).status).toBe(200);
    const other = await api<{ task: Task }>("POST", `/api/bots/${id}/tasks`, { title: "Later" });
    expect(other.status).toBeLessThan(300);
    const later = other.body.task.threadId;
    const bot = async () => (await api<{ bots: Bot[] }>("GET", "/api/bots")).body.bots.find((entry) => entry.id === id);
    const messages = async (target: string) => (await api<{ messages: Array<{ role: string; kind: string; text?: string; savedSteps?: { recipeId: string; replayed?: boolean } }> }>("GET", `/api/threads/${target}/messages?limit=50`)).body.messages;
    const send = async (target: string, text: string) => {
      expect((await api("POST", `/api/bots/${id}/messages`, { text, threadId: target })).status).toBe(202);
    };

    writeFileSync(signedOut, "");
    await send(mainThreadId, "Sign-in lapsed");
    await expect.poll(async () => (await bot())?.activity, { timeout: 15_000 }).toBe("dead");

    rmSync(signedOut);
    const requestText = "Open TextEdit and type hello world";
    const target = {
      app: { bundleId: "com.apple.TextEdit", name: "TextEdit" },
      window: { title: "Untitled" },
      element: { role: "AXTextArea", label: "Document", path: ["AXScrollArea:"] },
    };
    const botDir = join(fixture.info.dataDir, "bots", id);
    mkdirSync(botDir, { recursive: true });
    writeFileSync(join(botDir, "saved-steps.json"), JSON.stringify({
      version: 1,
      recipes: [{
        id: "r1",
        key: requestKey(requestText),
        request: requestText,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        steps: [
          { tool: "click", args: {}, ...target },
          { tool: "set_value", args: { value: "hello world" }, ...target },
        ],
      }],
    }));

    await send(later, requestText);
    await expect.poll(async () => {
      const current = await bot();
      const laterTask = current?.tasks.find((task) => task.threadId === later);
      return laterTask && !laterTask.busy ? laterTask.activity : undefined;
    }, { timeout: 15_000 }).toBe("idle");
    expect(await messages(later)).toContainEqual(expect.objectContaining({ savedSteps: expect.objectContaining({ replayed: true }) }));
    expect((await bot())?.activity).toBe("dead");
    expect((await bot())?.tasks.find((task) => task.threadId === mainThreadId)?.activity).toBe("dead");

    writeFileSync(cuaFail, "");
    await send(later, requestText);
    await expect.poll(async () => {
      const current = await bot();
      return { activity: current?.activity, failed: current?.tasks.find((task) => task.threadId === mainThreadId)?.activity };
    }, { timeout: 15_000 }).toEqual({ activity: "idle", failed: "idle" });
    expect((await messages(later)).some((message) => message.kind === "text" && message.text === "Signed in again.")).toBe(true);
  } finally {
    await fixture?.close();
    rmSync(script, { recursive: true, force: true });
  }
}, hostTimeout(60_000));
