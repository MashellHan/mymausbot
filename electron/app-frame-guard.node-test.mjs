import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { appFrameBlinkSettings, appFrameNavigationAllowed, createAppFrameFallback } from "./app-frame-guard.mjs";
import { installDailyXFrameGuards } from "./daily-x-frame.mjs";
import environments from "./environments.cjs";
import { MOJO_POETRY_FRAME_NAME, MOJO_POETRY_URL } from "./mojo-poetry-frame.mjs";

const appFrame = (url) => ({ isMainFrame: false, url, frame: { origin: "null", url: "" } });

test("disables DNS speculation while preserving other Blink settings", () => {
  assert.equal(appFrameBlinkSettings(), "dnsPrefetchingEnabled=false");
  assert.equal(appFrameBlinkSettings("imagesEnabled=true,dnsPrefetchingEnabled=true"), "imagesEnabled=true,dnsPrefetchingEnabled=false");
});

test("an app frame may load its own document", () => {
  assert.equal(appFrameNavigationAllowed(appFrame("about:srcdoc")), true);
  assert.equal(appFrameNavigationAllowed(appFrame("about:blank")), true);
  assert.equal(appFrameNavigationAllowed(appFrame("about:srcdoc#totals")), true);
});

test("an app frame may not navigate anywhere else", () => {
  for (const url of [
    "http://127.0.0.1:9/sink",
    "https://example.com/",
    "https://cdnjs.cloudflare.com/ajax/libs/x.js",
    "http://localhost:8799/",
    "data:text/html,<p>hi</p>",
    "blob:null/1234",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "about:srcdocx",
    "about:blank/../srcdoc",
    "",
    undefined,
  ]) assert.equal(appFrameNavigationAllowed(appFrame(url)), false, String(url));
});

test("cancels, and never throws, when the frame can no longer be read", () => {
  // Electron throws from WebFrameMain's getters once its render frame is gone.
  const disposed = { get origin() { throw new Error("Render frame was disposed before WebFrameMain could be accessed"); } };
  assert.equal(appFrameNavigationAllowed({ isMainFrame: false, url: "http://127.0.0.1:9/location", frame: disposed }), false);
  assert.equal(appFrameNavigationAllowed({ isMainFrame: false, url: "about:srcdoc", frame: disposed }), true);
  assert.equal(appFrameNavigationAllowed({ isMainFrame: true, url: "http://127.0.0.1:9/", frame: disposed }), true);
});

test("leaves main frames and frames with a real origin alone", () => {
  assert.equal(appFrameNavigationAllowed({ isMainFrame: true, url: "https://example.com/", frame: { origin: "null" } }), true);
  assert.equal(appFrameNavigationAllowed({ isMainFrame: false, url: "https://example.com/", frame: { origin: "http://127.0.0.1:5199" } }), true);
  assert.equal(appFrameNavigationAllowed({ isMainFrame: false, url: "https://example.com/", frame: null }), true);
  assert.equal(appFrameNavigationAllowed(null), true);
  assert.equal(appFrameNavigationAllowed(undefined), true);
});

test("the main window's actual listeners block local and saved server frames on navigation and redirect", () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = source.indexOf("  const guardNavigation = (event, url) => {");
  const end = source.indexOf('  win.webContents.on("did-fail-load",', start);
  assert.ok(start >= 0 && end > start);
  const local = "http://127.0.0.1:8799";
  const saved = "https://saved.example.test";
  const mainFrame = { origin: local, url: `${local}/` };
  const handlers = new Map();
  const win = { webContents: { mainFrame, on: (name, listener) => handlers.set(name, listener) } };
  const environmentsState = { activeId: "local", environments: [{ id: "saved", origin: saved }] };
  vm.runInNewContext(source.slice(start, end), { win, environmentsState, URL, createAppFrameFallback, installDailyXFrameGuards,
    rendererOrigin: () => local, workspaceNavigationAllowed: environments.workspaceNavigationAllowed,
    allowedOrigins: environments.allowedOrigins, slog: () => {} });
  const emit = (event, url, change = {}) => {
    const details = { isMainFrame: false, url, frame: { origin: "https://external.example" }, prevented: false,
      preventDefault() { this.prevented = true; }, ...change };
    handlers.get(event)(details, url);
    return details.prevented;
  };
  for (const event of ["will-frame-navigate", "will-redirect"]) {
    assert.equal(emit(event, `${local}/api/private`, { frame: { origin: local } }), true, `${event}: own local origin`);
    assert.equal(emit(event, `${saved}/api/private`), true, `${event}: saved origin`);
  }
  assert.equal(emit("will-redirect", `${local}/api/private`, { url: "https://external.example/previous" }), true,
    "the redirect target is checked even when the event retains the previous URL");
  environmentsState.activeId = "saved";
  mainFrame.origin = saved;
  assert.equal(emit("will-frame-navigate", `${saved}/api/private`, { frame: { origin: saved } }), true,
    "the active saved page cannot frame its own server");
  assert.equal(emit("will-redirect", `${saved}/api/private`, { frame: { origin: saved } }), true);
  environmentsState.activeId = "local";
  mainFrame.origin = local;
  assert.equal(emit("will-frame-navigate", "https://external.example/page"), false);
  assert.equal(emit("will-redirect", "https://external.example/page"), true,
    "the existing workspace redirect policy still applies");
  assert.equal(emit("will-frame-navigate", MOJO_POETRY_URL, { frame: {
    origin: "null", url: "", name: MOJO_POETRY_FRAME_NAME, parent: mainFrame }, initiator: mainFrame }), false);
  assert.equal(emit("will-frame-navigate", `${local}/api/private`, { frame: { origin: "null" } }), true);
  assert.equal(emit("will-frame-navigate", `${local}/`, { isMainFrame: true }), false);
  assert.equal(emit("will-navigate", `${local}/`, { isMainFrame: true }), false);
  assert.equal(emit("will-redirect", `${local}/`, { isMainFrame: true }), false);
  assert.equal(emit("will-redirect", `${saved}/`, { isMainFrame: true }), true,
    "the existing main-frame workspace policy still applies");
});

// A frame that has not loaded anything yet reads "null" too. Electron 43.7.9 reports the parent as the initiator when
// the page that holds the frame gives it its address, and the frame (or a sandboxed parent) when an app moves itself.
const appPage = { frameTreeNodeId: 1, origin: "http://127.0.0.1:5199" };
const newFrame = (url, initiator, parent = appPage) => ({ isMainFrame: false, url, frame: { origin: "null", url: "", parent }, initiator });

test("a new frame may load the address the app page gives it (a published site beside the chat)", () => {
  assert.equal(appFrameNavigationAllowed(newFrame("https://abc.mausbot.page/", { frameTreeNodeId: 1, origin: "http://127.0.0.1:5199" })), true);
});

test("an app frame still may not go anywhere by itself or through a frame of its own", () => {
  const app = { frameTreeNodeId: 2, origin: "null" };
  // Meta refresh: the app frame starts its own navigation.
  assert.equal(appFrameNavigationAllowed(newFrame("http://127.0.0.1:9/meta", app)), false);
  // An iframe inside the app: its parent is the app frame, whose origin is opaque.
  assert.equal(appFrameNavigationAllowed(newFrame("http://127.0.0.1:9/inner", app, app)), false);
  // No initiator, or one from elsewhere, is not the app page.
  assert.equal(appFrameNavigationAllowed(newFrame("http://127.0.0.1:9/x", undefined)), false);
  assert.equal(appFrameNavigationAllowed(newFrame("http://127.0.0.1:9/x", { frameTreeNodeId: 3, origin: "https://example.com" })), false);
  assert.equal(appFrameNavigationAllowed(newFrame("http://127.0.0.1:9/x", { origin: "http://127.0.0.1:5199" }, { origin: "http://127.0.0.1:5199" })), false);
  const gone = { get frameTreeNodeId() { throw new Error("Render frame was disposed before WebFrameMain could be accessed"); }, origin: "http://127.0.0.1:5199" };
  assert.equal(appFrameNavigationAllowed(newFrame("http://127.0.0.1:9/x", gone)), false);
});
