import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type { RequestOptions } from "node:https";
import type { TransportRequest } from "openhongguo";
import { afterEach, expect, it, vi } from "vitest";
import { hongguoTransport } from "./provider.ts";
import { hongguoMediaBytes, hongguoRequest, hongguoUrl } from "./network.ts";

const { lookup, request } = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("node:https", () => ({ request }));
afterEach(() => vi.resetAllMocks());

it("limits each resource to HTTPS provider hosts without credentials or custom ports", () => {
  expect(hongguoUrl("https://api.fqnovel.com/a", "api")?.hostname).toBe("api.fqnovel.com");
  expect(hongguoUrl("https://reading.snssdk.com/a", "api")).not.toBeNull();
  for (const raw of ["http://api.fqnovel.com", "https://fqnovel.com.evil.test", "https://user@api.fqnovel.com",
    "https://api.fqnovel.com:8443", "https://127.0.0.1", "https://api.fqnovel.com/#fragment"]) {
    expect(hongguoUrl(raw, "api")).toBeNull();
  }
  expect(hongguoUrl("https://v.douyinvod.com/video", "api")).toBeNull();
  expect(hongguoUrl("https://v5-ex-reading-video.qznovelvod.com/video", "media")?.hostname)
    .toBe("v5-ex-reading-video.qznovelvod.com");
  for (const raw of ["http://v5-ex-reading-video.qznovelvod.com/video", "https://qznovelvod.com.evil.test/video",
    "https://user@v5-ex-reading-video.qznovelvod.com/video", "https://v5-ex-reading-video.qznovelvod.com:8443/video",
    "https://v5-ex-reading-video.qznovelvod.com/video#fragment"]) expect(hongguoUrl(raw, "media")).toBeNull();
  expect(hongguoUrl("https://v5-ex-reading-video.qznovelvod.com/video", "api")).toBeNull();
});

it("passes an SDK-shaped signed POST through without hiding HTTP errors or decoding the body", async () => {
  lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  const body = Uint8Array.from([1, 2, 3]);
  const responseBody = Buffer.from([0x1f, 0x8b, 0, 0]);
  const write = vi.fn();
  const end = vi.fn();
  request.mockImplementation((_url: unknown, options: RequestOptions, done: (res: EventEmitter) => void) => {
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({ "x-signature": "synthetic", "content-type": "application/json" });
    const req = Object.assign(new EventEmitter(), { write, end: (sent?: Uint8Array) => {
      end(sent);
      const response = Object.assign(new EventEmitter(), { statusCode: 403, headers: {
        "content-encoding": "gzip", "set-cookie": ["sid=one; Path=/", "flag=two; HttpOnly"],
      } });
      done(response); response.emit("data", responseBody); response.emit("end"); req.emit("close");
    }, destroy: vi.fn() });
    return req;
  });
  const result = await hongguoTransport({ method: "POST", url: "https://api.fqnovel.com/play", headers: {
    "x-signature": "synthetic", "content-type": "application/json",
  }, body });
  expect(write).not.toHaveBeenCalled();
  expect(end).toHaveBeenCalledWith(body);
  expect(result).toEqual({ status: 403, headers: { "content-encoding": "gzip" },
    cookies: { sid: "one", flag: "two" }, body: responseBody });
});

it("rechecks an upstream media redirect into the observed qznovelvod CDN", async () => {
  lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  const mp4 = Buffer.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]);
  const hosts: string[] = [];
  request.mockImplementation((url: URL, _options: RequestOptions, done: (res: EventEmitter) => void) => {
    hosts.push(url.hostname);
    const req = Object.assign(new EventEmitter(), { write: vi.fn(), end: () => {
      const response = Object.assign(new EventEmitter(), hosts.length === 1
        ? { statusCode: 302, headers: { location: "https://v5-ex-reading-video.qznovelvod.com/clip.mp4" } }
        : { statusCode: 200, headers: {} });
      done(response); response.emit("data", hosts.length === 1 ? Buffer.alloc(0) : mp4);
      response.emit("end"); req.emit("close");
    }, destroy: vi.fn() });
    return req;
  });
  expect(await hongguoMediaBytes("https://v.douyinvod.com/clip.mp4")).toEqual(mp4);
  expect(hosts).toEqual(["v.douyinvod.com", "v5-ex-reading-video.qznovelvod.com"]);
  expect(lookup).toHaveBeenCalledTimes(2);
});

it("rejects private or mixed DNS answers before opening a socket", async () => {
  lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
  for (const [url, kind] of [["https://api.fqnovel.com/a", "api"],
    ["https://v5-ex-reading-video.qznovelvod.com/clip.mp4", "media"]] as const) {
    await expect(hongguoRequest(url, kind)).rejects.toThrow("address is unavailable");
  }
  expect(request).not.toHaveBeenCalled();
});

it("pins the checked address, preserves bytes and refuses redirected private hosts", async () => {
  lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  request.mockImplementation((_url: unknown, options: RequestOptions, done: (res: EventEmitter) => void) => {
    options.lookup!("ignored", {}, (error, address, family) => {
      expect(error).toBeNull(); expect(address).toBe("8.8.8.8"); expect(family).toBe(4);
    });
    const req = Object.assign(new EventEmitter(), { write: vi.fn(), end: () => {
      const response = Object.assign(new EventEmitter(), { statusCode: 302, headers: { location: "https://127.0.0.1/private" } });
      done(response); response.emit("data", Buffer.from([0x1f, 0x8b])); response.emit("end"); req.emit("close");
    }, destroy: vi.fn() });
    return req;
  });
  const result = await hongguoRequest("https://api.fqnovel.com/a", "api");
  expect(result.body).toEqual(Buffer.from([0x1f, 0x8b]));
  await expect(hongguoMediaBytes("https://v.douyinvod.com/video")).rejects.toThrow("unsupported address");
  expect(request).toHaveBeenCalledTimes(2);
});


it("sends an SDK-generated playback body with known-length framing", async () => {
  const sdk = await import("openhongguo");
  let signed: TransportRequest | undefined;
  const client = await sdk.createClient({ profile: sdk.memoryProfileStore(), retryAttempts: 1, deviceResets: 0,
    transport: async (input) => {
      const path = new URL(input.url).pathname;
      if (path === "/service/2/device_register/") return { status: 200, headers: {},
        cookies: { ttreq: "synthetic-ticket" }, body: Buffer.from(JSON.stringify({ new_user: 1,
          device_id_str: "7000000000000000001", install_id_str: "7000000000000000002" })) };
      if (path === "/novel/player/video_model/v1/") {
        signed = input;
        return { status: 200, headers: {}, body: new Uint8Array() };
      }
      throw new Error("Unexpected synthetic SDK request.");
    },
  });
  await expect(client.resolvePlayback("7100000000000201")).rejects.toMatchObject({ code: "ANONYMOUS_LIMITED" });
  expect(signed).toBeDefined();
  expect(signed!.method).toBe("POST");
  expect(new URL(signed!.url).pathname).toBe("/novel/player/video_model/v1/");
  expect(signed!.body.byteLength).toBeGreaterThan(0);

  lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
  let sameUrl = false;
  let sameHeaders = false;
  let endedBody: Uint8Array | undefined;
  const written: Uint8Array[] = [];
  request.mockImplementation((url: URL, options: RequestOptions, done: (res: EventEmitter) => void) => {
    sameUrl = digest(url.href) === digest(signed!.url);
    sameHeaders = digest(JSON.stringify(options.headers)) === digest(JSON.stringify(signed!.headers));
    expect(options.method).toBe("POST");
    const req = Object.assign(new EventEmitter(), { write: (body: Uint8Array) => written.push(body),
      end: (body?: Uint8Array) => {
        endedBody = body;
        const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
        done(response); response.emit("end"); req.emit("close");
      }, destroy: vi.fn() });
    return req;
  });
  const response = await hongguoTransport(signed!);
  expect(response.status).toBe(200);
  expect(request.mock.calls.length).toBe(1);
  expect(sameUrl).toBe(true);
  expect(sameHeaders).toBe(true);
  expect(written.length).toBe(0);
  expect(endedBody?.byteLength).toBe(signed!.body.byteLength);
  expect(digest(endedBody!)).toBe(digest(signed!.body));
});
