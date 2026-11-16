import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { coverJpeg, HongguoCovers } from "./cover.ts";

const signed = "https://p3-reading-sign.fqnovelpic.com/novel-pic/poster.heic?x-expires=1800000300&x-signature=synthetic";

it("keeps signed cover validation, image bounds and a short decoded cache", async () => {
  let now = 1_800_000_000_000;
  const image = Buffer.from("synthetic heic");
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const load = vi.fn(async () => ({ status: 200, headers: { "content-type": "image/heic" }, body: image }));
  const convert = vi.fn(async () => jpeg);
  const covers = new HongguoCovers(load, convert, () => now);
  expect(await covers.get(signed)).toBe(jpeg);
  expect(await covers.get(signed)).toBe(jpeg);
  expect(load).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledWith(signed, "image", expect.objectContaining({ maxBytes: 2 * 1024 * 1024 }));
  now += 121_000;
  expect(await covers.get(signed)).toBe(jpeg);
  expect(load).toHaveBeenCalledTimes(2);
  now += 180_000;
  await expect(covers.get(signed)).rejects.toThrow("expired");
  await expect(covers.get("http://127.0.0.1/private")).rejects.toThrow("address");
  await expect(covers.get(signed.replace("1800000300", "999999999999999999999"))).rejects.toThrow("address");
  expect(load).toHaveBeenCalledTimes(2);
  expect(convert).toHaveBeenCalledTimes(2);
});

it("rejects a redirected private host and non-image bytes before conversion", async () => {
  const convert = vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const redirect = new HongguoCovers(vi.fn(async () => ({ status: 302,
    headers: { location: "https://127.0.0.1/private" }, body: Buffer.alloc(0) })), convert);
  await expect(redirect.get(signed)).rejects.toThrow("address");
  const html = new HongguoCovers(vi.fn(async () => ({ status: 200,
    headers: { "content-type": "text/html" }, body: Buffer.from("<html>") })), convert);
  await expect(html.get(signed)).rejects.toThrow("unavailable");
  expect(convert).not.toHaveBeenCalled();
});

it.skipIf(spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0)(
  "converts a real HEIC fixture to a browser-supported JPEG without an external URL", async () => {
    const heic = await readFile(fileURLToPath(new URL("./fixtures/poster.heic", import.meta.url)));
    const jpeg = await coverJpeg(heic);
    expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    const decoded = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-i", "pipe:0", "-f", "null", "-"], { input: jpeg });
    expect(decoded.status, decoded.stderr?.toString()).toBe(0);
  });
