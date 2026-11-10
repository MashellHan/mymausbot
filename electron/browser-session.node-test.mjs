import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppBrowserSession, SESSION_CREDENTIAL_PARTITION } from "./browser-session.mjs";

test("session mode selects one nonpersistent Electron session without touching defaultSession", () => {
  const session = { id: "in-memory" };
  const calls = [];
  const electronSession = {
    get defaultSession() { throw new Error("persistent NetworkContextService must not be used"); },
    fromPartition: (partition, options) => { calls.push({ partition, options }); return session; },
  };
  const selected = createAppBrowserSession(electronSession, "session");
  assert.equal(selected(), session);
  assert.equal(selected(), session);
  assert.deepEqual(calls, [{ partition: SESSION_CREDENTIAL_PARTITION, options: { cache: false } }]);
  assert.equal(SESSION_CREDENTIAL_PARTITION.startsWith("persist:"), false);
});

test("the default mode keeps the existing persistent session", () => {
  const existing = { id: "default" };
  const selected = createAppBrowserSession({ defaultSession: existing, fromPartition: () => { throw new Error("unexpected"); } }, "system");
  assert.equal(selected(), existing);
  const privateFile = createAppBrowserSession({ defaultSession: existing, fromPartition: () => { throw new Error("unexpected"); } }, "private-file");
  assert.equal(privateFile(), existing);
});
