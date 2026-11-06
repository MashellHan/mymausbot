import { request, type IncomingHttpHeaders } from "node:http";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

type Reply = { status: number; headers: IncomingHttpHeaders; body: Buffer };

function rawGet(url: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers, signal: AbortSignal.timeout(10_000) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

it("compresses a paired phone's forwarded snapshot without delaying SSE or changing access", async () => {
  const fixture = await launchVerificationServer(process.env);
  const url = fixture.info.url;
  const forwarded = { "x-forwarded-for": "203.0.113.8", "x-forwarded-proto": "https" };
  const jsonRequest = async <T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> => {
    const response = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    expect(response.status).toBeLessThan(300);
    return response.json() as Promise<T>;
  };
  try {
    await jsonRequest("/api/bots", { name: "Snapshot fixture", description: "Synthetic phone snapshot — 中文 😀. ".repeat(90) });
    const invitation = await jsonRequest<{ credential: string }>("/api/auth/pairing", { scopes: ["client"] });
    const paired = await jsonRequest<{ token: string; device: { id: string } }>("/api/pair", { credential: invitation.credential, deviceName: "Fixture phone" }, forwarded);
    const phone = { ...forwarded, authorization: `Bearer ${paired.token}` };
    const snapshotUrl = url + "/api/bots?messages=50";

    const refused = await rawGet(snapshotUrl, { ...forwarded, "accept-encoding": "gzip" });
    expect(refused.status).toBe(403);
    const adminOnly = await fetch(url + "/api/auth/pairing", { headers: phone, signal: AbortSignal.timeout(5_000) });
    expect(adminOnly.status).toBe(403);

    const streamAbort = new AbortController();
    const stream = await fetch(url + "/api/events?screens=off", { headers: { ...phone, "accept-encoding": "gzip" },
      signal: AbortSignal.any([streamAbort.signal, AbortSignal.timeout(10_000)]) });
    try {
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toBe("text/event-stream");
      expect(stream.headers.get("content-encoding")).toBeNull();
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let firstFrame = "";
      while (!firstFrame.includes("\n\n")) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        firstFrame += decoder.decode(chunk.value, { stream: true });
      }
      expect(firstFrame).toContain('"kind":"hello"');

      const plain = await rawGet(snapshotUrl, { ...phone, "accept-encoding": "identity" });
      const compressed = await rawGet(snapshotUrl, { ...phone, "accept-encoding": "gzip, deflate, br" });
      expect(plain.status).toBe(200);
      expect(plain.body.length).toBeGreaterThan(1024);
      expect(compressed.status).toBe(200);
      expect(compressed.headers["content-encoding"]).toBe("gzip");
      expect(compressed.headers.vary).toContain("Accept-Encoding");
      expect(compressed.body.length).toBeLessThan(plain.body.length / 2);
      expect(gunzipSync(compressed.body)).toEqual(plain.body);

      const disabled = await rawGet(snapshotUrl, { ...phone, "accept-encoding": "gzip;q=0, *" });
      expect(disabled.headers["content-encoding"]).toBeUndefined();
      expect(disabled.body).toEqual(plain.body);
      const local = await rawGet(snapshotUrl, { "accept-encoding": "gzip" });
      expect(local.headers["content-encoding"]).toBeUndefined();
      expect(local.body).toEqual(plain.body);
    } finally { streamAbort.abort(); }

    const revoked = await fetch(url + "/api/auth/sessions/" + paired.device.id, { method: "DELETE", signal: AbortSignal.timeout(5_000) });
    expect(revoked.status).toBe(200);
    expect((await rawGet(snapshotUrl, { ...phone, "accept-encoding": "gzip" })).status).toBe(401);
  } finally { await fixture.close(); }
}, 60_000);
