import assert from "node:assert/strict";
import test from "node:test";

import { appFrameNavigationAllowed } from "./app-frame-guard.mjs";
import environments from "./environments.cjs";
import { DAILY_X_FRAME_NAME, DAILY_X_URL, createDailyXFrameNavigation, dailyXPageAllowed,
  installDailyXFrameGuards } from "./daily-x-frame.mjs";

const LOCAL = "http://127.0.0.1:8799";
const { workspaceNavigationAllowed } = environments;

function fixture() {
  const main = { origin: LOCAL, url: `${LOCAL}/`, frames: [] };
  const frame = { frameTreeNodeId: 42, origin: "null", url: "", name: DAILY_X_FRAME_NAME, parent: main };
  main.frames.push(frame);
  const handlers = new Map();
  const webContents = { mainFrame: main, on: (name, listener) => handlers.set(name, listener) };
  let redirectFallbacks = 0;
  let frameFallbacks = 0;
  installDailyXFrameGuards(webContents, {
    localOrigin: () => LOCAL,
    redirectFallback: (details, url) => { redirectFallbacks++;
      if (!workspaceNavigationAllowed(url, { activeId: "local", environments: [] }, LOCAL)) details.preventDefault(); },
    frameFallback: (details) => { frameFallbacks++;
      if (!appFrameNavigationAllowed(details)) details.preventDefault(); },
  });
  const emit = (event, url, change = {}) => {
    const details = { isMainFrame: false, url, frame, initiator: main, prevented: false,
      preventDefault() { this.prevented = true; }, ...change };
    handlers.get(event)(details, url);
    return details.prevented;
  };
  return { main, frame, emit, getFallbacks: () => [redirectFallbacks, frameFallbacks] };
}

test("only the local host authorizes its named direct Daily X frame", () => {
  const { main, frame } = fixture();
  const navigation = { isMainFrame: false, url: DAILY_X_URL, frame, initiator: main };
  assert.equal(appFrameNavigationAllowed(navigation), false);
  assert.equal(createDailyXFrameNavigation()(navigation, main, LOCAL, true), true);
  for (const change of [
    { initiator: null }, { initiator: frame }, { frame: { ...frame, name: "other" } },
    { frame: { ...frame, parent: { ...main } } }, { frame: { ...frame, url: "about:srcdoc" } },
    { frame: { ...frame, origin: LOCAL } }, { isMainFrame: true },
  ]) {
    const candidate = { ...navigation, ...change };
    main.frames = [candidate.frame];
    assert.notEqual(createDailyXFrameNavigation()(candidate, main, LOCAL, true), true);
  }
  main.frames = [frame];
  assert.equal(createDailyXFrameNavigation()(navigation, main, "https://cloud.example", true), false);
});

test("the actual combined handlers allow the latest redirect and retain the frame after a name change", () => {
  const { main, frame, emit, getFallbacks } = fixture();
  assert.equal(emit("will-frame-navigate", DAILY_X_URL), false);
  assert.equal(emit("will-redirect", "https://mxhan.com/x/20261117/", { initiator: null }), false);
  assert.equal(emit("will-redirect", "https://mxhan.com/x/assets/site.js", { initiator: null }), true);
  frame.origin = "https://mxhan.com";
  frame.url = "https://mxhan.com/x/20261117/";
  frame.name = "renamed-by-page";
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/x/20261117/2119569027937063405/", { initiator: frame }), false);
  assert.equal(emit("will-frame-navigate", "https://other.example/", { initiator: frame }), true);
  assert.equal(emit("will-redirect", "https://other.example/", { initiator: null }), true);
  assert.deepEqual(getFallbacks(), [0, 0]);
  main.frames = [];
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/x/20261116/", { initiator: frame }), true);
});

test("unrelated frames keep the ordinary fallback and only canonical XReport pages qualify", () => {
  const { frame, emit, getFallbacks } = fixture();
  frame.name = "ordinary";
  assert.equal(emit("will-frame-navigate", DAILY_X_URL), true);
  assert.equal(emit("will-redirect", "https://other.example/", { isMainFrame: true }), true);
  assert.deepEqual(getFallbacks(), [1, 1]);
  for (const url of [DAILY_X_URL, "https://mxhan.com/x/20261117/", "https://mxhan.com/x/20261117/2119569027937063405/",
    "https://mxhan.com/x/20261116/#story-2119569027937063405", "https://mxhan.com/x/topics/ai-compute-hardware-20261113/",
    "https://mxhan.com/x/topics/ai-compute-hardware-20261113/google-tpu8/"]) assert.equal(dailyXPageAllowed(url), true, url);
  for (const url of ["http://mxhan.com/x/", "https://www.mxhan.com/x/", "https://mxhan.com.evil.example/x/",
    "https://mxhan.com/x/?next=other", "https://user:pass@mxhan.com/x/", "https://mxhan.com/x/astryx/",
    "https://mxhan.com/x/assets/site.js", "https://mxhan.com/api/private", `${LOCAL}/api/mini-apps`,
    "https://mxhan.com/x/20261117/2119569027937063405/extra/"]) assert.equal(dailyXPageAllowed(url), false, url);
});
