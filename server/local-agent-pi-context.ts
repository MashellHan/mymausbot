import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const PI_CONTEXT_KEY = "omb_pi_context_v1";
export const PI_CONTEXT_TTL_MS = 4_000;
const MAC_PYTHON = [
  "/Library/Developer/CommandLineTools/usr/bin/python3",
  "/Applications/Xcode.app/Contents/Developer/usr/bin/python3",
];
const START = /^[1-9]\d{0,15}:[0-9]{6}$/;

// Darwin's PROC_PIDTBSDINFO reports the start timeval at microsecond precision.
const MAC_START = `import ctypes as c, sys
class Info(c.Structure):
    _fields_ = [('head', c.c_uint32 * 12), ('names', c.c_char * 48),
                ('tail', c.c_uint32 * 6), ('sec', c.c_uint64), ('usec', c.c_uint64)]
pid = int(sys.argv[1])
info = Info()
read = c.CDLL('/usr/lib/libproc.dylib').proc_pidinfo
read.argtypes = [c.c_int, c.c_int, c.c_uint64, c.c_void_p, c.c_int]
read.restype = c.c_int
if read(pid, 3, 0, c.byref(info), c.sizeof(info)) == c.sizeof(info) and info.head[3] == pid and info.sec and info.usec < 1000000:
    print('%d:%06d' % (info.sec, info.usec))
`;

export type PiProcessStart = (pid: number) => Promise<string | null>;

export const readPiProcessStart: PiProcessStart = async (pid) => {
  if (process.platform !== "darwin" || !Number.isInteger(pid) || pid <= 0 || pid > 0x7fff_ffff) return null;
  const python = MAC_PYTHON.find(existsSync);
  if (!python) return null;
  try {
    const { stdout } = await execute(python, ["-I", "-S", "-B", "-c", MAC_START, String(pid)], {
      timeout: 1_000, encoding: "utf8", maxBuffer: 128,
    });
    const start = stdout.trim();
    return START.test(start) ? start : null;
  } catch { return null; }
};

export type PiContextBinding = {
  pane: string;
  sessionId: string;
  file: string;
  cwd: string;
  leaf: string;
  provider: string;
  model: string;
};

function digest(binding: PiContextBinding): string {
  const { pane, sessionId, file, cwd, leaf, provider, model } = binding;
  // The token is only emitted for a physical model, so selected and limits identities are equal.
  return createHash("sha256").update(JSON.stringify([pane, sessionId, file, cwd, leaf, provider, model]))
    .digest().subarray(0, 20).toString("base64url");
}

export function piContextToken(binding: PiContextBinding, pid: number, start: string, window: number, now: number): string | null {
  if (!START.test(start) || !Number.isInteger(pid) || pid <= 0 || pid > 0x7fff_ffff ||
      !Number.isSafeInteger(window) || window <= 0) return null;
  const [seconds, micros] = start.split(":");
  const encoded = [pid, Number(seconds), Number(micros), window, now + PI_CONTEXT_TTL_MS]
    .map((number) => number.toString(36)).join(".");
  const token = `${encoded}.${digest(binding)}`;
  return token.length <= 80 ? token : null;
}

export function parsePiContext(raw: unknown, binding: PiContextBinding, now: number) {
  if (typeof raw !== "string" || raw.length > 80) return null;
  const parts = raw.split(".");
  if (parts.length !== 6 || parts[5] !== digest(binding)) return null;
  const numbers = parts.slice(0, 5).map((part) => {
    const value = Number.parseInt(part, 36);
    return Number.isSafeInteger(value) && value.toString(36) === part ? value : NaN;
  });
  const [pid, seconds, micros, window, expires] = numbers as [number, number, number, number, number];
  if (!numbers.every(Number.isSafeInteger) || pid <= 0 || pid > 0x7fff_ffff || seconds <= 0 ||
      micros < 0 || micros >= 1_000_000 || window <= 0 || expires <= now || expires > now + PI_CONTEXT_TTL_MS) return null;
  return { pid, start: `${seconds}:${String(micros).padStart(6, "0")}`, window, expires };
}
