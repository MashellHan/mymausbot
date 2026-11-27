import { utf8Bytes } from "./app.ts";

export const MINI_APP_RPC_MAX_PAYLOAD_BYTES = 64 * 1024;
export const MINI_APP_SDK_VERSION = 2;

export type MausAppErrorCode =
  | "INVALID_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "UNKNOWN_METHOD"
  | "UNAVAILABLE"
  | "REVISION_CONFLICT"
  | "RATE_LIMITED"
  | "UNDECLARED_QUERY"
  | "PERMISSION_DENIED"
  | "QUOTA_EXCEEDED"
  | "NOT_ENGAGED"
  | "CLOSED"
  | "INTERNAL_ERROR";

export const MINI_APP_RPC_METHODS = [
  "maus/query.batch",
  "maus/dashboard.read",
  "maus/media.read",
  "maus/kv.get",
  "maus/kv.set",
  "maus/kv.delete",
  "maus/action.invoke",
  "maus/site.show",
] as const;

export type MiniAppRpcMethod = typeof MINI_APP_RPC_METHODS[number];

export const MINI_APP_RPC_NOTIFICATIONS = [
  "maus/notifications/ready",
  "maus/notifications/selection",
  "maus/notifications/telemetry",
  "maus/notifications/data-changed",
  "maus/notifications/visibility-changed",
  "maus/notifications/host-selection",
  "maus/notifications/site-status",
] as const;

export type MiniAppRpcNotification = typeof MINI_APP_RPC_NOTIFICATIONS[number];

export interface MausAppRpcRequest<P = Record<string, unknown>> {
  jsonrpc: "2.0";
  id: string;
  method: MiniAppRpcMethod;
  params: P;
}

export interface MausAppRpcErrorObject {
  code: number;
  message: string;
  data?: {
    errorCode: MausAppErrorCode;
    status?: number;
  };
}

export interface MausAppRpcSuccessResponse<R = unknown> {
  jsonrpc: "2.0";
  id: string;
  result: R;
}

export interface MausAppRpcErrorResponse {
  jsonrpc: "2.0";
  id: string;
  error: MausAppRpcErrorObject;
}

export type MausAppRpcResponse<R = unknown> = MausAppRpcSuccessResponse<R> | MausAppRpcErrorResponse;

export interface MausAppRpcNotificationMessage<P = Record<string, unknown>> {
  jsonrpc: "2.0";
  method: MiniAppRpcNotification;
  params: P;
}

const KNOWN_METHODS = new Set<string>(MINI_APP_RPC_METHODS);
const KNOWN_NOTIFICATIONS = new Set<string>(MINI_APP_RPC_NOTIFICATIONS);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isMausRpcEnvelope(value: unknown): value is { jsonrpc: "2.0"; method: string } {
  return isPlainRecord(value)
    && value.jsonrpc === "2.0"
    && typeof value.method === "string"
    && value.method.startsWith("maus/");
}

export function parseMausRpcRequest(value: unknown):
  | { ok: true; request: MausAppRpcRequest }
  | { ok: false; id?: string; code: MausAppErrorCode; message: string } {
  if (!isPlainRecord(value) || value.jsonrpc !== "2.0") {
    return { ok: false, code: "INVALID_REQUEST", message: "Invalid JSON-RPC 2.0 envelope." };
  }
  const id = typeof value.id === "string" && value.id.length > 0 && value.id.length <= 100 ? value.id : undefined;
  if (!id) {
    return { ok: false, code: "INVALID_REQUEST", message: "A valid string request id is required." };
  }
  if (typeof value.method !== "string" || !KNOWN_METHODS.has(value.method)) {
    return { ok: false, id, code: "UNKNOWN_METHOD", message: "Unknown Mini App RPC method." };
  }
  const params = value.params === undefined ? {} : value.params;
  if (!isPlainRecord(params)) {
    return { ok: false, id, code: "INVALID_REQUEST", message: "RPC params must be an object." };
  }
  try {
    if (utf8Bytes(JSON.stringify(params)) > MINI_APP_RPC_MAX_PAYLOAD_BYTES) {
      return { ok: false, id, code: "PAYLOAD_TOO_LARGE", message: "RPC request payload exceeds the 64 KiB limit." };
    }
  } catch {
    return { ok: false, id, code: "INVALID_REQUEST", message: "RPC params could not be serialized." };
  }
  return {
    ok: true,
    request: {
      jsonrpc: "2.0",
      id,
      method: value.method as MiniAppRpcMethod,
      params,
    },
  };
}

export function parseMausRpcNotification(value: unknown): MausAppRpcNotificationMessage | null {
  if (!isPlainRecord(value) || value.jsonrpc !== "2.0" || value.id !== undefined) return null;
  if (typeof value.method !== "string" || !KNOWN_NOTIFICATIONS.has(value.method)) return null;
  const params = value.params === undefined ? {} : value.params;
  if (!isPlainRecord(params)) return null;
  try {
    if (utf8Bytes(JSON.stringify(params)) > MINI_APP_RPC_MAX_PAYLOAD_BYTES) return null;
  } catch {
    return null;
  }
  return {
    jsonrpc: "2.0",
    method: value.method as MiniAppRpcNotification,
    params,
  };
}

export function jsonRpcErrorCode(code: MausAppErrorCode): number {
  switch (code) {
    case "INVALID_REQUEST": return -32600;
    case "UNKNOWN_METHOD": return -32601;
    case "PAYLOAD_TOO_LARGE": return -32602;
    case "REVISION_CONFLICT": return -32009;
    case "RATE_LIMITED": return -32029;
    case "PERMISSION_DENIED":
    case "NOT_ENGAGED": return -32003;
    case "QUOTA_EXCEEDED": return -32013;
    case "UNDECLARED_QUERY": return -32004;
    case "CLOSED": return -32010;
    case "UNAVAILABLE": return -32053;
    default: return -32603;
  }
}

export function buildMausRpcSuccess<R>(id: string, result: R): MausAppRpcSuccessResponse<R> {
  return { jsonrpc: "2.0", id, result };
}

export function buildMausRpcError(
  id: string,
  errorCode: MausAppErrorCode,
  message: string,
  status?: number,
): MausAppRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: jsonRpcErrorCode(errorCode),
      message,
      data: { errorCode, ...(status !== undefined ? { status } : {}) },
    },
  };
}

export function mapStatusToMausErrorCode(status?: number): MausAppErrorCode {
  if (status === 400) return "INVALID_REQUEST";
  if (status === 401 || status === 403) return "PERMISSION_DENIED";
  if (status === 404) return "UNDECLARED_QUERY";
  if (status === 409) return "REVISION_CONFLICT";
  if (status === 413) return "PAYLOAD_TOO_LARGE";
  if (status === 429) return "RATE_LIMITED";
  if (status === 503) return "UNAVAILABLE";
  return "INTERNAL_ERROR";
}
