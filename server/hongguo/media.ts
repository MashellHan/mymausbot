import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Playback, Stream } from "openhongguo";
import { parseAudioRange } from "../attachments.ts";
import { augmentedPath } from "../env-path.ts";
import { hongguoMediaBytes, hongguoUrl } from "./network.ts";

export interface HongguoMediaScope { appId: string; revision: number }
type MediaEntry = HongguoMediaScope & { path: string; directory: string; expiresAt: number };
const TTL_MS = 60 * 60_000;

export function compatibleStream(playback: Playback): Stream | undefined {
  if (playback.audio_url) return undefined;
  return playback.streams.filter((stream) => !stream.hls && !stream.dash && stream.url && hongguoUrl(stream.url, "media")
    && /^(h264|avc|avc1)(?:\.|$)/i.test(stream.codec ?? "")
    && (!(stream.protected || playback.protected) || stream.encryption === "cenc-aes-ctr"))
    .sort((a, b) => Math.abs((a.width ?? 0) * (a.height ?? 0) - 1280 * 720)
      - Math.abs((b.width ?? 0) * (b.height ?? 0) - 1280 * 720))[0];
}

async function decryptMedia(input: string, output: string, key: string): Promise<void> {
  if (!/^[\da-f]{32}$/i.test(key)) throw new Error("This episode's media is unavailable.");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-nostdin", "-v", "error", "-protocol_whitelist", "file", "-f", "mov",
      "-decryption_key", key, "-i", input, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
      "-movflags", "+faststart", "-f", "mp4", "-y", output], {
      stdio: "ignore", windowsHide: true, env: { ...process.env, PATH: augmentedPath() },
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("The media helper is unavailable.")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error("This episode could not be prepared for playback."));
    });
  });
}

export class HongguoMedia {
  private readonly entries = new Map<string, MediaEntry>();
  private active = 0;
  private readonly directory: string;
  private readonly load: typeof hongguoMediaBytes;
  private readonly now: () => number;
  private initialized?: Promise<void>;
  constructor(directory: string, load = hongguoMediaBytes, now = Date.now) {
    this.directory = directory;
    this.load = load;
    this.now = now;
  }

  async prepare(playback: Playback, key: string | undefined, scope: HongguoMediaScope): Promise<string | null> {
    const stream = compatibleStream(playback);
    const encrypted = Boolean(stream?.protected || playback.protected);
    if (!stream?.url || (encrypted && !key) || this.active >= 2) return null;
    this.active++;
    let directory: string | undefined;
    try {
      await (this.initialized ??= this.initialize());
      await this.expire();
      const bytes = await this.load(stream.url);
      directory = await mkdtemp(join(this.directory, "play-"));
      const input = join(directory, "source.mp4");
      await writeFile(input, bytes, { mode: 0o600 });
      const path = encrypted ? join(directory, "play.mp4") : input;
      if (encrypted) {
        await decryptMedia(input, path, key!);
        await rm(input);
      }
      const size = (await stat(path)).size;
      if (!size || size > 64 * 1024 * 1024) throw new Error("This episode's media is unavailable.");
      const token = randomUUID();
      this.entries.set(token, { ...scope, path, directory, expiresAt: this.now() + TTL_MS });
      while (this.entries.size > 4) await this.remove(this.entries.keys().next().value!);
      return token;
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true });
      throw error;
    } finally { this.active--; }
  }

  async serve(token: string, range: string | undefined, signal: AbortSignal, scope: HongguoMediaScope): Promise<Response> {
    const entry = this.entries.get(token);
    if (!entry || entry.appId !== scope.appId || entry.revision !== scope.revision || entry.expiresAt <= this.now()) {
      return new Response(null, { status: 404 });
    }
    const size = (await stat(entry.path)).size;
    const part = parseAudioRange(range, size);
    const headers: Record<string, string> = {
      "content-type": "video/mp4", "cache-control": "private, no-store", "accept-ranges": "bytes",
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'",
    };
    if (part.kind === "unsatisfiable") return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    const start = part.kind === "range" ? part.start : 0;
    const end = part.kind === "range" ? part.end : size - 1;
    headers["content-length"] = String(end - start + 1);
    if (part.kind === "range") headers["content-range"] = `bytes ${start}-${end}/${size}`;
    const stream = createReadStream(entry.path, { start, end, signal });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: part.kind === "range" ? 206 : 200, headers });
  }

  private async remove(token: string): Promise<void> {
    const entry = this.entries.get(token);
    this.entries.delete(token);
    if (entry) await rm(entry.directory, { recursive: true, force: true });
  }

  private async expire(): Promise<void> {
    for (const [token, entry] of this.entries) if (entry.expiresAt <= this.now()) await this.remove(token);
  }

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (entry.isDirectory() && /^play-[A-Za-z0-9]+$/.test(entry.name)) {
        await rm(join(this.directory, entry.name), { recursive: true, force: true });
      }
    }
  }
}
