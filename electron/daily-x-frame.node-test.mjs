import assert from "node:assert/strict";
import test from "node:test";

import { appFrameNavigationAllowed } from "./app-frame-guard.mjs";
import { DAILY_X_FRAME_NAME, DAILY_X_URL, dailyXFrameNavigation, dailyXPageAllowed } from "./daily-x-frame.mjs";

const LOCAL = "http://127.0.0.1:8799";
const main = { origin: LOCAL, url: `${LOCAL}/` };
const frame = { origin: "null", url: "", name: DAILY_X_FRAME_NAME, parent: main };
const navigation = { isMainFrame: false, url: DAILY_X_URL, frame, initiator: main };
const decision = (change = {}, parent = main, origin = LOCAL) =>
  dailyXFrameNavigation({ ...navigation, ...change }, parent, origin);

test("only the local host starts its named direct Daily X frame", () => {
  assert.equal(appFrameNavigationAllowed(navigation), false);
  assert.equal(decision(), true);
  for (const change of [
    { initiator: null }, { initiator: frame }, { frame: { ...frame, name: "other" } },
    { frame: { ...frame, parent: { ...main } } }, { frame: { ...frame, url: "about:srcdoc" } },
    { frame: { ...frame, origin: LOCAL } }, { isMainFrame: true },
  ]) assert.notEqual(decision(change), true, JSON.stringify(change));
  assert.equal(decision({}, main, "https://cloud.example"), false);
  assert.equal(decision({}, { ...main }, LOCAL), false);
  assert.equal(decision({ frame: { ...frame, get parent() { throw new Error("disposed"); } } }), false);
  assert.equal(decision({ frame: { ...frame, name: "another" } }), null);
});

test("reading navigation remains on canonical XReport pages", () => {
  const current = { ...frame, origin: "https://mxhan.com", url: "https://mxhan.com/x/20261117/" };
  for (const url of [DAILY_X_URL, "https://mxhan.com/x/20261117/", "https://mxhan.com/x/20261117/2119569027937063405/",
    "https://mxhan.com/x/20261116/#story-2119569027937063405", "https://mxhan.com/x/topics/ai-compute-hardware-20261113/",
    "https://mxhan.com/x/topics/ai-compute-hardware-20261113/google-tpu8/"]) {
    assert.equal(dailyXPageAllowed(url), true, url);
    assert.equal(decision({ url, frame: current, initiator: current }), true, url);
  }
  for (const url of ["http://mxhan.com/x/", "https://www.mxhan.com/x/", "https://mxhan.com.evil.example/x/",
    "https://mxhan.com/x/?next=other", "https://user:pass@mxhan.com/x/", "https://mxhan.com/x/astryx/",
    "https://mxhan.com/x/assets/site.js", "https://mxhan.com/api/private", `${LOCAL}/api/mini-apps`,
    "https://mxhan.com/x/20261117/2119569027937063405/extra/"]) {
    assert.equal(dailyXPageAllowed(url), false, url);
    assert.equal(decision({ url, frame: current, initiator: current }), false, url);
  }
  assert.equal(decision({ frame: { ...current, url: "https://other.example/" } }), false);
  assert.equal(decision({ frame: { ...frame, url: "about:srcdoc" }, initiator: frame }), false);
});
