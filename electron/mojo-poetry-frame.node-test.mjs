import assert from "node:assert/strict";
import test from "node:test";

import { appFrameNavigationAllowed } from "./app-frame-guard.mjs";
import { MOJO_POETRY_FRAME_NAME, MOJO_POETRY_URL, mojoPoetryHostNavigationAllowed } from "./mojo-poetry-frame.mjs";

const LOCAL = "http://127.0.0.1:8799";
const main = { origin: LOCAL, url: `${LOCAL}/` };
const frame = { origin: "null", url: "", name: MOJO_POETRY_FRAME_NAME, parent: main };
const navigation = { isMainFrame: false, url: MOJO_POETRY_URL, frame, initiator: main };
const allowed = (change = {}, parent = main, origin = LOCAL) =>
  mojoPoetryHostNavigationAllowed({ ...navigation, ...change }, parent, origin);

test("the local host may start only its named, direct-child Mojo Poetry frame at the fixed URL", () => {
  assert.equal(appFrameNavigationAllowed(navigation), false, "the generic opaque-frame guard remains closed");
  assert.equal(allowed(), true);
  for (const change of [
    { isMainFrame: true },
    { url: "https://mao.hexly.ai/" },
    { url: `${MOJO_POETRY_URL}&data=secret` },
    { url: "https://other.example/#poem=03" },
    { initiator: null },
    { initiator: { ...main } },
    { frame: { ...frame, name: "other" } },
    { frame: { ...frame, parent: { ...main } } },
    { frame: { ...frame, origin: LOCAL } },
    { frame: { ...frame, url: "about:srcdoc" } },
  ]) assert.equal(allowed(change), false, JSON.stringify(change));
  assert.equal(allowed({}, main, "https://cloud.example"), false);
  assert.equal(allowed({}, { ...main }, LOCAL), false);
});

test("an opaque Mini App cannot use the same name, target and parent to navigate itself", () => {
  const opaque = { origin: "null", url: "about:srcdoc", name: MOJO_POETRY_FRAME_NAME, parent: main };
  const self = { ...navigation, initiator: opaque };
  assert.equal(appFrameNavigationAllowed(self), false);
  assert.equal(mojoPoetryHostNavigationAllowed(self, main, LOCAL), false);
  assert.equal(mojoPoetryHostNavigationAllowed({ ...navigation, initiator: frame }, main, LOCAL), false);
  assert.equal(mojoPoetryHostNavigationAllowed({ ...navigation, frame: { get parent() { throw new Error("disposed"); } } }, main, LOCAL), false);
});
