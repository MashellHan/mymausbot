import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { resetPathCacheForTests } from "../env-path.ts";
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

it.skipIf(process.platform === "win32")("kills its own converter after an abort even when SIGTERM is ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hongguo-cover-abort-"));
  const pidFile = join(dir, "pid");
  const termFile = join(dir, "term");
  const oldExtraPath = process.env.OMB_EXTRA_PATH;
  const oldPidFile = process.env.OMB_COVER_PID_FILE;
  const oldTermFile = process.env.OMB_COVER_TERM_FILE;
  const controller = new AbortController();
  try {
    const executable = join(dir, "ffmpeg");
    await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
process.on("SIGTERM", () => fs.writeFileSync(process.env.OMB_COVER_TERM_FILE, "received"));
fs.writeFileSync(process.env.OMB_COVER_PID_FILE, String(process.pid));
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 10_000);
`);
    await chmod(executable, 0o700);
    process.env.OMB_EXTRA_PATH = [dir, oldExtraPath].filter(Boolean).join(delimiter);
    process.env.OMB_COVER_PID_FILE = pidFile;
    process.env.OMB_COVER_TERM_FILE = termFile;
    resetPathCacheForTests();

    const conversion = coverJpeg(Buffer.from("fixture"), controller.signal);
    void conversion.catch(() => {});
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    const pid = Number(await readFile(pidFile, "utf8"));
    controller.abort();
    await expect(conversion).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(existsSync(termFile)).toBe(true));
    await vi.waitFor(() => {
      try { process.kill(pid, 0); expect.fail("converter is still running"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }, { timeout: 7_000 });
  } finally {
    controller.abort();
    if (oldExtraPath === undefined) delete process.env.OMB_EXTRA_PATH; else process.env.OMB_EXTRA_PATH = oldExtraPath;
    if (oldPidFile === undefined) delete process.env.OMB_COVER_PID_FILE; else process.env.OMB_COVER_PID_FILE = oldPidFile;
    if (oldTermFile === undefined) delete process.env.OMB_COVER_TERM_FILE; else process.env.OMB_COVER_TERM_FILE = oldTermFile;
    resetPathCacheForTests();
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);
