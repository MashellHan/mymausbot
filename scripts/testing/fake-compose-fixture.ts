import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function startFakeDocker(root: string, dir: string) {
  const transport = mkdtempSync(join(dir, ".docker-pipes-"));
  chmodSync(transport, 0o700);
  const pipes = spawnSync("mkfifo", ["-m", "600", join(transport, "requests"), join(transport, "responses")], { encoding: "utf8" });
  if (pipes.error || pipes.status !== 0) throw new Error(`fake Docker pipe setup failed: ${pipes.error ?? pipes.stderr}`);
  const child = spawn(process.execPath, [join(import.meta.dirname, "fake-compose-worker.mjs"), dir, transport], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root },
  });
  let errorText = "";
  child.stderr.on("data", (data: Buffer) => { errorText = (errorText + data.toString()).slice(-16_384); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  void closed.catch(() => {});
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forced = false;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      timer = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, 5_000);
      const result = await Promise.race([closed, new Promise<never>((_, reject) => {
        reapTimer = setTimeout(() => reject(new Error("fake Docker child could not be reaped")), 10_000);
      })]);
      if (forced || result.code !== 0 || result.signal) throw new Error(`fake Docker child failed: ${forced ? "cleanup deadline; " : ""}${result.code}/${result.signal}: ${errorText}`);
    } finally { clearTimeout(timer); clearTimeout(reapTimer); }
  })();
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fake Docker startup timed out")), 5_000);
    child.stdout.once("data", (data: Buffer) => {
      clearTimeout(timer);
      if (data.toString() === "ready\n") resolve();
      else reject(new Error("invalid fake Docker startup response"));
    });
    void closed.then(() => { clearTimeout(timer); reject(new Error(`fake Docker closed before startup: ${errorText}`)); }, (error) => { clearTimeout(timer); reject(error); });
  });
  void ready.catch(() => {});
  const shim = `#!/bin/bash
transport=${quote(transport)}
fail() { printf '%s\\n' "fake Docker transport: $*" >&2; { : > "$transport/failed"; } 2>/dev/null || :; exit 125; }
emit() {
  local chunk
  while IFS= read -r -d '' chunk; do printf '%s\\0' "$chunk" || return; done
  printf '%s' "$chunk"
}
kill -0 ${child.pid ?? 0} 2>/dev/null || fail 'interpreter unavailable'
[ ! -e "$transport/failed" ] || fail 'interpreter transport failed'
set -C
{ : > "$transport/busy"; } 2>/dev/null || fail 'another command owns the pipe'
set +C
exec 3<>"$transport/requests" 4<>"$transport/responses" || fail 'cannot open pipes'
umask > "$transport/mask" || fail 'cannot write mask'
IFS= read -r mask < "$transport/mask" || fail 'cannot read mask'
{
  printf '%s\\0' "$PWD" "$mask" "$#" "$@"
  if [ "\${OMB_IMAGE+x}" ]; then printf '%s\\0' "OMB_IMAGE=$OMB_IMAGE"; fi
  if [ "\${FAKE_DOCKER_DIR+x}" ]; then printf '%s\\0' "FAKE_DOCKER_DIR=$FAKE_DOCKER_DIR"; fi
} > "$transport/request" || fail 'cannot write request'
printf 'run\\n' >&3 || fail 'request pipe closed'
while IFS= read -r -t 5 -u 4 response; do
  case "$response" in
    stdin)
      while IFS= read -r -d '' chunk; do :; done 2>/dev/null || :
      printf 'stdin-done\\n' >&3 || fail 'stdin response pipe closed'
      ;;
    exec)
      ${quote(process.execPath)} ${quote(join(import.meta.dirname, "fake-compose-exec.mjs"))} "$transport/exec" || fail 'helper bridge failed'
      ;;
    'done '*)
      status=\${response#done }
      case "$status" in ''|*[!0-9]*) fail 'invalid status' ;; esac
      [ "$status" -le 255 ] || fail 'invalid status'
      [ -f "$transport/stdout" ] && [ -f "$transport/stderr" ] || fail 'missing output'
      emit < "$transport/stdout" || fail 'cannot read stdout'
      emit < "$transport/stderr" >&2 || fail 'cannot read stderr'
      printf 'release\\n' >&3 || fail 'release pipe closed'
      IFS= read -r -t 5 -u 4 response || fail 'release response closed or timed out'
      [ "$response" = released ] || fail 'invalid release response'
      exit "$status"
      ;;
    *) fail 'unknown response' ;;
  esac
done
fail 'response pipe closed or timed out'
`;
  try {
    const shellInit = join(transport, "shell.sh");
    writeFileSync(shellInit, `if [ -n "\${BASH_VERSION:-}" ]; then\ndocker() (\n${shim.slice(shim.indexOf("\n") + 1)}\n)\nfi\n`, { mode: 0o600 });
    writeFileSync(join(root, "bin", "docker"), shim, { mode: 0o755 });
    await ready;
    return { close, child, transport, shellInit };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "fake Docker startup and cleanup failed"); }
    throw error;
  }
}
