// The desktop app's private parent port, for a server a test or the launcher's desktop mode starts as if Electron had:
// the server runs as Electron's utility process, and only what the app itself would send crosses.
// OMB_TEST_DESKTOP_OWNER_TOKEN (with OMB_DESKTOP_PARENT=1): the test's owner capability.
// OMB_TEST_DESKTOP_PAGES_ACCESS: the published pages' access the app hands over for a signed-in MausBot account, as JSON.
// OMB_TEST_DESKTOP_CUA_CONNECTION: a file holding the app's driver record; the app hands it to its own server, and again
// each time the file changes, as the real app does each time its driver changes.
import { readFileSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { createSessionConfigMemory } from "../../electron/session-config.mjs";

const token = process.env.OMB_TEST_DESKTOP_OWNER_TOKEN;
const pages = process.env.OMB_TEST_DESKTOP_PAGES_ACCESS;
const cuaFile = process.env.OMB_TEST_DESKTOP_CUA_CONNECTION;
const sessionConfigCapture = process.env.OMB_TEST_SESSION_CONFIG_CAPTURE;
const sessionConfigReply = process.env.OMB_TEST_SESSION_CONFIG_REPLY;
const sessionConfigMemory = sessionConfigCapture ? createSessionConfigMemory() : null;
const sessionDataDir = process.env.OMB_DATA_DIR;
delete process.env.OMB_TEST_DESKTOP_OWNER_TOKEN;
delete process.env.OMB_TEST_DESKTOP_PAGES_ACCESS;
delete process.env.OMB_TEST_DESKTOP_CUA_CONNECTION;
delete process.env.OMB_TEST_SESSION_CONFIG_CAPTURE;
delete process.env.OMB_TEST_SESSION_CONFIG_REPLY;

const cuaGrant = () => {
  let connection = null;
  try {
    connection = JSON.parse(readFileSync(cuaFile, "utf8"));
  } catch {}
  return { type: "openmausbot:local-computer", connection };
};

if (token || cuaFile) {
  const listeners = [];
  if (cuaFile) {
    watchFile(cuaFile, { interval: 25, persistent: false }, () => {
      const grant = cuaGrant();
      for (const listener of listeners) listener({ data: grant });
    });
    process.once("exit", () => unwatchFile(cuaFile));
  }
  Object.defineProperty(process, "parentPort", {
    value: {
      on(event, listener) {
        if (event !== "message") return;
        listeners.push(listener);
        if (token) queueMicrotask(() => listener({ data: { type: "openmausbot:desktop-mutation-token", token } }));
        if (pages) queueMicrotask(() => listener({ data: { type: "openmausbot:included-pages", access: JSON.parse(pages) } }));
        if (cuaFile) queueMicrotask(() => listener({ data: cuaGrant() }));
      },
      postMessage(message) {
        if (!sessionConfigMemory || !sessionDataDir) return;
        const type = message?.type;
        if (type === "openmausbot:session-config-cancel") { sessionConfigMemory.cancel(sessionDataDir, message.requestId); return; }
        if (type === "openmausbot:session-config-finish") {
          if (sessionConfigMemory.finish(sessionDataDir, message.requestId, process)) {
            writeFileSync(sessionConfigCapture, sessionConfigMemory.childEnvironment(sessionDataDir).OMB_SESSION_CONFIG_JSON, { mode: 0o600 });
          }
          return;
        }
        if (type !== "openmausbot:session-config" && type !== "openmausbot:session-config-commit") return;
        const phase = type === "openmausbot:session-config" ? "prepared" : "committed";
        let ok = sessionConfigReply !== "deny" && sessionConfigReply !== "deny-commit";
        if (sessionConfigReply === "deny-commit" && phase === "prepared") ok = true;
        try {
          if (ok) ok = phase === "prepared"
            ? sessionConfigMemory.receive(sessionDataDir, message, process)
            : sessionConfigMemory.commit(sessionDataDir, message.requestId, process);
        } catch { ok = false; }
        if (sessionConfigReply === "drop" || (sessionConfigReply === "drop-commit" && phase === "committed")) return;
        for (const listener of listeners) queueMicrotask(() => listener({ data: {
          type: "openmausbot:session-config-result", requestId: message.requestId, phase, ok,
        } }));
      },
    },
  });
}
