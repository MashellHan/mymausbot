// Real-browser PWA remote pairing, messaging, reload persistence, and IDB-fallback E2E.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startBridge, type BridgeServer } from "../../pwa-relay/src/bridge.ts";
import { loadConfig as loadRelayConfig } from "../../pwa-relay/src/config.ts";
import { credentialStoreFlags } from "../../server/browser/egress/gate.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../control-omb.ts";
import { ensureUiBrowser } from "./control-omb-ui.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const enabled = process.env.OMB_UI_E2E === "1";
const build = process.env.OMB_WEB_APP_BUILD || join(root, "dist");
if (!enabled) console.log("skipping remote PWA browser E2E: build the UI and set OMB_UI_E2E=1");

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
};

async function startStaticSpaServer(distDir: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const indexHtml = readFileSync(join(distDir, "index.html"));
  const resolvedDist = resolve(distDir);
  const server: Server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const relPath = decodeURIComponent(reqUrl.pathname).replace(/^\/+/, "");
    const candidate = resolve(resolvedDist, normalize(relPath));
    const withinDist = candidate === resolvedDist || candidate.startsWith(`${resolvedDist}/`);
    if (withinDist && relPath && existsSync(candidate) && statSync(candidate).isFile()) {
      const mime = MIME_TYPES[extname(candidate)] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": mime, "cache-control": "no-cache" });
      res.end(readFileSync(candidate));
      return;
    }
    // Mirror Cloudflare Pages SPA fallback: unknown routes (including pruned /assets/*) return 200 text/html.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(indexHtml);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Static SPA server failed to bind");
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

async function resolveBrowserBinary(): Promise<string> {
  const override = process.env.OMB_UI_BROWSER;
  if (override && existsSync(override)) return override;
  if (process.platform === "darwin") {
    const edge = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    if (existsSync(edge)) return edge;
  }
  const tools = await ensureUiBrowser();
  if (tools.chrome) return tools.chrome;
  throw new Error("No Chromium/Edge binary available for OMB_UI_E2E=1");
}

async function connectCdp(url: string) {
  const socket = new WebSocket(url);
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const events: string[] = [];
  const listeners = new Map<string, Set<(params: any, sessionId?: string) => void>>();
  let next = 0;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method) {
      events.push(message.method);
      if (events.length > 30) events.shift();
      for (const fn of listeners.get(message.method) ?? []) {
        fn(message.params, message.sessionId);
      }
      return;
    }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
  });

  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", () => resolveOpen(), { once: true });
    socket.addEventListener("error", () => rejectOpen(new Error("CDP WebSocket connection failed")), { once: true });
  });

  return {
    on(method: string, handler: (params: any, sessionId?: string) => void) {
      let set = listeners.get(method);
      if (!set) {
        set = new Set();
        listeners.set(method, set);
      }
      set.add(handler);
      return () => set!.delete(handler);
    },
    close() {
      for (const waiting of pending.values()) waiting.reject(new Error("CDP connection closed"));
      pending.clear();
      socket.close();
    },
    request(method: string, params: unknown = {}, sessionId?: string): Promise<any> {
      const id = ++next;
      return new Promise((resolveReq, rejectReq) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectReq(new Error(`CDP ${method} timed out: ${events.join(", ")}`));
        }, 30_000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolveReq(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            rejectReq(error);
          },
        });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
  };
}

describe("Remote PWA real-browser E2E via pwa-relay and Mac fixture", () => {
  (enabled ? it : it.skip)(
    "pairs via #pair=, persists IndexedDB auth across reload, streams reply, and survives blocked IndexedDB",
    async () => {
      if (!existsSync(join(build, "index.html"))) {
        throw new Error("Run pnpm build before OMB_UI_E2E=1 remote PWA browser qualification");
      }

      let spa: Awaited<ReturnType<typeof startStaticSpaServer>> | undefined;
      let fixture: VerificationServer | undefined;
      let relay: BridgeServer | undefined;
      let browser: ChildProcess | undefined;
      let cdp: Awaited<ReturnType<typeof connectCdp>> | undefined;

      try {
        spa = await startStaticSpaServer(build);
        fixture = await launchVerificationServer({ ...process.env, OMB_DEV_TRUST_LOCAL_BROWSER: "1" });
        const macBase = fixture.info.url;

        const rotRes = await fetch(`${macBase}/api/pwa-bridge/rotate-secret`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(rotRes.status).toBe(200);
        const { bridgeSecret } = (await rotRes.json()) as { bridgeSecret: string };

        relay = await startBridge(
          loadRelayConfig({
            BRIDGE_PORT: "0",
            BRIDGE_HOST: "127.0.0.1",
            PINNED_HOST_ID: "mac-mini",
            HOST_TOKEN_HASHES: createHash("sha256").update(bridgeSecret, "utf8").digest("hex"),
            PWA_ORIGIN: spa.origin,
          }),
          { log: () => {} },
        );
        const relayBase = `http://127.0.0.1:${relay.port}`;

        const putRes = await fetch(`${macBase}/api/pwa-bridge`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled: true,
            relayUrl: relayBase,
            hostId: "mac-mini",
            pwaOrigin: spa.origin,
          }),
        });
        expect(putRes.status).toBe(200);

        await expect.poll(() => relay!.hostConnected(), { timeout: 10_000 }).toBe(true);

        const { bot } = (await runControlOmb(["new-bot", "--name", "Accounting Bot", "--url", macBase])) as {
          bot: { id: string; activeTaskId: string };
        };

        const createInviteHash = async () => {
          const inviteRes = await fetch(`${macBase}/api/pwa-bridge/invite`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ label: "iPhone Edge E2E", defaultBotId: bot.id }),
          });
          expect(inviteRes.status).toBe(200);
          const { inviteUrl } = (await inviteRes.json()) as { inviteUrl: string };
          return `#${inviteUrl.split("#")[1]}`;
        };

        const browserBin = await resolveBrowserBinary();
        const profile = join(fixture.info.dataDir, "edge-pwa-profile");
        mkdirSync(profile, { recursive: true });
        browser = spawn(
          browserBin,
          [
            "--headless=new",
            "--no-sandbox",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--password-store=basic",
            ...credentialStoreFlags(),
            "--remote-debugging-port=0",
            `--user-data-dir=${profile}`,
            "about:blank",
          ],
          {
            env: {
              PATH: process.env.PATH,
              HOME: fixture.info.dataDir,
              USERPROFILE: fixture.info.dataDir,
              ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            },
            stdio: "ignore",
          },
        );

        const portFile = join(profile, "DevToolsActivePort");
        await expect.poll(() => existsSync(portFile), { timeout: 20_000 }).toBe(true);
        const [port, endpoint] = readFileSync(portFile, "utf8").trim().split("\n");
        cdp = await connectCdp(`ws://127.0.0.1:${port}${endpoint}`);

        const openIsolatedPage = async (initScript?: string) => {
          const { browserContextId } = (await cdp!.request("Target.createBrowserContext")) as { browserContextId: string };
          const { targetId } = (await cdp!.request("Target.createTarget", {
            url: "about:blank",
            browserContextId,
          })) as { targetId: string };
          const { sessionId } = (await cdp!.request("Target.attachToTarget", {
            targetId,
            flatten: true,
          })) as { sessionId: string };
          const exceptions: string[] = [];
          const offEx = cdp!.on("Runtime.exceptionThrown", (params, sid) => {
            if (sid !== sessionId) return;
            const detail = params?.exceptionDetails;
            exceptions.push(detail?.exception?.description || detail?.text || "Runtime.exceptionThrown");
          });
          const req = (method: string, params: unknown = {}) => cdp!.request(method, params, sessionId);
          const evalJs = async (expression: string) => {
            const value = await req("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
            if (value.exceptionDetails) {
              throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
            }
            return value.result.value;
          };
          await req("Page.enable");
          await req("Runtime.enable");
          if (initScript) {
            await req("Page.addScriptToEvaluateOnNewDocument", { source: initScript });
          }
          await req("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
          await req("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
          return {
            req,
            evalJs,
            exceptions,
            dispose: async () => {
              offEx();
              await cdp!.request("Target.disposeBrowserContext", { browserContextId }).catch(() => undefined);
            },
          };
        };

        // 1. Fresh pairing via #pair=, send message through pwa-relay, receive fake-engine reply, reload from IDB.
        const page1 = await openIsolatedPage();
        try {
          const hash1 = await createInviteHash();
          await page1.req("Page.navigate", { url: `${spa.origin}/${hash1}` });
          await expect
            .poll(() => page1.evalJs('document.querySelector(\'textarea[aria-label^="Message"]\') !== null'), {
              timeout: 25_000,
            })
            .toBe(true);

          const bootState = await page1.evalJs(`(async () => {
            const db = await new Promise((resolve, reject) => {
              const r = indexedDB.open("omb-pwa-v1", 3);
              r.onsuccess = () => resolve(r.result);
              r.onerror = () => reject(r.error);
            });
            const stored = await new Promise((resolve, reject) => {
              const tx = db.transaction("auth", "readonly");
              const g = tx.objectStore("auth").get("active");
              g.onsuccess = () => resolve(g.result);
              g.onerror = () => reject(g.error);
            });
            db.close();
            return {
              hash: location.hash,
              hasToken: Boolean(stored && stored.token),
              relayUrl: stored ? stored.relayUrl : null,
            };
          })()`);
          expect(bootState).toEqual({ hash: "", hasToken: true, relayUrl: relayBase });

          await page1.evalJs('document.querySelector(\'textarea[aria-label^="Message"]\').focus()');
          await page1.req("Input.insertText", { text: "Remote PWA E2E message" });
          await page1.req("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
          await page1.req("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });

          const settled = (await runControlOmb([
            "wait",
            "--bot",
            bot.id,
            "--task",
            bot.activeTaskId,
            "--timeout",
            "25",
            "--url",
            macBase,
          ])) as { status: string; messages?: Array<{ id?: string; role?: string; kind?: string; text?: string }> };
          expect(settled.status).toBe("settled");
          const botMsg = settled.messages?.find(
            (m) => m.role === "bot" && m.kind === "text" && typeof m.id === "string" && typeof m.text === "string" && m.text.trim().length > 0,
          );
          expect(botMsg).toBeDefined();

          await expect
            .poll(
              () =>
                page1.evalJs(
                  `document.body.innerText.includes("Remote PWA E2E message") && Boolean(document.querySelector(${JSON.stringify(`[data-mid=${JSON.stringify(botMsg!.id)}]`)}) || document.body.innerText.includes(${JSON.stringify(botMsg!.text!.trim().slice(0, 40))}))`,
                ),
              { timeout: 15_000 },
            )
            .toBe(true);
          expect(await page1.evalJs("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);

          // Reload without #pair= — must restore auth from real IndexedDB and render both user and bot messages without white screen.
          await page1.req("Page.reload");
          await expect
            .poll(
              () =>
                page1.evalJs(
                  `Boolean(document.querySelector('textarea[aria-label^="Message"]')) && document.body.innerText.includes("Remote PWA E2E message") && Boolean(document.querySelector(${JSON.stringify(`[data-mid=${JSON.stringify(botMsg!.id)}]`)}) || document.body.innerText.includes(${JSON.stringify(botMsg!.text!.trim().slice(0, 40))}))`,
                ),
              { timeout: 25_000 },
            )
            .toBe(true);
          const storedMessages = (await fetch(`${macBase}/api/threads/${bot.activeTaskId}/messages?limit=50`).then((r) =>
            r.json(),
          )) as { messages: Array<{ role: string; text: string }> };
          expect(
            storedMessages.messages.filter((m) => m.role === "user" && m.text === "Remote PWA E2E message"),
          ).toHaveLength(1);
          expect(page1.exceptions).toEqual([]);
        } finally {
          await page1.dispose();
        }

        // 2. Blocked IndexedDB (SecurityError) still pairs in-memory and renders without white screen.
        const page2 = await openIsolatedPage(
          'Object.defineProperty(window, "indexedDB", { get() { return { open() { throw new DOMException("Storage disabled", "SecurityError"); } }; } });',
        );
        try {
          const hash2 = await createInviteHash();
          await page2.req("Page.navigate", { url: `${spa.origin}/${hash2}` });
          await expect
            .poll(() => page2.evalJs('document.querySelector(\'textarea[aria-label^="Message"]\') !== null'), {
              timeout: 25_000,
            })
            .toBe(true);
          expect(await page2.evalJs("location.hash")).toBe("");
          expect(page2.exceptions).toEqual([]);
        } finally {
          await page2.dispose();
        }

        // 3. Invalid #pair= shows PairPage fallback UI instead of an empty white #root.
        const page3 = await openIsolatedPage();
        try {
          await page3.req("Page.navigate", { url: `${spa.origin}/#pair=not-valid-base64` });
          await expect
            .poll(
              () =>
                page3.evalJs(
                  'Boolean(document.getElementById("root")?.innerHTML?.length) && document.body.innerText.trim().length > 0',
                ),
              { timeout: 15_000 },
            )
            .toBe(true);
          expect(page3.exceptions).toEqual([]);
        } finally {
          await page3.dispose();
        }
      } finally {
        cdp?.close();
        if (browser) await waitForExit(browser, { signal: "SIGTERM" });
        await relay?.close();
        await fixture?.close();
        await spa?.close();
      }
    },
    180_000,
  );
});
