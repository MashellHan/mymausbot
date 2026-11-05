import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionConfigMemory } from "./session-config.mjs";

test("the App holds current config only in memory across utility-server restarts", () => {
  const current = createSessionConfigMemory();
  const secret = "synthetic-session-only-key";
  const snapshot = { openai: { key: secret }, instances: { synthetic: { driver: "customAcp", environment: { TOKEN: secret } } } };
  assert.deepEqual(current.childEnvironment("workspace-a"), {});
  assert.equal(current.receive("workspace-a", { type: "openmausbot:session-config", requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", config: snapshot }), true);
  snapshot.openai.key = "changed-after-message";
  const restartedServer = JSON.parse(current.childEnvironment("workspace-a").OMB_SESSION_CONFIG_JSON);
  assert.equal(restartedServer.openai.key, secret);
  assert.equal(restartedServer.instances.synthetic.environment.TOKEN, secret);
  assert.deepEqual(current.childEnvironment("workspace-b"), {}, "another local environment does not inherit credentials");
  assert.equal(current.receive("workspace-b", { type: "openmausbot:session-config", requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", config: { openai: { key: "other-workspace" } } }), true);
  assert.equal(JSON.parse(current.childEnvironment("workspace-a").OMB_SESSION_CONFIG_JSON).openai.key, secret);
  assert.equal(JSON.parse(current.childEnvironment("workspace-b").OMB_SESSION_CONFIG_JSON).openai.key, "other-workspace");
  assert.deepEqual(createSessionConfigMemory().childEnvironment("workspace-a"), {}, "a new App process forgets the snapshot");
});

test("the App rejects malformed or oversized private snapshots", () => {
  const state = createSessionConfigMemory();
  assert.equal(state.receive({ type: "unrelated", config: {} }), false);
  for (const config of [null, [], "secret", { huge: "x".repeat(1024 * 1024) }]) {
    assert.throws(() => state.receive("workspace-a", { type: "openmausbot:session-config", requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", config }));
  }
  assert.deepEqual(state.childEnvironment("workspace-a"), {});
});
