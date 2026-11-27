import { describe, expect, it } from "vitest";
import {
  buildMausRpcError,
  buildMausRpcSuccess,
  isMausRpcEnvelope,
  mapStatusToMausErrorCode,
  MINI_APP_RPC_MAX_PAYLOAD_BYTES,
  parseMausRpcNotification,
  parseMausRpcRequest,
} from "./mini-app-rpc.ts";

describe("shared/mini-app-rpc", () => {
  it("validates well-formed JSON-RPC 2.0 maus/* requests", () => {
    const raw = { jsonrpc: "2.0", id: "mini:1", method: "maus/query.batch", params: { queries: [] } };
    expect(isMausRpcEnvelope(raw)).toBe(true);
    const parsed = parseMausRpcRequest(raw);
    expect(parsed).toEqual({
      ok: true,
      request: { jsonrpc: "2.0", id: "mini:1", method: "maus/query.batch", params: { queries: [] } },
    });
  });

  it("rejects unknown methods, invalid params, and oversized payloads (>64 KiB)", () => {
    expect(parseMausRpcRequest({ jsonrpc: "2.0", id: "m1", method: "maus/evil", params: {} })).toMatchObject({
      ok: false,
      id: "m1",
      code: "UNKNOWN_METHOD",
    });
    expect(parseMausRpcRequest({ jsonrpc: "2.0", id: "m2", method: "maus/kv.get", params: ["bad"] })).toMatchObject({
      ok: false,
      id: "m2",
      code: "INVALID_REQUEST",
    });
    const oversized = "x".repeat(MINI_APP_RPC_MAX_PAYLOAD_BYTES + 128);
    expect(parseMausRpcRequest({ jsonrpc: "2.0", id: "m3", method: "maus/kv.set", params: { data: oversized } })).toMatchObject({
      ok: false,
      id: "m3",
      code: "PAYLOAD_TOO_LARGE",
    });
  });

  it("parses maus/notifications/* frames and rejects requests with an id", () => {
    expect(parseMausRpcNotification({
      jsonrpc: "2.0",
      method: "maus/notifications/ready",
      params: {},
    })).toEqual({
      jsonrpc: "2.0",
      method: "maus/notifications/ready",
      params: {},
    });
    expect(parseMausRpcNotification({
      jsonrpc: "2.0",
      id: "not-a-notification",
      method: "maus/notifications/ready",
      params: {},
    })).toBeNull();
  });

  it("builds structured JSON-RPC responses and maps HTTP status codes", () => {
    expect(buildMausRpcSuccess("req-1", { ok: true })).toEqual({
      jsonrpc: "2.0",
      id: "req-1",
      result: { ok: true },
    });
    expect(buildMausRpcError("req-2", "REVISION_CONFLICT", "Stale revision", 409)).toEqual({
      jsonrpc: "2.0",
      id: "req-2",
      error: {
        code: -32009,
        message: "Stale revision",
        data: { errorCode: "REVISION_CONFLICT", status: 409 },
      },
    });
    expect(mapStatusToMausErrorCode(409)).toBe("REVISION_CONFLICT");
    expect(mapStatusToMausErrorCode(429)).toBe("RATE_LIMITED");
    expect(mapStatusToMausErrorCode(403)).toBe("PERMISSION_DENIED");
    expect(mapStatusToMausErrorCode(500)).toBe("INTERNAL_ERROR");
  });
});
