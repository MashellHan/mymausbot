import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeTcpState } from "./tcp-snapshot.ts";

test("summarizes only the exact loopback destination and keeps unused slots as observations", () => {
  const table = [
    "tcp4 0 0 127.0.0.1.49360 *.* LISTEN",
    "tcp4 0 0 127.0.0.1.51001 127.0.0.1.49360 TIME_WAIT",
    "tcp4 0 0 127.0.0.1.49360 127.0.0.1.51001 FIN_WAIT_2",
    "tcp4 0 0 127.0.0.1.51002 127.0.0.1.49360 ESTABLISHED",
    "tcp4 0 0 127.0.0.1.51003 127.0.0.1.49361 TIME_WAIT",
    "tcp6 0 0 ::1.51004 ::1.49360 TIME_WAIT",
  ].join("\n");
  assert.deepEqual(summarizeTcpState(table, 49360, { first: 51000, last: 51003 }), {
    destinationPort: 49360,
    listenerPresent: true,
    clientStates: { TIME_WAIT: 1, ESTABLISHED: 1 },
    serverStates: { FIN_WAIT_2: 1 },
    sourcePortsObserved: 2,
    sourcePortRange: { first: 51000, last: 51003 },
    sourcePortsObservedWithinRange: 2,
    sourcePortsUnobservedWithinRange: 2,
  });
  assert.equal(summarizeTcpState(table, 49360, null).sourcePortsUnobservedWithinRange, null);
});
