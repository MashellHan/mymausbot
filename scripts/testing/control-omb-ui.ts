// `control-omb ui`: drives the real renderer headlessly against the fake-engine
// fixture through the agent-browser binary the harness pins. It touches
// control-omb.ts's bindings only inside functions, so the import cycle is
// harmless whichever loads first.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  ControlOmbError,
  HELP_UI,
  launchVerificationServer,
  parse,
  runControlOmb,
  type VerificationServer,
} from "../control-omb.ts";
import {
  closeBrowserSession,
  ensureChrome,
  installAgentBrowserBinary,
  resolveAgentBrowserBinary,
} from "../../server/browser-engine.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./preview-fixture.ts";
import { credentialStoreFlags } from "../../server/browser/egress/gate.ts";
import { CdpBrowser } from "../../server/browser/cdp/browser.ts";
import { webSocketTransport } from "../../server/browser/cdp/transport.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** Gitignored, persistent: the binary and its Chrome download once per checkout. */
export const UI_TOOLS_DIR = join(ROOT, ".omb-scratch", "verify-tools");
/** Verbs that change the fixture or the page; they take the explicit handle, never discovery. */
export const UI_MUTATING = new Set(["click", "type", "press", "flag", "eval"]);
export const ENABLE_ADVANCED_UI = `(async () => {
  const { setAdvancedMode } = await import("/src/lib/interface-mode.ts");
  setAdvancedMode(true);
  return true;
})()`;
/** The sidebar's Tools section starts open, and a click on its header closes it. */
export const OPEN_SIDEBAR_TOOLS = "(() => { document.querySelector('[data-tour=tools] button[aria-expanded=false]')?.click(); return true; })()";

const ENTRIES = {
  threads: { entry: "/scripts/testing/threads-preview.tsx", route: "/__threads.html", title: "Isolated OpenMaus Chat" },
  dictation: { entry: "/scripts/testing/dictation-preview.tsx", route: "/__dictation.html", title: "Isolated dictation verification" },
  settings: { entry: "/src/testing/bot-settings.tsx", route: "/__bot-settings.html", title: "Isolated Bot Settings" },
} as const satisfies Record<string, Parameters<typeof mountPreview>[1]>;
const FAKE_MODES = ["happy", "exit-early", "hang", "malformed", "stream", "not-logged-in", "slow", "slow-write", "background-result"];
const SEEDED_BOT = "Pepper";
const PLATFORM_ENV = ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"];
// Where `agent-browser install` unpacks Chrome for Testing below `$HOME/.agent-browser/browsers/chrome-<version>/`.
const CHROME_LAYOUTS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: [
    "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ],
  linux: ["chrome", "chrome-linux64/chrome"],
  win32: ["chrome.exe", "chrome-win64/chrome.exe"],
};
const OUTPUT_LIMIT = 16 * 1024 * 1024;

export interface UiHandle {
  url: string;
  previewUrl: string;
  session: string;
  binary: string;
  home: string;
  botId: string;
  logPath: string;
  /** Chrome the session launched with; null when agent-browser located a browser itself. */
  chrome: string | null;
  /** Loopback DevTools port of the Chrome owned by this fixture. */
  cdpPort?: number;
}

type SessionEnv = Pick<UiHandle, "home" | "session" | "chrome" | "cdpPort">;

const CHROME_PROFILE = "chrome-profile";

function fixtureDevTools(profile: string): { port: number; path: string } | undefined {
  try {
    const [rawPort, path] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n");
    const port = Number(rawPort);
    if (Number.isInteger(port) && port > 0 && port <= 65535 && /^\/devtools\/browser\/[a-f0-9-]+$/i.test(path ?? "")) {
      return { port, path: path! };
    }
  } catch {}
}

/** The exact environment `open` launched with. Later verbs must repeat it:
 * agent-browser relaunches the browser (losing the page) when launch
 * settings drift, and the daemon socket lives under this HOME. */
export function sessionEnv(handle: SessionEnv, parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const temp = join(handle.home, "tmp");
  const env: NodeJS.ProcessEnv = {
    HOME: handle.home,
    USERPROFILE: handle.home,
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    PATH: parentEnv.PATH ?? "",
    AGENT_BROWSER_SESSION: handle.session,
    AGENT_BROWSER_NO_WEBMCP: "1",
  };
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value && PLATFORM_ENV.includes(key.toUpperCase())) env[key.toUpperCase()] = value;
  }
  if (handle.cdpPort !== undefined) env.AGENT_BROWSER_CDP = String(handle.cdpPort);
  else {
    env.AGENT_BROWSER_HEADLESS = "1";
    env.AGENT_BROWSER_ARGS = credentialStoreFlags().join("\n");
    if (handle.chrome) env.AGENT_BROWSER_EXECUTABLE_PATH = handle.chrome;
  }
  return env;
}

/** Run one agent-browser verb with --json and return its `data`. The binary's
 * stderr is never surfaced: it can echo paths and environment. */
export function agentBrowser(
  binary: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  return new Promise((done, fail) => {
    let child: ChildProcess;
    try {
      const { AGENT_BROWSER_CDP: cdp, ...childEnv } = env;
      const attach = cdp && /^\d{1,5}$/.test(cdp) && Number(cdp) > 0 && Number(cdp) <= 65535 ? ["--cdp", cdp] : [];
      child = spawn(binary, [...attach, ...args, "--json"], {
        env: attach.length ? childEnv : env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
      });
    } catch (error) {
      fail(new ControlOmbError(`could not start agent-browser: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    let output = "";
    let settled = false;
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
    };
    const reject = (error: ControlOmbError) => {
      if (settled) return;
      cleanup();
      fail(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ControlOmbError(`agent-browser ${args[0]} did not finish within ${timeoutMs}ms`, "check the page with `ui screenshot` or `ui console`"));
    }, timeoutMs);
    timer.unref?.();
    const readResult = (code: number | null, closed: boolean) => {
      if (settled) return;
      let result: { success?: unknown; data?: unknown; error?: unknown } | null = null;
      try { result = JSON.parse(output); } catch { /* not JSON: reported below */ }
      const data = result?.data;
      if (code === 0 && result?.success === true && data && typeof data === "object" && !Array.isArray(data)) {
        cleanup();
        done(data as Record<string, unknown>);
        return;
      }
      if (!closed) return;
      const reason = typeof result?.error === "string" ? result.error
        : result?.error && typeof result.error === "object" && typeof (result.error as { message?: unknown }).message === "string"
          ? (result.error as { message: string }).message
          : `exit ${code ?? "by signal"}`;
      reject(new ControlOmbError(`agent-browser ${args[0]} failed: ${reason.slice(0, 300)}`, "take a fresh `ui snapshot`; refs change after the page updates"));
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      output += String(chunk);
      if (output.length > OUTPUT_LIMIT) {
        child.kill("SIGKILL");
        reject(new ControlOmbError(`agent-browser ${args[0]} exceeded its output limit`));
      } else if (child.exitCode === 0) readResult(0, false);
    });
    child.on("error", (error) => reject(new ControlOmbError(`could not start agent-browser: ${error.message}`)));
    // Node's close event can outlive the CLI when its daemon inherits stdout.
    child.on("exit", (code) => { if (code === 0) readResult(code, false); });
    child.on("close", (code) => readResult(code, true));
  });
}

/** Chrome for Testing that `agent-browser install` unpacked under the tools
 * directory, newest version first; null when it found a system browser instead. */
export function installedChrome(toolsDir = UI_TOOLS_DIR, platform: NodeJS.Platform = process.platform): string | null {
  const browsers = join(toolsDir, ".agent-browser", "browsers");
  let versions: string[];
  try {
    versions = readdirSync(browsers)
      .filter((name) => name.startsWith("chrome-"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return null;
  }
  for (const version of versions) {
    for (const layout of CHROME_LAYOUTS[platform] ?? []) {
      const candidate = join(browsers, version, layout);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** OMB_AGENT_BROWSER_PATH, then the tools directory, then PATH; otherwise the
 * pinned download, verified by size and SHA-256. Chrome follows the same rule
 * with AGENT_BROWSER_EXECUTABLE_PATH. Both land once under UI_TOOLS_DIR. */
export async function ensureUiBrowser(
  parentEnv: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = () => {},
  toolsDir = UI_TOOLS_DIR,
): Promise<{ binary: string; chrome: string | null }> {
  mkdirSync(toolsDir, { recursive: true, mode: 0o700 });
  let binary = resolveAgentBrowserBinary({ dataDir: toolsDir, env: parentEnv });
  if (!binary) {
    const started = Date.now();
    binary = await installAgentBrowserBinary({ dataDir: toolsDir, log });
    log(`agent-browser installed at ${binary} in ${Date.now() - started}ms`);
  }
  const explicit = parentEnv.AGENT_BROWSER_EXECUTABLE_PATH?.trim();
  if (explicit) {
    if (!existsSync(explicit)) throw new ControlOmbError(`AGENT_BROWSER_EXECUTABLE_PATH does not exist: ${explicit}`, "unset it to use the Chrome agent-browser installs");
    return { binary, chrome: resolve(explicit) };
  }
  let chrome = installedChrome(toolsDir);
  if (!chrome) {
    const started = Date.now();
    await ensureChrome(binary, { env: sessionEnv({ home: toolsDir, session: "omb-ui-install", chrome: null }, parentEnv), log });
    log(`Chrome ready in ${Date.now() - started}ms`);
    chrome = installedChrome(toolsDir);
    if (!chrome) log("no Chrome for Testing under the tools directory; the session will use the browser agent-browser finds itself");
  }
  return { binary, chrome };
}

function loadHandle(raw: unknown, verb: string): UiHandle {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ControlOmbError(`ui ${verb} requires --ui HANDLE`, "run `ui launch`; it prints the handle path (ui.json inside its data directory)");
  }
  const path = resolve(raw.trim());
  let handle: Partial<UiHandle>;
  try {
    handle = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ControlOmbError(`could not read the ui handle ${path}: ${error instanceof Error ? error.message : String(error)}`, "the launch that wrote it may have stopped; run `ui launch` again");
  }
  for (const key of ["url", "previewUrl", "session", "binary", "home", "botId", "logPath"] as const) {
    if (typeof handle[key] !== "string" || !handle[key]) throw new ControlOmbError(`the ui handle ${path} lacks ${key}`, "run `ui launch` again and use the handle it prints");
  }
  if (handle.chrome !== null && typeof handle.chrome !== "string") throw new ControlOmbError(`the ui handle ${path} has an invalid chrome entry`);
  if (!existsSync(handle.home!)) throw new ControlOmbError(`the ui session's data directory is gone: ${handle.home}`, "its launch was stopped; run `ui launch` again");
  if (handle.cdpPort !== undefined && fixtureDevTools(join(handle.home!, CHROME_PROFILE))?.port !== handle.cdpPort) {
    throw new ControlOmbError("the ui session's owned Chrome endpoint is no longer available", "run `ui launch` again");
  }
  return handle as UiHandle;
}

/** A verb on a dead daemon would launch a fresh blank browser and drive that. */
async function requireLiveSession(handle: UiHandle): Promise<void> {
  const data = await agentBrowser(handle.binary, sessionEnv(handle), ["session", "list"], 10_000);
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  if (!sessions.includes(handle.session)) {
    throw new ControlOmbError(`the ui session ${handle.session} is not running`, "its launch was stopped or crashed; run `ui launch` again and use the new handle");
  }
}

async function snapshot(handle: UiHandle, interactive: boolean): Promise<Record<string, unknown>> {
  return agentBrowser(handle.binary, sessionEnv(handle), ["snapshot", ...(interactive ? ["-i"] : [])]);
}

const TARGET_WAIT_MS = 5_000;

/** `--ref @eN` verbatim, or the one element whose accessible name is `--name`. */
async function resolveTarget(handle: UiHandle, values: Record<string, unknown>, verb: string): Promise<{ target: string; name?: string; role?: string }> {
  const ref = typeof values.ref === "string" ? values.ref.trim() : "";
  const name = typeof values.name === "string" ? values.name : "";
  if (Boolean(ref) === Boolean(name)) throw new ControlOmbError(`ui ${verb} needs exactly one of --ref @eN or --name NAME`);
  if (ref) {
    if (!/^@?e\d+$/.test(ref)) throw new ControlOmbError(`--ref must look like @e12, got ${JSON.stringify(ref)}`, "refs come from `ui snapshot`");
    return { target: ref.startsWith("@") ? ref : `@${ref}` };
  }
  // React paints after the previous command returns, so one snapshot races the
  // UI: wait for the name. Two matches are still reported the moment seen.
  const deadline = Date.now() + TARGET_WAIT_MS;
  let matches: Array<[string, { name?: unknown; role?: unknown }]> = [];
  for (;;) {
    const refs = (await snapshot(handle, false)).refs as Record<string, { name?: unknown; role?: unknown }> | undefined;
    matches = Object.entries(refs ?? {}).filter(([, element]) => element?.name === name);
    if (matches.length === 1) {
      const [id, element] = matches[0]!;
      return { target: `@${id}`, name, ...(typeof element.role === "string" ? { role: element.role } : {}) };
    }
    if (matches.length > 1 || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (matches.length === 0) throw new ControlOmbError(`no element is named ${JSON.stringify(name)}`, "run `ui snapshot` and use the exact accessible name, or --ref");
  throw new ControlOmbError(
    `${matches.length} elements are named ${JSON.stringify(name)}: ${matches.map(([id, element]) => `@${id} (${String(element.role)})`).join(", ")}`,
    "pass --ref to pick one",
  );
}

function parseFlagPatch(raw: unknown): { features: Record<string, boolean | number | string> } {
  const assignments = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
  if (!assignments.length) throw new ControlOmbError("ui flag requires --set features.NAME=VALUE", "example: --set features.showToolCalls=true");
  const features: Record<string, boolean | number | string> = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    const path = separator === -1 ? assignment : assignment.slice(0, separator);
    const value = separator === -1 ? "" : assignment.slice(separator + 1);
    const [scope, name, ...rest] = path.split(".");
    if (scope !== "features" || !name || rest.length || !/^[A-Za-z][\w-]*$/.test(name) || separator === -1) {
      throw new ControlOmbError(`--set must be features.NAME=VALUE, got ${JSON.stringify(assignment)}`, "example: --set features.showToolCalls=true");
    }
    features[name] = value === "true" ? true : value === "false" ? false : /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return { features };
}

const summarizeBots = (bots: Array<Record<string, unknown>>) =>
  bots.map((bot) => ({ id: bot.id, name: bot.name, busy: bot.busy === true,
    waitingForTeammates: bot.waitingForTeammates === true, activity: bot.activity ?? null }));

/** Settled means three things at once: the seeded bot's turn ended (the shared
 * wait tool decides how), no bot in the fixture is still busy, and the page
 * shows the newest message the server has and reports network idle. */
async function waitSettle(handle: UiHandle, timeoutSeconds: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  const remaining = () => Math.max(1, Math.ceil((deadline - Date.now()) / 1_000));
  const api = fixtureApi(handle.url);
  let wait: Record<string, unknown> | undefined;
  let bots: ReturnType<typeof summarizeBots> = [];
  let renderer: Record<string, unknown> = { rendered: false };
  let browser: Record<string, unknown> = { state: "unknown" };
  const state = () => ({ status: "timed-out", bots, renderer, browser, wait });
  for (;;) {
    wait = await runControlOmb(["wait", "--bot", handle.botId, "--timeout", String(Math.min(120, remaining())), "--url", handle.url]) as Record<string, unknown>;
    if (wait.status !== "settled") return { ok: false, ...state(), status: wait.status };
    bots = summarizeBots(((await api("GET", "/api/bots?messages=0")) as { bots: Array<Record<string, unknown>> }).bots);
    if (!bots.some((bot) => bot.busy || bot.waitingForTeammates)) break;
    if (Date.now() >= deadline) return { ok: false, ...state() };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // The transcript rows carry data-mid; the newest text row proves the
  // renderer caught up with the server before a snapshot reads it.
  const messages = Array.isArray(wait.messages) ? wait.messages as Array<{ id?: unknown; kind?: unknown }> : [];
  const newest = [...messages].reverse().find((message) => message.kind === "text" && typeof message.id === "string");
  const env = sessionEnv(handle);
  try {
    if (newest) {
      await agentBrowser(handle.binary, env, ["wait", "--fn", `!!document.querySelector(${JSON.stringify(`[data-mid=${JSON.stringify(newest.id)}]`)})`], Math.max(1_000, deadline - Date.now()));
      renderer = { rendered: true, lastMessageId: newest.id };
    } else {
      renderer = { rendered: true, lastMessageId: null };
    }
    const idle = await agentBrowser(handle.binary, env, ["wait", "--load", "networkidle"], Math.max(1_000, deadline - Date.now()));
    browser = { state: idle.state ?? "networkidle" };
  } catch (error) {
    return { ok: false, ...state(), error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, status: "settled", bots, renderer, browser, wait };
}

/** The `ui` verbs other than launch. Every one takes the explicit handle. */
export async function runControlOmbUi(args: string[]): Promise<unknown> {
  const [verb = "help", ...rest] = args;
  if (verb === "help" || verb === "--help" || verb === "-h") return HELP_UI;
  if (verb === "launch") {
    throw new ControlOmbError("ui launch is available only from the executable CLI", "run `node --experimental-strip-types scripts/control-omb.ts ui launch`");
  }
  const command = `ui ${verb}`;
  const ui = { ui: { type: "string" } } as const;

  if (verb === "snapshot") {
    const values = parse(command, rest, { ...ui, interactive: { type: "boolean", default: false } });
    const handle = loadHandle(values.ui, verb);
    await requireLiveSession(handle);
    return { ok: true, ...(await snapshot(handle, values.interactive === true)) };
  }

  if (verb === "click" || verb === "type") {
    const values = parse(command, rest, { ...ui, ref: { type: "string" }, name: { type: "string" }, text: { type: "string" } });
    const handle = loadHandle(values.ui, verb);
    const text = verb === "type" ? values.text : undefined;
    if (verb === "type" && typeof text !== "string") throw new ControlOmbError("ui type requires --text TEXT");
    await requireLiveSession(handle);
    const { target, name, role } = await resolveTarget(handle, values, verb);
    const namedButton = verb === "click" && name && role === "button";
    const args = namedButton ? ["find", "role", "button", "click", "--name", name, "--exact"]
      : verb === "click" ? ["click", target] : ["type", target, text as string];
    const data = await agentBrowser(handle.binary, sessionEnv(handle), args);
    return { ok: true, target: namedButton ? "role=button" : target, ...(name ? { name } : {}), ...(role ? { referenceRole: role } : {}), ...data };
  }

  if (verb === "press") {
    const values = parse(command, rest, { ...ui, keys: { type: "string" } });
    const handle = loadHandle(values.ui, verb);
    if (typeof values.keys !== "string" || !values.keys.trim()) throw new ControlOmbError("ui press requires --keys KEYS", "example: --keys Enter or --keys Meta+k");
    await requireLiveSession(handle);
    return { ok: true, ...(await agentBrowser(handle.binary, sessionEnv(handle), ["press", values.keys.trim()])) };
  }

  if (verb === "screenshot") {
    const values = parse(command, rest, { ...ui, out: { type: "string" } });
    const handle = loadHandle(values.ui, verb);
    if (typeof values.out !== "string" || extname(values.out).toLowerCase() !== ".png") throw new ControlOmbError("ui screenshot requires --out PATH.png");
    const out = resolve(values.out);
    mkdirSync(dirname(out), { recursive: true });
    await requireLiveSession(handle);
    await agentBrowser(handle.binary, sessionEnv(handle), ["screenshot", out], 60_000);
    let bytes = 0;
    try { bytes = statSync(out).size; } catch { /* reported as 0 */ }
    if (!bytes) throw new ControlOmbError(`agent-browser reported a screenshot it did not write: ${out}`);
    return { ok: true, path: out, bytes };
  }

  if (verb === "console") {
    const values = parse(command, rest, ui);
    const handle = loadHandle(values.ui, verb);
    await requireLiveSession(handle);
    return { ok: true, ...(await agentBrowser(handle.binary, sessionEnv(handle), ["console"])) };
  }

  if (verb === "eval") {
    const values = parse(command, rest, { ...ui, js: { type: "string" } });
    const handle = loadHandle(values.ui, verb);
    if (typeof values.js !== "string" || !values.js.trim()) throw new ControlOmbError("ui eval requires --js CODE");
    await requireLiveSession(handle);
    return { ok: true, ...(await agentBrowser(handle.binary, sessionEnv(handle), ["eval", values.js])) };
  }

  if (verb === "flag") {
    const values = parse(command, rest, { ...ui, set: { type: "string", multiple: true }, "dry-run": { type: "boolean", default: false } });
    const handle = loadHandle(values.ui, verb);
    const patch = parseFlagPatch(values.set);
    if (values["dry-run"] === true) return { ok: true, dryRun: true, url: handle.url, method: "PATCH", path: "/api/config", patch };
    const config = await fixtureApi(handle.url)("PATCH", "/api/config", patch) as Record<string, unknown>;
    return { ok: true, patch, features: config.features ?? null };
  }

  if (verb === "wait-settle") {
    const values = parse(command, rest, { ...ui, timeout: { type: "string" } });
    const handle = loadHandle(values.ui, verb);
    const timeout = values.timeout === undefined ? 30 : Number(values.timeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) throw new ControlOmbError("--timeout must be an integer from 1 to 600");
    await requireLiveSession(handle);
    return waitSettle(handle, timeout);
  }

  throw new ControlOmbError(`unknown ui command ${JSON.stringify(verb)}`, "run control-omb ui help");
}

function parkUntilSignalOrExit(child: ChildProcess, stopRequested: () => boolean): Promise<"signal" | "exit"> {
  return new Promise((settle) => {
    if (stopRequested()) { settle("signal"); return; }
    const finish = (reason: "signal" | "exit") => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      child.off("close", onExit);
      settle(reason);
    };
    const onSignal = () => finish("signal");
    const onExit = () => finish("exit");
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    child.once("close", onExit);
  });
}

type UiLaunchPhase = "browser-ensure" | "browser-ready" | "fixture-start" | "fixture-ready"
  | "fixture-configured" | "preview-start" | "preview-ready" | "browser-open-start" | "chrome-start" | "chrome-ready"
  | "browser-cdp-ready" | "preview-mounted" | "browser-opened";

const CANARY_TITLE = "Isolated Chrome ready";

async function launchLoopbackChrome(executable: string, home: string, env: NodeJS.ProcessEnv, deadline: number, signal: AbortSignal) {
  const proxy = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/fixture-canary") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>${CANARY_TITLE}</title>`);
    } else {
      res.writeHead(403);
      res.end();
    }
  });
  proxy.on("clientError", (_error, socket) => socket.destroy());
  proxy.on("connect", (_req, socket) => {
    socket.on("error", () => socket.destroy());
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  let child: ChildProcess | undefined;
  const close = async () => {
    try { if (child?.pid) await waitForExit(child, { signal: "SIGTERM", graceMs: 3_000 }); }
    finally {
      const closed = new Promise<void>((done) => proxy.close(() => done()));
      proxy.closeAllConnections();
      await closed;
    }
  };
  try {
    const listening = once(proxy, "listening");
    proxy.listen(0, "127.0.0.1");
    await listening;
    const address = proxy.address();
    if (!address || typeof address === "string") throw new ControlOmbError("the fixture deny proxy did not report a loopback port");
    signal.throwIfAborted();
    const profile = join(home, CHROME_PROFILE);
    mkdirSync(profile, { mode: 0o700 });
    child = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check", ...credentialStoreFlags(),
      "--disable-background-networking", "--disable-component-update", "--disable-sync", `--proxy-server=http://127.0.0.1:${address.port}`,
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { env, stdio: "ignore" });
    let failed = false;
    child.once("error", () => { failed = true; });
    while (Date.now() < deadline && !failed && child.exitCode === null && child.signalCode === null) {
      signal.throwIfAborted();
      const endpoint = fixtureDevTools(profile);
      if (endpoint) return { ...endpoint, canaryUrl: `http://127.0.0.1:${address.port}/fixture-canary`, close };
      await delay(50, undefined, { signal });
    }
    throw new ControlOmbError("the fixture Chrome did not open its loopback DevTools port");
  } catch (error) {
    await close();
    throw error;
  }
}

async function openLoopbackPreview(binary: string, env: NodeJS.ProcessEnv, chrome: Awaited<ReturnType<typeof launchLoopbackChrome>>,
  url: URL, deadline: number, phase: (name: UiLaunchPhase) => void): Promise<void> {
  const remaining = () => Math.max(1, deadline - Date.now());
  const canary = await agentBrowser(binary, env, ["open", chrome.canaryUrl], remaining());
  if (canary.title !== CANARY_TITLE) throw new ControlOmbError("the fixture driver did not read the loopback canary");
  phase("browser-cdp-ready");
  const transport = await webSocketTransport(`ws://127.0.0.1:${chrome.port}${chrome.path}`, { timeoutMs: remaining() });
  const deadlineTimer = setTimeout(() => transport.close(), remaining());
  try {
    const browser = await CdpBrowser.connect(transport, { viewport: null, permissions: false, timeoutMs: remaining() });
    const page = await browser.waitForPage((candidate) => candidate.url() === chrome.canaryUrl, remaining());
    await page.navigate(url.href, { readiness: "domcontentloaded", timeoutMs: remaining() });
    await page.waitFor({ target: { selector: "#root > *" }, urlIncludes: url.href, timeoutMs: remaining() });
  } finally {
    clearTimeout(deadlineTimer);
    transport.close();
  }
  const checked = await agentBrowser(binary, env, ["eval", `location.href === ${JSON.stringify(url.href)} && Boolean(document.querySelector('#root > *'))`], remaining());
  if (checked.result !== true) throw new ControlOmbError("the mounted preview is not on the owned browser session");
  phase("preview-mounted");
}

/** `ui launch`: fixture, preview, seeded bot, browser session, handle file;
 * park until interrupted, then close the browser, the preview and the
 * fixture in that order. Only ever runs from the executable CLI. */
export async function launchUi(
  args: string[],
  parentEnv: NodeJS.ProcessEnv = process.env,
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } = process,
  fixtureOptions: { boatFixtureApi?: string; onPhase?: (phase: UiLaunchPhase) => void } = {},
): Promise<void> {
  const values = parse("ui launch", args, { entry: { type: "string" }, "tool-calls": { type: "string" }, mode: { type: "string" }, engine: { type: "string" }, simple: { type: "boolean", default: false } });
  const extraEngines: Record<string, "codex" | "customAcp" | "cline" | "copilot" | "opencode"> = { codex: "codex", acp: "customAcp", cline: "cline", copilot: "copilot", opencode: "opencode" };
  if (values.engine !== undefined && !Object.hasOwn(extraEngines, String(values.engine))) {
    throw new ControlOmbError(`unknown --engine ${JSON.stringify(values.engine)}`, "the fake Claude CLI always runs; --engine codex adds the fake Codex app-server beside it, --engine acp, cline or copilot a fake ACP agent, --engine opencode the OpenCode at OMB_VERIFY_OPENCODE_CLI");
  }
  const entryName = typeof values.entry === "string" ? values.entry : "threads";
  if (!Object.hasOwn(ENTRIES, entryName)) {
    throw new ControlOmbError(`unknown --entry ${JSON.stringify(entryName)}`, `available entries: ${Object.keys(ENTRIES).join(", ")}`);
  }
  if (values.simple === true && entryName !== "threads") throw new ControlOmbError("--simple requires the threads preview");
  const entry = ENTRIES[entryName as keyof typeof ENTRIES];
  const fakeEnv: NodeJS.ProcessEnv = {};
  if (values["tool-calls"] !== undefined) {
    let calls: unknown;
    try { calls = JSON.parse(String(values["tool-calls"])); } catch { calls = undefined; }
    if (!Array.isArray(calls) || !calls.every((call) => call && typeof call === "object" && typeof (call as { name?: unknown }).name === "string")) {
      throw new ControlOmbError("--tool-calls must be a JSON array of {name, input?, ok?}", 'example: --tool-calls \'[{"name":"Bash","input":{"command":"echo hi"},"ok":true}]\'');
    }
    fakeEnv.FAKE_CLAUDE_TOOL_CALLS = JSON.stringify(calls);
  }
  if (values.mode !== undefined) {
    if (!FAKE_MODES.includes(String(values.mode))) throw new ControlOmbError(`unknown --mode ${JSON.stringify(values.mode)}`, `fake engine modes: ${FAKE_MODES.join(", ")}`);
    fakeEnv.FAKE_CLAUDE_MODE = String(values.mode);
  }
  const note = (line: string) => io.stderr.write(`ui launch: ${line}\n`);
  const phase = (name: UiLaunchPhase) => {
    try { fixtureOptions.onPhase?.(name); } catch {}
  };

  // A Ctrl-C at any point after this stops the launch at its next step and
  // still runs the cleanup below for whatever already started.
  let stopRequested = false;
  const startup = new AbortController();
  const requestStop = () => { stopRequested = true; startup.abort(); };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  const checkpoint = () => { if (stopRequested) throw new ControlOmbError("ui launch cancelled"); };

  let fixture: VerificationServer | undefined;
  let preview: MountedPreview | undefined;
  let opened: { binary: string; env: NodeJS.ProcessEnv } | undefined;
  let ownedChrome: Awaited<ReturnType<typeof launchLoopbackChrome>> | undefined;
  try {
    phase("browser-ensure");
    const { binary, chrome } = await ensureUiBrowser(parentEnv, note);
    checkpoint();
    phase("browser-ready");
    phase("fixture-start");
    fixture = await launchVerificationServer({ ...parentEnv, ...fakeEnv }, startup.signal, undefined,
      { binaryPath: binary, executablePath: chrome ?? "" }, undefined, undefined, values.engine === undefined ? [] : [extraEngines[String(values.engine)]!], fixtureOptions.boatFixtureApi);
    checkpoint();
    phase("fixture-ready");
    const api = fixtureApi(fixture.info.url);
    await api("PATCH", "/api/config", { language: "en" });
    const { bots } = await api("GET", "/api/bots") as { bots: Array<{ id: string; defaultBot?: object }> };
    for (const bot of bots.filter((bot) => bot.defaultBot)) await api("PATCH", `/api/bots/${bot.id}`, { welcomed: true });
    const created = await runControlOmb(["new-bot", "--name", SEEDED_BOT, "--url", fixture.info.url]) as { bot: { id: string } };
    checkpoint();
    phase("fixture-configured");
    // stdout carries the handle and nothing else; Vite's port and dependency
    // notes would otherwise land there first.
    phase("preview-start");
    preview = await mountPreview(fixture, { ...entry, logLevel: "warn" });
    checkpoint();
    phase("preview-ready");
    const previewUrl = new URL(preview.previewUrl);
    if (values.simple === true) previewUrl.searchParams.set("fixtureMode", "simple");
    const session: SessionEnv = { home: fixture.info.dataDir, session: `omb-ui-${new URL(fixture.info.url).port}`, chrome };
    const deadline = Date.now() + 120_000;
    if (process.platform === "darwin" && chrome) {
      phase("chrome-start");
      ownedChrome = await launchLoopbackChrome(chrome, session.home, sessionEnv(session, parentEnv), deadline, startup.signal);
      session.cdpPort = ownedChrome.port;
      phase("chrome-ready");
    }
    const env = sessionEnv(session, parentEnv);
    opened = { binary, env };
    phase("browser-open-start");
    if (ownedChrome) await openLoopbackPreview(binary, env, ownedChrome, previewUrl, deadline, phase);
    else await agentBrowser(binary, env, ["open", previewUrl.href], 120_000);
    checkpoint();
    phase("browser-opened");
    const handle: UiHandle = {
      url: fixture.info.url,
      previewUrl: previewUrl.href,
      session: session.session,
      binary,
      home: fixture.info.dataDir,
      botId: created.bot.id,
      logPath: fixture.info.logPath,
      chrome,
      ...(ownedChrome ? { cdpPort: ownedChrome.port } : {}),
    };
    const handlePath = join(fixture.info.dataDir, "ui.json");
    writeFileSync(handlePath, `${JSON.stringify(handle, null, 2)}\n`, { mode: 0o600 });
    io.stdout.write(`${JSON.stringify({
      ok: true, ui: handlePath, url: handle.url, previewUrl: handle.previewUrl, botId: handle.botId, dataDir: handle.home, logPath: handle.logPath,
    }, null, 2)}\n`);
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    const reason = await parkUntilSignalOrExit(fixture.child, () => stopRequested);
    if (reason === "exit") {
      process.exitCode = 1;
      io.stderr.write(`${JSON.stringify({ ok: false, error: `verification server exited unexpectedly; see ${fixture.info.logPath}` }, null, 2)}\n`);
    }
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    if (opened) {
      // closeBrowserSession waits until the daemon is really gone; a plain
      // `close` only acknowledges. Both are scoped to this fixture's HOME.
      if (!await closeBrowserSession(opened.binary, opened.env) && !ownedChrome) {
        await agentBrowser(opened.binary, opened.env, ["close"], 15_000).catch(() => {});
      }
    }
    try { await ownedChrome?.close(); }
    finally {
      try { await preview?.close(); }
      finally { await fixture?.close(); }
    }
  }
}
