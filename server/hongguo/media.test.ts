import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Playback } from "openhongguo";
import { afterEach, expect, it, vi } from "vitest";
import { compatibleStream, HongguoMedia } from "./media.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const playback = (): Playback => ({ episode_id: "101", protected: false,
  streams: [{ url: "https://v.douyinvod.com/clip.mp4", codec: "h264", protected: false, width: 720, height: 1280 }] });

it("only accepts browser-compatible single-file streams and supported encryption", () => {
  const model = playback();
  expect(compatibleStream(model)).toBe(model.streams[0]);
  expect(compatibleStream({ ...model, audio_url: "https://v.douyinvod.com/audio" })).toBeUndefined();
  expect(compatibleStream({ ...model, protected: true })).toBeUndefined();
  for (const patch of [{ hls: true }, { dash: true }, { codec: "hevc" }, { url: "http://127.0.0.1/" }]) {
    expect(compatibleStream({ ...model, streams: [{ ...model.streams[0]!, ...patch }] })).toBeUndefined();
  }
});

it("serves scoped ranges, expires tokens and removes only its disposable files after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "hongguo-media-test-")); roots.push(root);
  await mkdir(join(root, "play-old"));
  await writeFile(join(root, "keep.txt"), "not a cache entry");
  let now = 100;
  const media = new HongguoMedia(root, async () => Buffer.from("0123456789"), () => now);
  const scope = { appId: "a", revision: 1 };
  const token = (await media.prepare(playback(), undefined, scope))!;
  expect(await readdir(root)).toContain("keep.txt");
  expect(await readdir(root)).not.toContain("play-old");
  const signal = new AbortController().signal;
  expect((await media.serve(token, undefined, signal, { appId: "b", revision: 1 })).status).toBe(404);
  expect((await media.serve(token, undefined, signal, { appId: "a", revision: 2 })).status).toBe(404);
  const part = await media.serve(token, "bytes=2-5", signal, scope);
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
  expect(await part.text()).toBe("2345");
  expect((await media.serve(token, "bytes=99-", signal, scope)).status).toBe(416);
  now += 60 * 60_000;
  expect((await media.serve(token, undefined, signal, scope)).status).toBe(404);
});

it("does not download encrypted media without a key or leak a failed cache file", async () => {
  const root = await mkdtemp(join(tmpdir(), "hongguo-media-test-")); roots.push(root);
  const load = vi.fn(async () => { throw new Error("offline"); });
  const media = new HongguoMedia(root, load);
  const model = playback(); model.protected = true; model.streams[0]!.encryption = "cenc-aes-ctr";
  expect(await media.prepare(model, undefined, { appId: "a", revision: 1 })).toBeNull();
  expect(load).not.toHaveBeenCalled();
  await expect(media.prepare(playback(), undefined, { appId: "a", revision: 1 })).rejects.toThrow("offline");
  expect(await readdir(root)).toEqual([]);
});

it.skipIf(spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0)("prepares a synthetic CENC MP4 into decodable browser media", async () => {
  const root = await mkdtemp(join(tmpdir(), "hongguo-media-test-")); roots.push(root);
  const input = join(root, "encrypted.mp4");
  const key = "0123456789abcdef0123456789abcdef";
  const generated = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=0.2",
    "-c:v", "libx264", "-encryption_scheme", "cenc-aes-ctr", "-encryption_key", key,
    "-encryption_kid", "abcdef0123456789abcdef0123456789", input]);
  expect(generated.status, generated.stderr?.toString()).toBe(0);
  const media = new HongguoMedia(join(root, "cache"), () => readFile(input));
  const model = playback(); model.protected = true; model.streams[0]!.encryption = "cenc-aes-ctr";
  const scope = { appId: "a", revision: 1 };
  const token = (await media.prepare(model, key, scope))!;
  const result = await media.serve(token, undefined, new AbortController().signal, scope);
  expect(result.status).toBe(200);
  const output = join(root, "decrypted.mp4");
  await writeFile(output, Buffer.from(await result.arrayBuffer()));
  const decoded = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-i", output, "-f", "null", "-"]);
  expect(decoded.status, decoded.stderr?.toString()).toBe(0);
});
