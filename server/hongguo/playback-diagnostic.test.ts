import { gzipSync } from "node:zlib";
import type { TransportResponse } from "openhongguo";
import { expect, it } from "vitest";
import { safeHttpFacts, safeSdkError } from "./playback-diagnostic.ts";

it("keeps only bounded allowlisted facts from a compressed hostile provider response", () => {
  const secret = "private-url-query-header-profile-episode-message";
  const encoded = gzipSync(Buffer.from(JSON.stringify({ status_code: 0,
    data: { video_model: "", url: secret, device_id: secret }, message: secret })));
  const response: TransportResponse = { status: 200, headers: { "content-encoding": "gzip",
    "set-cookie": secret, "x-private": secret }, cookies: { token: secret }, body: encoded };
  const facts = safeHttpFacts(response, "resolve");
  expect(facts).toEqual({ stage: "resolve", status: 200, encodedBytes: encoded.length,
    decodedBytes: Buffer.byteLength(JSON.stringify({ status_code: 0,
      data: { video_model: "", url: secret, device_id: secret }, message: secret })), encoding: "gzip",
    shape: { json: "object", businessStatus: "zero", data: "object", videoModel: "empty" } });
  expect(JSON.stringify(facts)).not.toContain(secret);
  expect(response.body).toEqual(encoded);
});

it("marks unobserved, invalid and oversized metadata unknown without copying it", () => {
  const secret = "private-error-text";
  expect(safeSdkError({ code: "ANONYMOUS_LIMITED", retryable: false, message: secret }))
    .toEqual({ code: "ANONYMOUS_LIMITED", retryable: false });
  expect(safeSdkError({ code: secret, retryable: secret, message: secret }))
    .toEqual({ code: "OTHER", retryable: null });
  expect(safeSdkError(null)).toEqual({ code: null, retryable: null });
  expect(safeHttpFacts({ status: 200, headers: {}, body: new Uint8Array() }, "resolve"))
    .toEqual({ stage: "resolve", status: 200, encodedBytes: 0, decodedBytes: 0, encoding: "absent",
      shape: { json: "empty", businessStatus: "missing", data: "missing", videoModel: "missing" } });
  const facts = safeHttpFacts({ status: 999, headers: { "content-encoding": secret },
    body: Buffer.alloc(64 * 1024 + 1) }, "series");
  expect(facts).toEqual({ stage: "series", status: null, encodedBytes: 64 * 1024 + 1,
    decodedBytes: null, encoding: "other", shape: null });
  expect(JSON.stringify(facts)).not.toContain(secret);
});
