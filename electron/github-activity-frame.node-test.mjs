import assert from "node:assert/strict";
import test from "node:test";

import { createAppFrameFallback } from "./app-frame-guard.mjs";
import environments from "./environments.cjs";
import { installDailyXFrameGuards } from "./daily-x-frame.mjs";
import { GITHUB_ACTIVITY_FRAME_NAME, GITHUB_ACTIVITY_URL, createGithubActivityFrameGuards,
  createGithubActivityFrameNavigation, githubActivityPageAllowed, githubMediaUrlAllowed } from "./github-activity-frame.mjs";

const LOCAL = "http://127.0.0.1:8799";
const CLOUD = "https://saved.example.test";
const { workspaceNavigationAllowed } = environments;

function fixture() {
  const main = { origin: LOCAL, url: `${LOCAL}/`, frames: [] };
  const frame = { frameTreeNodeId: 77, origin: "null", url: "", name: GITHUB_ACTIVITY_FRAME_NAME, parent: main };
  main.frames.push(frame);
  const handlers = new Map();
  const webContents = { mainFrame: main, on: (name, listener) => handlers.set(name, listener) };
  let redirectFallbacks = 0;
  let frameFallbacks = 0;
  const appFallback = createAppFrameFallback({ webContents, localOrigin: () => LOCAL,
    serverOrigins: () => new Set([LOCAL, CLOUD]), log: () => {} });
  const githubGuards = createGithubActivityFrameGuards({
    webContents,
    localOrigin: () => LOCAL,
    redirectFallback: (details, url) => {
      redirectFallbacks++;
      if (!workspaceNavigationAllowed(url, { activeId: "local", environments: [] }, LOCAL)) details.preventDefault();
    },
    frameFallback: (details, url) => {
      frameFallbacks++;
      appFallback(details, url);
    },
  });
  installDailyXFrameGuards(webContents, {
    localOrigin: () => LOCAL,
    redirectFallback: githubGuards.redirectFallback,
    frameFallback: githubGuards.frameFallback,
  });
  const emit = (event, url, change = {}) => {
    const details = { isMainFrame: false, url, frame, initiator: main, prevented: false,
      preventDefault() { this.prevented = true; }, ...change };
    handlers.get(event)(details, url);
    return details.prevented;
  };
  return { main, frame, emit, getFallbacks: () => [redirectFallbacks, frameFallbacks] };
}

test("only the local host authorizes its named direct GitHub Activity frame", () => {
  const { main, frame } = fixture();
  const navigation = { isMainFrame: false, url: GITHUB_ACTIVITY_URL, frame, initiator: main };
  assert.equal(createGithubActivityFrameNavigation()(navigation, main, LOCAL, true), true);
  for (const change of [
    { initiator: null }, { initiator: frame }, { frame: { ...frame, name: "other" } },
    { frame: { ...frame, parent: { ...main } } }, { frame: { ...frame, url: "about:srcdoc" } },
    { frame: { ...frame, origin: LOCAL } }, { isMainFrame: true },
  ]) {
    const candidate = { ...navigation, ...change };
    main.frames = [candidate.frame];
    assert.notEqual(createGithubActivityFrameNavigation()(candidate, main, LOCAL, true), true);
  }
  main.frames = [frame];
  assert.equal(createGithubActivityFrameNavigation()(navigation, main, "https://cloud.example", true), false);
});

test("combined guards allow canonical GitHub routes and redirects while blocking media/static/off-origin navigations", () => {
  const { main, frame, emit, getFallbacks } = fixture();
  assert.equal(emit("will-frame-navigate", GITHUB_ACTIVITY_URL), false);
  assert.equal(emit("will-redirect", "https://mxhan.com/github/20261120/", { initiator: null }), false);
  assert.equal(emit("will-redirect", "https://mxhan.com/github/media/demo.png", { initiator: null }), true);
  assert.equal(emit("will-redirect", "https://mxhan.com/x/", { initiator: null }), true);
  frame.origin = "https://mxhan.com";
  frame.url = "https://mxhan.com/github/20261120/";
  frame.name = "renamed-by-page";
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/github/20261120/dream-num/univer/", { initiator: frame }), false);
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/github/demo/univer-orders/", { initiator: frame }), false);
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/github/demo/univer-orders/demo.js", { initiator: frame }), true);
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/github/demo/pandera-orders/", { initiator: frame }), false);
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/github/demo/pandera-orders/source.zip", { initiator: frame }), true);
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/github/demo/pandera-orders/demo.js", { initiator: frame }), true);
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/github/demo/sqlglot-query-lab/", { initiator: frame }), false);
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/github/demo/sqlglot-query-lab/sqlglot-query-lab-source.zip", { initiator: frame }), true);
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/github/demo/sqlglot-query-lab/results.json", { initiator: frame }), true);
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/github/demo/sqlglot-query-lab/run_demo.py", { initiator: frame }), true);
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/github/demo/sqlglot-query-lab/index.html", { initiator: frame }), true);
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/github/demo/hypothesis-orders/", { initiator: frame }), false);
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/github/demo/hypothesis-orders-lab/", { initiator: frame }), true);
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/github/demo/hypothesis-orders/hypothesis-orders-lab-source.zip", { initiator: frame }), true);
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/github/demo/hypothesis-orders/results.json", { initiator: frame }), true);
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/github/demo/hypothesis-orders/run_demo.py", { initiator: frame }), true);
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/github/demo/hypothesis-orders/index.html", { initiator: frame }), true);
  assert.equal(emit("will-frame-navigate", "https://other.example/", { initiator: frame }), true);
  assert.equal(emit("will-redirect", "https://other.example/", { initiator: null }), true);
  assert.deepEqual(getFallbacks(), [0, 0]);
  main.frames = [];
  assert.equal(emit("will-frame-navigate", "https://mxhan.com/github/20261120/", { initiator: frame }), true);
});

test("validates canonical GitHub document routes and media URLs strictly", () => {
  for (const url of [
    "https://mxhan.com/github/",
    "https://mxhan.com/github/20261120/",
    "https://mxhan.com/github/20261120/dream-num/univer/",
    "https://mxhan.com/github/20261120/dream-num/univer/#section-1",
    "https://mxhan.com/github/demo/univer-orders/",
  ]) assert.equal(githubActivityPageAllowed(url), true, url);

  for (const url of [
    "http://mxhan.com/github/",
    "https://www.mxhan.com/github/",
    "https://mxhan.com:443/github/",
    "https://user:pass@mxhan.com/github/",
    "https://mxhan.com/github/?q=1",
    "https://mxhan.com/github/20261399/",
    "https://mxhan.com/github/20261120/Dream-Num/univer/",
    "https://mxhan.com/github/20261120/dream-num/../x/",
    "https://mxhan.com/github/20261120/%2e%2e/x/",
    "https://mxhan.com/github/20261120/dream-num/univer/extra/",
    "https://mxhan.com/github/media/20261120/demo.png",
    "https://mxhan.com/github/demo/univer-orders/demo.js",
    "https://mxhan.com/x/",
  ]) assert.equal(githubActivityPageAllowed(url), false, url);

  for (const url of [
    "https://mxhan.com/github/media/demo.png",
    "https://mxhan.com/github/media/20261120/univer-orders-1280.webp",
    "https://mxhan.com/github/media/20261120/walkthrough.mp4",
    "https://mxhan.com/github/media/20261120/clip.webm",
    "https://mxhan.com/github/media/20261120/still.avif",
  ]) assert.equal(githubMediaUrlAllowed(url), true, url);

  for (const url of [
    "https://mxhan.com/github/media/demo.png?v=1",
    "https://mxhan.com/github/media/demo.png#frag",
    "https://mxhan.com/github/media/demo.html",
    "https://mxhan.com/github/media/demo.svg",
    "https://mxhan.com/github/media/../x.png",
    "https://mxhan.com/github/media/%2e%2e/x.png",
    "https://mxhan.com/x/assets/demo.png",
    "https://other.example/github/media/demo.png",
  ]) assert.equal(githubMediaUrlAllowed(url), false, url);
});

test("allows only the exact Pandera demo document route while rejecting lookalike/ZIP/script/media/query/dot/encoded/other-origin URLs", () => {
  for (const url of [
    "https://mxhan.com/github/demo/pandera-orders/",
    "https://mxhan.com/github/demo/pandera-orders/#section-1",
  ]) assert.equal(githubActivityPageAllowed(url), true, url);

  for (const url of [
    "https://mxhan.com/github/demo/pandera-orders",
    "https://mxhan.com/github/demo/pandera-orders-2/",
    "https://mxhan.com/github/demo/pandera-orders/extra/",
    "https://mxhan.com/github/demo/pandera/",
    "https://mxhan.com/github/demo/pandera-orders/index.html",
    "https://mxhan.com/github/demo/pandera-orders/source.zip",
    "https://mxhan.com/github/demo/pandera-orders.zip",
    "https://mxhan.com/github/demo/pandera-orders/demo.js",
    "https://mxhan.com/github/demo/pandera-orders/app.mjs",
    "https://mxhan.com/github/demo/pandera-orders/preview.png",
    "https://mxhan.com/github/demo/pandera-orders/?q=1",
    "https://mxhan.com/github/demo/pandera-orders/../univer-orders/",
    "https://mxhan.com/github/demo/./pandera-orders/",
    "https://mxhan.com/github/demo/pandera%2dorders/",
    "https://mxhan.com/github/demo/%2e%2e/pandera-orders/",
    "https://other.example/github/demo/pandera-orders/",
    "http://mxhan.com/github/demo/pandera-orders/",
    "https://www.mxhan.com/github/demo/pandera-orders/",
    "https://mxhan.com:443/github/demo/pandera-orders/",
    "https://user:pass@mxhan.com/github/demo/pandera-orders/",
  ]) assert.equal(githubActivityPageAllowed(url), false, url);

  for (const url of [
    "https://mxhan.com/github/demo/pandera-orders/",
    "https://mxhan.com/github/demo/pandera-orders/source.zip",
    "https://mxhan.com/github/demo/pandera-orders/preview.png",
  ]) assert.equal(githubMediaUrlAllowed(url), false, url);
});

test("allows only the exact SQLGlot demo document route while rejecting lookalike/ZIP/subfile/media/query/dot/encoded/other-origin URLs", () => {
  for (const url of [
    "https://mxhan.com/github/demo/sqlglot-query-lab/",
    "https://mxhan.com/github/demo/sqlglot-query-lab/#sqlite-exec",
  ]) assert.equal(githubActivityPageAllowed(url), true, url);

  for (const url of [
    "https://mxhan.com/github/demo/sqlglot-query-lab",
    "https://mxhan.com/github/demo/sqlglot-query-lab-2/",
    "https://mxhan.com/github/demo/sqlglot-query-lab/extra/",
    "https://mxhan.com/github/demo/sqlglot/",
    "https://mxhan.com/github/demo/sqlglot-query-lab/index.html",
    "https://mxhan.com/github/demo/sqlglot-query-lab/results.json",
    "https://mxhan.com/github/demo/sqlglot-query-lab/run_demo.py",
    "https://mxhan.com/github/demo/sqlglot-query-lab/requirements.lock",
    "https://mxhan.com/github/demo/sqlglot-query-lab/README.md",
    "https://mxhan.com/github/demo/sqlglot-query-lab/LICENSE",
    "https://mxhan.com/github/demo/sqlglot-query-lab/sqlglot-query-lab-source.zip",
    "https://mxhan.com/github/demo/sqlglot-query-lab.zip",
    "https://mxhan.com/github/demo/sqlglot-query-lab/demo.js",
    "https://mxhan.com/github/demo/sqlglot-query-lab/app.mjs",
    "https://mxhan.com/github/demo/sqlglot-query-lab/preview.png",
    "https://mxhan.com/github/demo/sqlglot-query-lab/?q=1",
    "https://mxhan.com/github/demo/sqlglot-query-lab/../pandera-orders/",
    "https://mxhan.com/github/demo/./sqlglot-query-lab/",
    "https://mxhan.com/github/demo/sqlglot%2dquery%2dlab/",
    "https://mxhan.com/github/demo/%2e%2e/sqlglot-query-lab/",
    "https://other.example/github/demo/sqlglot-query-lab/",
    "http://mxhan.com/github/demo/sqlglot-query-lab/",
    "https://www.mxhan.com/github/demo/sqlglot-query-lab/",
    "https://mxhan.com:443/github/demo/sqlglot-query-lab/",
    "https://user:pass@mxhan.com/github/demo/sqlglot-query-lab/",
  ]) assert.equal(githubActivityPageAllowed(url), false, url);

  for (const url of [
    "https://mxhan.com/github/demo/sqlglot-query-lab/",
    "https://mxhan.com/github/demo/sqlglot-query-lab/sqlglot-query-lab-source.zip",
    "https://mxhan.com/github/demo/sqlglot-query-lab/results.json",
    "https://mxhan.com/github/demo/sqlglot-query-lab/preview.png",
  ]) assert.equal(githubMediaUrlAllowed(url), false, url);
});

test("allows only the exact jsonschema demo document route while rejecting lookalike, subfile, query and other-origin URLs", () => {
  for (const url of [
    "https://mxhan.com/github/demo/jsonschema-agent-contract/",
    "https://mxhan.com/github/demo/jsonschema-agent-contract/#contract",
  ]) assert.equal(githubActivityPageAllowed(url), true, url);

  for (const url of [
    "https://mxhan.com/github/demo/jsonschema-agent-contract",
    "https://mxhan.com/github/demo/jsonschema-agent-contract-2/",
    "https://mxhan.com/github/demo/jsonschema-agent-contract/extra/",
    "https://mxhan.com/github/demo/jsonschema-agent-contract/index.html",
    "https://mxhan.com/github/demo/jsonschema-agent-contract/results.json",
    "https://mxhan.com/github/demo/jsonschema-agent-contract/?q=1",
    "https://other.example/github/demo/jsonschema-agent-contract/",
  ]) assert.equal(githubActivityPageAllowed(url), false, url);

  for (const url of [
    "https://mxhan.com/github/demo/jsonschema-agent-contract/",
    "https://mxhan.com/github/demo/jsonschema-agent-contract/results.json",
  ]) assert.equal(githubMediaUrlAllowed(url), false, url);
});

test("allows only the exact DeepDiff demo document route while rejecting lookalike, subfile, ZIP and resource URLs", () => {
  for (const url of [
    "https://mxhan.com/github/demo/deepdiff-order-audit/",
    "https://mxhan.com/github/demo/deepdiff-order-audit/#ignore-order",
  ]) assert.equal(githubActivityPageAllowed(url), true, url);

  for (const url of [
    "https://mxhan.com/github/demo/deepdiff-order-audit",
    "https://mxhan.com/github/demo/deepdiff-order-audit-2/",
    "https://mxhan.com/github/demo/deepdiff-order-audit-lab/",
    "https://mxhan.com/github/demo/deepdiff-order-audit/extra/",
    "https://mxhan.com/github/demo/deepdiff-order-audit/index.html",
    "https://mxhan.com/github/demo/deepdiff-order-audit/results.json",
    "https://mxhan.com/github/demo/deepdiff-order-audit/run_demo.py",
    "https://mxhan.com/github/demo/deepdiff-order-audit/deepdiff-order-audit-lab-source.zip",
    "https://mxhan.com/github/demo/deepdiff-order-audit/preview.png",
    "https://mxhan.com/github/demo/deepdiff-order-audit/?q=1",
    "https://mxhan.com/github/demo/deepdiff%2dorder%2daudit/",
    "https://other.example/github/demo/deepdiff-order-audit/",
    "http://mxhan.com/github/demo/deepdiff-order-audit/",
  ]) assert.equal(githubActivityPageAllowed(url), false, url);

  for (const url of [
    "https://mxhan.com/github/demo/deepdiff-order-audit/",
    "https://mxhan.com/github/demo/deepdiff-order-audit/deepdiff-order-audit-lab-source.zip",
    "https://mxhan.com/github/demo/deepdiff-order-audit/preview.png",
  ]) assert.equal(githubMediaUrlAllowed(url), false, url);
});

test("allows only the exact Hypothesis demo document route while rejecting superseded/lookalike/ZIP/subfile/media/query/dot/encoded/other-origin URLs", () => {
  for (const url of [
    "https://mxhan.com/github/demo/hypothesis-orders/",
    "https://mxhan.com/github/demo/hypothesis-orders/#weak-property",
  ]) assert.equal(githubActivityPageAllowed(url), true, url);

  for (const url of [
    "https://mxhan.com/github/demo/hypothesis-orders",
    "https://mxhan.com/github/demo/hypothesis-orders-lab/",
    "https://mxhan.com/github/demo/hypothesis-orders-lab",
    "https://mxhan.com/github/demo/hypothesis-orders-2/",
    "https://mxhan.com/github/demo/hypothesis-orders/extra/",
    "https://mxhan.com/github/demo/hypothesis/",
    "https://mxhan.com/github/demo/hypothesis-orders/index.html",
    "https://mxhan.com/github/demo/hypothesis-orders/results.json",
    "https://mxhan.com/github/demo/hypothesis-orders/run_demo.py",
    "https://mxhan.com/github/demo/hypothesis-orders/requirements.lock",
    "https://mxhan.com/github/demo/hypothesis-orders/README.md",
    "https://mxhan.com/github/demo/hypothesis-orders/LICENSE",
    "https://mxhan.com/github/demo/hypothesis-orders/hypothesis-orders-lab-source.zip",
    "https://mxhan.com/github/demo/hypothesis-orders.zip",
    "https://mxhan.com/github/demo/hypothesis-orders/demo.js",
    "https://mxhan.com/github/demo/hypothesis-orders/app.mjs",
    "https://mxhan.com/github/demo/hypothesis-orders/preview.png",
    "https://mxhan.com/github/demo/hypothesis-orders/?q=1",
    "https://mxhan.com/github/demo/hypothesis-orders/../sqlglot-query-lab/",
    "https://mxhan.com/github/demo/./hypothesis-orders/",
    "https://mxhan.com/github/demo/hypothesis%2dorders/",
    "https://mxhan.com/github/demo/%2e%2e/hypothesis-orders/",
    "https://other.example/github/demo/hypothesis-orders/",
    "http://mxhan.com/github/demo/hypothesis-orders/",
    "https://www.mxhan.com/github/demo/hypothesis-orders/",
    "https://mxhan.com:443/github/demo/hypothesis-orders/",
    "https://user:pass@mxhan.com/github/demo/hypothesis-orders/",
  ]) assert.equal(githubActivityPageAllowed(url), false, url);

  for (const url of [
    "https://mxhan.com/github/demo/hypothesis-orders/",
    "https://mxhan.com/github/demo/hypothesis-orders/hypothesis-orders-lab-source.zip",
    "https://mxhan.com/github/demo/hypothesis-orders/results.json",
    "https://mxhan.com/github/demo/hypothesis-orders/preview.png",
    "https://mxhan.com/github/demo/hypothesis-orders-lab/",
  ]) assert.equal(githubMediaUrlAllowed(url), false, url);
});
