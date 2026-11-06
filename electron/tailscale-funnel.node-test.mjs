import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { discoverTailscaleFunnel, funnelOrigins, installTailscaleFunnelIpc } from "./tailscale-funnel.mjs";
import { managedRemoteAccessRefusal } from "./managed-desktop.mjs";

const require = createRequire(import.meta.url);
const local = require("./local-origin.cjs");
const DNS = "computer.tail123.ts.net";
const ORIGIN = `https://${DNS}`;
const PORT = 18799;
const ID = "11111111-2222-4333-8444-555555555555";
const status = { BackendState: "Running", Self: { DNSName: `${DNS}.` } };
const configuration = (httpsPort = 443, target = `http://127.0.0.1:${PORT}`) => ({
  TCP: { [httpsPort]: { HTTPS: true } },
  Web: { [`${DNS}:${httpsPort}`]: { Handlers: { "/": { Proxy: target } } } },
  AllowFunnel: { [`${DNS}:${httpsPort}`]: true },
});
const descriptor = (id = ID) => Response.json({ environmentId: id, capabilities: { remoteSessions: true } });

test("only this node's public HTTPS root proxy to the current harness is offered", () => {
  assert.deepEqual(funnelOrigins(status, configuration(), PORT), [ORIGIN]);
  assert.deepEqual(funnelOrigins(status, configuration(8443), PORT), [`${ORIGIN}:8443`]);
  for (const host of ["localhost", "[::1]"]) {
    assert.deepEqual(funnelOrigins(status, configuration(10000, `http://${host}:${PORT}/`), PORT), [`${ORIGIN}:10000`]);
  }
  for (const target of [
    "http://127.0.0.1:8810", `https://127.0.0.1:${PORT}`, `http://evil.test:${PORT}`,
    `http://127.0.0.1:${PORT}/api`, `http://127.0.0.1:${PORT}?token=secret`,
    `http://user:secret@127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT}#fragment`,
  ]) assert.deepEqual(funnelOrigins(status, configuration(443, target), PORT), [], target);
  for (const change of [
    c => { c.AllowFunnel[`${DNS}:443`] = false; },
    c => { c.AllowFunnel[`${DNS}:443`] = "true"; },
    c => { c.AllowFunnel = { "other.tail123.ts.net:443": true }; },
    c => { c.TCP[443] = { TCPForward: "127.0.0.1:8799" }; },
    c => { c.Web[`${DNS}:443`].Handlers["/api"] = { Proxy: "http://evil.test" }; },
    c => { c.Web[`${DNS}:443`].Handlers = { "/other": { Proxy: `http://127.0.0.1:${PORT}` } }; },
  ]) {
    const config = configuration(); change(config);
    assert.deepEqual(funnelOrigins(status, config, PORT), []);
  }
  for (const dns of ["other.tail123.ts.net", `${DNS}.evil.test`, "https://computer.tail123.ts.net", "a..ts.net", "a.ts.net"]) {
    assert.deepEqual(funnelOrigins({ ...status, Self: { DNSName: dns } }, configuration(), PORT), []);
  }
  assert.deepEqual(funnelOrigins({ ...status, BackendState: "Stopped" }, configuration(), PORT), []);
});

test("discovery only reads CLI state and credential-free matching descriptors", async () => {
  const commands = [], probes = [];
  const state = await discoverTailscaleFunnel({
    port: PORT,
    run: async (cli, args, timeout) => {
      commands.push({ cli, args, timeout });
      return args[0] === "status" ? status : configuration();
    },
    fetchImpl: async (url, options) => { probes.push({ url, options }); return descriptor(); },
  });
  assert.deepEqual(state, { status: "ready", origin: ORIGIN });
  assert.deepEqual(commands.map(c => c.args), [["status", "--json"], ["serve", "status", "--json"]]);
  assert.equal(commands[0].cli, "/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  assert.ok(commands.every(c => c.timeout > 0 && c.timeout <= 5000));
  assert.deepEqual(probes.map(p => p.url), [
    `http://127.0.0.1:${PORT}/.well-known/openmausbot/environment`, `${ORIGIN}/.well-known/openmausbot/environment`,
  ]);
  for (const { options } of probes) {
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.deepEqual(options.headers, { accept: "application/json" });
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test("missing CLI, stopped nodes, Serve-only and mismatched or oversized responses fail closed", async () => {
  assert.deepEqual(await discoverTailscaleFunnel({ port: PORT, run: async () => null }), { status: "unavailable", reason: "not-running" });
  assert.deepEqual(await discoverTailscaleFunnel({ port: PORT, run: async () => ({ BackendState: "NeedsLogin" }) }), { status: "unavailable", reason: "not-running" });
  const run = async (_cli, args) => args[0] === "status" ? status : configuration();
  for (const publicResponse of [
    () => descriptor("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
    () => new Response("x".repeat(16 * 1024 + 1)),
    () => new Response("<html>another service</html>"),
    () => new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
    () => Response.json({ environmentId: ID }),
    () => { throw new Error("transport failure including private details"); },
  ]) {
    const result = await discoverTailscaleFunnel({ port: PORT, run, fetchImpl: async url => url.startsWith("http:") ? descriptor() : publicResponse() });
    assert.deepEqual(result, { status: "unavailable", reason: "unverified" });
  }
  const config = configuration(); config.AllowFunnel = {};
  assert.deepEqual(await discoverTailscaleFunnel({ port: PORT, run: async (_cli, args) => args[0] === "status" ? status : config,
    fetchImpl: () => { assert.fail("Serve-only must not be probed as public"); } }), { status: "unavailable", reason: "not-configured" });
});

const from = url => ({ senderFrame: { url }, sender: { getURL: () => url } });
test("IPC requires the local page, current server and remote-access policy before and after discovery", async () => {
  assert.equal(managedRemoteAccessRefusal(undefined), null);
  assert.equal(managedRemoteAccessRefusal({ remoteAccess: true }), null);
  assert.equal(managedRemoteAccessRefusal({ remoteAccess: false, organizationName: "Fixture company" }), "Fixture company does not allow remote access to this computer.");
  const handlers = new Map(); let allowed = true, port = PORT, calls = 0;
  let resolve;
  installTailscaleFunnelIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, localOnly: local.localOnly,
    port: () => port, allowed: () => allowed, discover: async () => { calls++; return new Promise(done => { resolve = done; }); } });
  const handler = handlers.get("tailscale-funnel:status");
  local.setLocalOrigin(`http://127.0.0.1:${PORT}`);
  const event = from(`http://127.0.0.1:${PORT}/`);
  assert.throws(() => handler(from(ORIGIN)), /only available/);
  assert.equal(calls, 0);
  allowed = false;
  assert.deepEqual(await handler(event), { status: "unavailable", reason: "blocked" });
  assert.equal(calls, 0);
  allowed = true;
  const switched = handler(event);
  port++;
  resolve({ status: "ready", origin: ORIGIN });
  assert.deepEqual(await switched, { status: "unavailable", reason: "blocked" });
  port = PORT;
  const changedPolicy = handler(event);
  allowed = false;
  resolve({ status: "ready", origin: ORIGIN });
  assert.deepEqual(await changedPolicy, { status: "unavailable", reason: "blocked" });
  allowed = true;
  const navigated = handler(event);
  event.senderFrame.url = ORIGIN;
  resolve({ status: "ready", origin: ORIGIN });
  await assert.rejects(navigated, /only available/);
});

test("preload exposes only a fixed read-only method on the local page", async () => {
  const source = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
  for (const origin of [`http://127.0.0.1:${PORT}`, ORIGIN]) {
    let bridge; const invoked = [];
    vm.runInNewContext(source, {
      process: { platform: "darwin", argv: [`--omb-local-origin=http://127.0.0.1:${PORT}`] }, location: { origin }, navigator: {}, TextEncoder,
      localStorage: { getItem: () => null }, require: () => ({ webUtils: {},
        contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
        ipcRenderer: { on() {}, removeListener() {}, send() {}, invoke: (...args) => { invoked.push(args); return Promise.resolve(null); } },
      }),
    });
    if (origin === ORIGIN) assert.equal(bridge.tailscaleFunnel, undefined);
    else {
      await bridge.tailscaleFunnel.status("https://evil.test", { token: "secret" });
      assert.deepEqual(invoked, [["tailscale-funnel:status"]]);
    }
  }
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /installTailscaleFunnelIpc\(\{ ipcMain, localOnly, port: \(\) => SERVER_PORT, allowed: \(\) => !desktopRemoteAccess && !managedRemoteAccessRefusal\(\) \}\)/);
});
