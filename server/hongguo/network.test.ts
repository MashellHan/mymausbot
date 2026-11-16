import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:https";
import { afterEach, expect, it, vi } from "vitest";
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
});

it("rejects private or mixed DNS answers before opening a socket", async () => {
  lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
  await expect(hongguoRequest("https://api.fqnovel.com/a", "api")).rejects.toThrow("address is unavailable");
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
