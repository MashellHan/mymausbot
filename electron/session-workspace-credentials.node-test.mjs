import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionWorkspaceCredentials } from "./session-workspace-credentials.mjs";

test("desktop keys follow only their owned environment through recovery", async () => {
  const memory = createSessionWorkspaceCredentials();
  const appIdentity = { phoneSecretPrivateKey: "synthetic-app-identity" };
  await memory.state("environment-a").update((keys) => ({ ...keys, xaiApiKey: "synthetic-a" }));
  assert.deepEqual(memory.forServer("environment-a", appIdentity), { ...appIdentity, xaiApiKey: "synthetic-a" });
  assert.deepEqual(memory.forServer("environment-b", appIdentity), appIdentity);
  await memory.state("environment-b").update((keys) => ({ ...keys, xaiApiKey: "synthetic-b" }));
  assert.equal(memory.forServer("environment-a", appIdentity).xaiApiKey, "synthetic-a");
  assert.equal(memory.forServer("environment-b", appIdentity).xaiApiKey, "synthetic-b");
  assert.equal(memory.forServer("environment-a", appIdentity).xaiApiKey, "synthetic-a", "the same environment recovers its key");
  assert.deepEqual(createSessionWorkspaceCredentials().forServer("environment-a", appIdentity), appIdentity, "a new App run forgets it");
});
