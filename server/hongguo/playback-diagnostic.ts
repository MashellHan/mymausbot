import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { ErrorCode, TransportResponse } from "openhongguo";

export type PlaybackStage = "series" | "selection" | "resolve" | "media";
export type PlaybackReason = "anonymous-limited" | "episode-unavailable" | "provider-unavailable";

const MAX_INSPECT_BYTES = 64 * 1024;
const SDK_CODES = new Set<ErrorCode>([
  "INVALID_OPTIONS", "PROFILE_NOT_FOUND", "SIGNER_UNAVAILABLE", "AUTHENTICATION_REQUIRED", "NOT_PROTECTED",
  "DRM_PROTECTED", "ANONYMOUS_LIMITED", "RATE_LIMITED", "TRANSPORT", "SIGNATURE_REJECTED",
  "CONTENT_UNAVAILABLE", "PARAM_INVALID", "CHALLENGE_REQUIRED", "DEVICE_REJECTED", "END_OF_LIST",
  "ALBUM_UNAVAILABLE", "UNKNOWN",
]);

type Shape = "missing" | "null" | "object" | "array" | "other";
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const shape = (value: unknown, present: boolean): Shape => !present ? "missing" : value === null ? "null"
  : Array.isArray(value) ? "array" : object(value) ? "object" : "other";
const videoModelShape = (value: unknown, present: boolean): "missing" | "null" | "empty" | "present" => {
  if (!present) return "missing";
  if (value === null) return "null";
  if (typeof value === "string" || Array.isArray(value)) return value.length ? "present" : "empty";
  if (object(value)) return Object.keys(value).length ? "present" : "empty";
  return "present";
};

function responseShape(bytes: Buffer): {
  json: "object" | "array" | "other" | "empty";
  businessStatus: "zero" | "nonzero" | "missing" | "other";
  data: Shape;
  videoModel: "missing" | "null" | "empty" | "present";
} | null {
  if (!bytes.length) return { json: "empty", businessStatus: "missing", data: "missing", videoModel: "missing" };
  try {
    const root: unknown = JSON.parse(bytes.toString("utf8"));
    if (!object(root)) return { json: Array.isArray(root) ? "array" : "other", businessStatus: "missing",
      data: "missing", videoModel: "missing" };
    const business = Object.hasOwn(root, "status_code") ? root.status_code : root.code;
    const businessStatus = business === undefined ? "missing" : typeof business !== "number" || !Number.isSafeInteger(business)
      ? "other" : business === 0 ? "zero" : "nonzero";
    const data = shape(root.data, Object.hasOwn(root, "data"));
    const source = object(root.data) && Object.hasOwn(root.data, "video_model") ? root.data : root;
    const present = Object.hasOwn(source, "video_model");
    const videoModel = videoModelShape(source.video_model, present);
    return { json: "object", businessStatus, data, videoModel };
  } catch { return null; }
}

export function safeHttpFacts(response: TransportResponse, stage: PlaybackStage) {
  const rawEncoding = response.headers["content-encoding"]?.trim().toLowerCase();
  const encoding = rawEncoding === undefined ? "absent" : rawEncoding === "identity" || rawEncoding === "gzip"
    || rawEncoding === "br" || rawEncoding === "deflate" ? rawEncoding : "other";
  const encodedBytes = response.body.byteLength;
  let decoded: Buffer | null = null;
  if (encodedBytes <= MAX_INSPECT_BYTES) {
    try {
      const body = Buffer.from(response.body);
      decoded = encoding === "gzip" ? gunzipSync(body, { maxOutputLength: MAX_INSPECT_BYTES })
        : encoding === "br" ? brotliDecompressSync(body, { maxOutputLength: MAX_INSPECT_BYTES })
          : encoding === "deflate" ? inflateSync(body, { maxOutputLength: MAX_INSPECT_BYTES })
            : encoding === "absent" || encoding === "identity" ? body : null;
    } catch { decoded = null; }
  }
  return {
    stage,
    status: Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null,
    encodedBytes,
    decodedBytes: decoded?.byteLength ?? null,
    encoding,
    shape: decoded ? responseShape(decoded) : null,
  };
}

export function safeSdkError(error: unknown): { code: ErrorCode | "OTHER" | null; retryable: boolean | null } {
  try {
    if (!object(error)) return { code: null, retryable: null };
    const code = error.code;
    return { code: typeof code === "string" ? SDK_CODES.has(code as ErrorCode) ? code as ErrorCode : "OTHER" : null,
      retryable: typeof error.retryable === "boolean" ? error.retryable : null };
  } catch { return { code: null, retryable: null }; }
}
