import { openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Socket } from "node:net";
import { createInterface } from "node:readline";
import { dockerCommand } from "./fake-compose-docker.mjs";

const [dir, transport] = process.argv.slice(2);
// Node 26.9 filesystem reads on idle FIFOs block shutdown; a libuv pipe handle does not.
const input = new Socket({ fd: openSync(join(transport, "requests"), "r+"), readable: true, writable: false });
const requests = createInterface({ input })[Symbol.asyncIterator]();
const responses = openSync(join(transport, "responses"), "r+");
const reply = (line) => writeSync(responses, `${line}\n`);
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stdout.write("ready\n");

class TransportError extends Error {}

async function next() {
  let timer;
  try {
    const line = await Promise.race([
      requests.next(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new TransportError("fake Docker transport timed out")), 5_000); }),
    ]);
    if (line.done) throw new TransportError("fake Docker transport closed");
    return line.value;
  } finally { clearTimeout(timer); }
}

function request() {
  const path = join(transport, "request");
  if (statSync(path).size > 256 * 1024) throw new Error("fake Docker request is too large");
  const fields = readFileSync(path, "utf8").split("\0");
  if (fields.pop() !== "") throw new Error("unterminated fake Docker request");
  const [cwd, mask, count, ...rest] = fields;
  if (!cwd?.startsWith("/") || !/^[0-7]{3,4}$/.test(mask) || !/^\d{1,4}$/.test(count)) throw new Error("invalid fake Docker request");
  const length = Number(count);
  if (rest.length < length) throw new Error("missing fake Docker arguments");
  const args = rest.slice(0, length);
  const env = Object.fromEntries(rest.slice(length).map((field) => {
    const at = field.indexOf("=");
    if (at < 1) throw new Error("invalid fake Docker environment");
    return [field.slice(0, at), field.slice(at + 1)];
  }));
  if (env.FAKE_DOCKER_DIR !== dir) throw new Error("fake Docker fixture mismatch");
  return { cwd, mask: parseInt(mask, 8), args, env };
}

try {
  while (true) {
    const line = await requests.next();
    if (line.done) break;
    if (line.value !== "run") throw new Error("unknown fake Docker request");
    const current = request();
    const oldMask = process.umask(current.mask);
    let stdout = "";
    let stderr = "";
    let status;
    try {
      status = await dockerCommand({
        dir, ...current,
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
        readStdin: async () => {
          reply("stdin");
          if (await next() !== "stdin-done") throw new TransportError("invalid fake Docker stdin response");
        },
        execute: async (entry, args) => {
          writeFileSync(join(transport, "exec"), [entry, ...args, ""].join("\0"), { mode: 0o600 });
          reply("exec");
          const response = await next();
          if (response === "exit null") return null;
          if (!/^exit (0|[1-9]\d{0,2})$/.test(response) || Number(response.slice(5)) > 255) throw new TransportError("invalid fake Docker exec response");
          return Number(response.slice(5));
        },
      });
    } catch (error) {
      if (error instanceof TransportError) throw error;
      stderr += `${error.stack ?? error}\n`;
      status = 1;
    } finally { process.umask(oldMask); }
    if (!Number.isInteger(status) || status < 0 || status > 255) throw new Error("invalid fake Docker command status");
    writeFileSync(join(transport, "stdout"), stdout, { mode: 0o600 });
    writeFileSync(join(transport, "stderr"), stderr, { mode: 0o600 });
    reply(`done ${status}`);
    if (await next() !== "release") throw new TransportError("invalid fake Docker release");
    unlinkSync(join(transport, "busy"));
    reply("released");
  }
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 125;
  process.stdin.destroy();
  input.destroy();
  process.exit(125);
}
