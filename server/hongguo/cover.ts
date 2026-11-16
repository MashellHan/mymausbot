import { spawn } from "node:child_process";
import { augmentedPath } from "../env-path.ts";
import { hongguoRequest, hongguoUrl } from "./network.ts";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_JPEG_BYTES = 1024 * 1024;
const CACHE_MS = 2 * 60_000;

function coverAddress(raw: string, now: number): { url: string; expiresAt: number } {
  const url = raw.length <= 2048 ? hongguoUrl(raw, "image") : null;
  if (!url) throw new Error("This cover address is unavailable.");
  const expiries = url.searchParams.getAll("x-expires");
  if (expiries.length > 1 || expiries.length === 1 && !/^\d{10,}$/.test(expiries[0]!)) {
    throw new Error("This cover address is unavailable.");
  }
  const expirySeconds = expiries.length ? Number(expiries[0]) : null;
  if (expirySeconds !== null && !Number.isSafeInteger(expirySeconds)) throw new Error("This cover address is unavailable.");
  const signedExpiry = expirySeconds === null ? Infinity : expirySeconds * 1000;
  if (signedExpiry <= now) throw new Error("This cover has expired.");
  return { url: url.href, expiresAt: Math.min(now + CACHE_MS, signedExpiry) };
}

export async function coverJpeg(bytes: Buffer, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-nostdin", "-v", "error", "-protocol_whitelist", "pipe", "-i", "pipe:0",
      "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=400:600:force_original_aspect_ratio=decrease",
      "-c:v", "mjpeg", "-q:v", "3", "-f", "image2", "pipe:1"], {
      stdio: ["pipe", "pipe", "ignore"], windowsHide: true, signal,
      env: { ...process.env, PATH: augmentedPath() },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JPEG_BYTES) { exceeded = true; child.kill("SIGKILL"); }
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => {});
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const jpeg = Buffer.concat(chunks);
      if (code !== 0 || timedOut || exceeded || jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
        reject(new Error("This cover could not be decoded."));
      } else resolve(jpeg);
    });
    child.stdin.end(bytes);
  });
}

export class HongguoCovers {
  private readonly cache = new Map<string, { bytes: Buffer; expiresAt: number }>();
  private readonly requestImage: typeof hongguoRequest;
  private readonly convert: typeof coverJpeg;
  private readonly now: () => number;

  constructor(requestImage: typeof hongguoRequest = hongguoRequest,
    convert: typeof coverJpeg = coverJpeg, now: () => number = Date.now) {
    this.requestImage = requestImage;
    this.convert = convert;
    this.now = now;
  }

  async get(raw: string, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    const address = coverAddress(raw, this.now());
    const cached = this.cache.get(address.url);
    if (cached && cached.expiresAt > this.now()) return cached.bytes;
    const deadline = AbortSignal.timeout(8_000);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let url = address.url;
    for (let hop = 0; hop < 3; hop++) {
      url = coverAddress(url, this.now()).url;
      const result = await this.requestImage(url, "image", { maxBytes: MAX_SOURCE_BYTES, signal: requestSignal });
      if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
        url = new URL(result.headers.location, url).href;
        continue;
      }
      const type = String(result.headers["content-type"] ?? "").split(";", 1)[0].toLowerCase();
      if (result.status !== 200 || !["image/heic", "image/heif", "image/jpeg", "image/png", "image/webp"].includes(type)
        || !result.body.length) throw new Error("This cover is unavailable.");
      const bytes = await this.convert(result.body, signal);
      signal?.throwIfAborted();
      this.cache.set(address.url, { bytes, expiresAt: address.expiresAt });
      while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
      return bytes;
    }
    throw new Error("This cover could not be reached.");
  }
}
