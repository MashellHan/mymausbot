import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionConfigMemory } from "./session-config.mjs";

test("the App holds current config only in memory across utility-server restarts", () => {
  const current = createSessionConfigMemory();
  const secret = "synthetic-session-only-key";
  const snapshot = { openai: { key: secret }, instances: { synthetic: { driver: "customAcp", environment: { TOKEN: secret } } } };
  const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  assert.deepEqual(current.childEnvironment("workspace-a"), {});
  assert.equal(current.receive("workspace-a", { type: "openmausbot:session-config", requestId: first, config: snapshot }, "child-a"), true);
  assert.deepEqual(current.childEnvironment("workspace-a"), {}, "an unconfirmed snapshot is never a recovery seed");
  assert.equal(current.commit("workspace-a", first, "child-a"), true);
  assert.equal(current.finish("workspace-a", first, "child-a"), true);
  snapshot.openai.key = "changed-after-message";
  const restartedServer = JSON.parse(current.childEnvironment("workspace-a").OMB_SESSION_CONFIG_JSON);
  assert.equal(restartedServer.openai.key, secret);
  assert.equal(restartedServer.instances.synthetic.environment.TOKEN, secret);
  assert.deepEqual(current.childEnvironment("workspace-b"), {}, "another local environment does not inherit credentials");
  assert.equal(current.receive("workspace-b", { type: "openmausbot:session-config", requestId: second, config: { openai: { key: "other-workspace" } } }, "child-b"), true);
  assert.equal(current.commit("workspace-b", second, "child-b"), true);
  assert.equal(current.finish("workspace-b", second, "child-b"), true);
  assert.equal(JSON.parse(current.childEnvironment("workspace-a").OMB_SESSION_CONFIG_JSON).openai.key, secret);
  assert.equal(JSON.parse(current.childEnvironment("workspace-b").OMB_SESSION_CONFIG_JSON).openai.key, "other-workspace");
  assert.deepEqual(createSessionConfigMemory().childEnvironment("workspace-a"), {}, "a new App process forgets the snapshot");
});

test("missing or late acknowledgements cannot make a rejected key a recovery seed", () => {
  const state = createSessionConfigMemory();
  const old = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const rejected = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  state.receive("workspace-a", { type: "openmausbot:session-config", requestId: old, config: { xai: { key: "accepted" } } }, "child");
  state.commit("workspace-a", old, "child");
  state.finish("workspace-a", old, "child");
  state.receive("workspace-a", { type: "openmausbot:session-config", requestId: rejected, config: { xai: { key: "rejected" } } }, "child");
  assert.equal(JSON.parse(state.childEnvironment("workspace-a").OMB_SESSION_CONFIG_JSON).xai.key, "accepted");
  state.cancel("workspace-a", rejected);
  assert.equal(state.commit("workspace-a", rejected, "child"), false, "a delayed commit cannot revive a canceled request");
  state.receive("workspace-a", { type: "openmausbot:session-config", requestId: rejected, config: { xai: { key: "rejected" } } }, "child");
  state.commit("workspace-a", rejected, "child");
  state.cancel("workspace-a", rejected);
  assert.equal(JSON.parse(state.childEnvironment("workspace-a").OMB_SESSION_CONFIG_JSON).xai.key, "accepted");
  assert.equal(state.finish("workspace-a", rejected, "child"), false);
  state.receive("workspace-a", { type: "openmausbot:session-config", requestId: rejected, config: { xai: { key: "rejected" } } }, "child");
  state.commit("workspace-a", rejected, "child");
  state.rejectProcess("child");
  assert.equal(JSON.parse(state.childEnvironment("workspace-a").OMB_SESSION_CONFIG_JSON).xai.key, "accepted");
});

test("the App rejects malformed or oversized private snapshots", () => {
  const state = createSessionConfigMemory();
  assert.equal(state.receive({ type: "unrelated", config: {} }), false);
  for (const config of [null, [], "secret", { huge: "x".repeat(128 * 1024) }]) {
    assert.throws(() => state.receive("workspace-a", { type: "openmausbot:session-config", requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", config }));
  }
  assert.deepEqual(state.childEnvironment("workspace-a"), {});
});
