import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const CHANNEL = "tailscale-funnel:status";
const DESCRIPTOR = "/.well-known/openmausbot/environment";
const unavailable = reason => ({ status: "unavailable", reason });

// Finder does not inherit a shell's PATH; the macOS executable also needs explicit CLI mode.
const candidates = () => [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  join(homedir(), "Applications/Tailscale.app/Contents/MacOS/Tailscale"),
  "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "/usr/bin/tailscale",
  "/run/current-system/sw/bin/tailscale",
  "C:\\Program Files\\Tailscale\\tailscale.exe", "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
  "tailscale",
];

function cliJson(cli, args, timeout) {
  return new Promise(resolve => {
    execFile(cli, args, {
      timeout, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, TAILSCALE_BE_CLI: "1", PATH: [process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter) },
    }, (error, stdout) => {
      // Tailscale errors can contain credentials and peer details; none cross IPC or enter logs.
      if (error) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

export function funnelOrigins(status, config, port) {
  if (status?.BackendState !== "Running" || !Number.isInteger(port) || port < 1 || port > 65535) return [];
  const dns = typeof status.Self?.DNSName === "string" ? status.Self.DNSName.replace(/\.$/, "").toLowerCase() : "";
  if (dns.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2}ts\.net$/.test(dns)) return [];
  const targets = ["127.0.0.1", "localhost", "[::1]"].flatMap(host => [`http://${host}:${port}`, `http://${host}:${port}/`]);
  return [443, 8443, 10000].flatMap(httpsPort => {
    const authority = `${dns}:${httpsPort}`;
    const handlers = config?.Web?.[authority]?.Handlers;
    // A longer mount could intercept /api/pair even when the root reaches our server.
    if (config?.AllowFunnel?.[authority] !== true || config?.TCP?.[httpsPort]?.HTTPS !== true
      || !handlers || Object.keys(handlers).length !== 1 || !targets.includes(handlers["/"]?.Proxy)) return [];
    return [`https://${dns}${httpsPort === 443 ? "" : `:${httpsPort}`}`];
  });
}

async function environmentId(origin, fetchImpl, deadline) {
  const timeout = Math.min(5000, deadline - Date.now());
  if (timeout <= 0) throw new Error("Probe timed out");
  const response = await fetchImpl(`${origin}${DESCRIPTOR}`, {
    redirect: "error", credentials: "omit", signal: AbortSignal.timeout(timeout), headers: { accept: "application/json" },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Descriptor unavailable");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16 * 1024) throw new Error("Descriptor too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const descriptor = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof descriptor?.environmentId !== "string" || !/^[a-f0-9-]{36}$/i.test(descriptor.environmentId)
    || descriptor?.capabilities?.remoteSessions !== true) throw new Error("Invalid descriptor");
  return descriptor.environmentId;
}

export async function discoverTailscaleFunnel({ port, run = cliJson, fetchImpl = fetch }) {
  const deadline = Date.now() + 10000;
  const cliDeadline = Date.now() + 5000;
  for (const cli of candidates()) {
    const left = cliDeadline - Date.now();
    if (left <= 0) break;
    const status = await run(cli, ["status", "--json"], left);
    if (!status) continue;
    if (status.BackendState !== "Running") return unavailable("not-running");
    const remaining = cliDeadline - Date.now();
    if (remaining <= 0) break;
    const config = await run(cli, ["serve", "status", "--json"], remaining);
    const origins = funnelOrigins(status, config, port);
    if (!origins.length) return unavailable("not-configured");
    let local;
    try { local = await environmentId(`http://127.0.0.1:${port}`, fetchImpl, deadline); }
    catch { return unavailable("unverified"); }
    for (const origin of origins) {
      try {
        if (await environmentId(origin, fetchImpl, deadline) === local) return { status: "ready", origin };
      } catch { }
    }
    return unavailable("unverified");
  }
  return unavailable("not-running");
}

export function installTailscaleFunnelIpc({ ipcMain, localOnly, port, allowed, discover = discoverTailscaleFunnel }) {
  ipcMain.handle(CHANNEL, localOnly(CHANNEL, async event => {
    if (!allowed()) return unavailable("blocked");
    const currentPort = port();
    const result = await discover({ port: currentPort });
    return localOnly(CHANNEL, () => allowed() && port() === currentPort ? result : unavailable("blocked"))(event);
  }));
}
