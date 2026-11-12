import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeDocker } from "./fake-compose-fixture.ts";

const owned: Array<{ root: string; docker?: ReturnType<typeof startFakeDocker> }> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const fixture of owned.splice(0)) {
    try { await (await fixture.docker)?.close(); }
    catch (error) { errors.push(error); continue; }
    try { rmSync(fixture.root, { recursive: true, force: true }); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "fake Docker guard cleanup failed");
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omb-fake-compose-"));
  const entry: (typeof owned)[number] = { root };
  owned.push(entry);
  const fake = join(root, "fake");
  const deploy = join(root, "deploy");
  for (const path of [fake, deploy, join(root, "bin")]) mkdirSync(path);
  const state = {
    composeReadsPin: true, defaultImage: "old", images: [{ id: "old", refs: ["old"], local: true, engine: true, lastWords: "" }],
    containers: { omb: { id: "one", image: "old", status: "running" } },
  };
  const save = () => writeFileSync(join(fake, "state.json"), JSON.stringify(state));
  save();
  const starting = startFakeDocker(root, fake);
  entry.docker = starting;
  const docker = await starting;
  const env = { PATH: `${join(root, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: root, FAKE_DOCKER_DIR: fake, BASH_ENV: docker.shellInit };
  const run = (args: string[], input = "", extra: Record<string, string | undefined> = {}) => spawnSync("bash", ["-c", 'docker "$@"', "bash", ...args], {
    cwd: deploy, env: { ...env, ...extra }, input, encoding: "utf8", timeout: 10_000,
  });
  return { root, fake, deploy, state, save, docker, env, run, entry };
}

describe.skipIf(process.platform === "win32")("fixture-owned Docker interpreter", () => {
  it("keeps standalone and sourced command results equivalent without changing the caller shell", async () => {
    const box = await fixture();
    box.state.images[0]!.lastWords = "\0first\0last\n\n";
    box.save();
    for (const args of [["compose", "logs"], ["unknown", "a b\n'quote'"], ["run", "--entrypoint", "sh", "image", "-c", 'printf "%s\\n" "$SYNTHETIC_VALUE"; exit 7']]) {
      const env = { ...box.env, SYNTHETIC_VALUE: "unchanged\n'quoted'" };
      const native = spawnSync(join(box.root, "bin", "docker"), args, { cwd: box.deploy, env, input: "kept\n", encoding: "utf8", timeout: 10_000 });
      const sourced = box.run(args, "kept\n", { SYNTHETIC_VALUE: env.SYNTHETIC_VALUE });
      for (const key of ["status", "signal", "stdout", "stderr", "error"] as const) expect(sourced[key]).toEqual(native[key]);
    }
    const caller = spawnSync("bash", ["-c", 'before=$(pwd); docker unknown >/dev/null 2>&1; status=$?; [ "$before" = "$PWD" ] && [ -z "${transport+x}" ] && printf "caller:%s\\n" "$status"'], { cwd: box.deploy, env: box.env, encoding: "utf8", timeout: 10_000 });
    expect(caller.status).toBe(0);
    expect(caller.stdout).toBe("caller:64\n");
  });

  it("reloads state and caller cwd/environment, without sharing another fixture's state", async () => {
    const one = await fixture();
    const two = await fixture();
    expect(statSync(one.docker.transport).mode & 0o777).toBe(0o700);
    expect(statSync(join(one.docker.transport, "requests")).isFIFO()).toBe(true);
    expect(one.run(["compose", "ps", "-aq", "omb"]).stdout).toBe("one\n");
    one.state.containers.omb.id = "two";
    one.save();
    expect(one.run(["compose", "ps", "-aq", "omb"]).stdout).toBe("two\n");
    expect(two.run(["compose", "ps", "-aq", "omb"]).stdout).toBe("one\n");
    writeFileSync(join(one.deploy, ".env"), "OMB_IMAGE=from-file\n");
    expect(one.run(["compose", "config"]).stdout).toBe("services:\n  omb:\n    image: from-file\n");
    expect(one.run(["compose", "config"], "", { OMB_IMAGE: "from-env" }).stdout).toBe("services:\n  omb:\n    image: from-env\n");
    expect(one.run(["compose", "config"], "", { OMB_IMAGE: "" }).stdout).toBe("services:\n  omb:\n    image: old\n");
    const unusualImage = "line one\n'quoted'=\"double\"\\backslash %s\n";
    expect(one.run(["compose", "config"], "", { OMB_IMAGE: unusualImage }).stdout).toBe(`services:\n  omb:\n    image: ${unusualImage}\n`);
    expect(one.run(["compose", "config"]).stdout).toBe("services:\n  omb:\n    image: from-file\n");
    const unknown = one.run(["unknown", "a b\n'quote'"]);
    expect(unknown.status).toBe(64);
    expect(unknown.stderr).toBe("fake docker: unknown command: unknown a b\n'quote'\n");
    one.state.images[0]!.lastWords = "\0first\0last\n\n";
    one.save();
    expect(one.run(["compose", "logs"]).stdout).toBe("\0first\0last\n\n\n");
  });

  it("keeps stdin out of framing and consumes it only for the command that reads it", async () => {
    const box = await fixture();
    const command = (args: string) => spawnSync("bash", ["-c", `docker ${args}; IFS= read -r answer; printf 'remaining=%s\\n' "$answer"`], {
      cwd: box.deploy, env: box.env, input: "answer\n", encoding: "utf8", timeout: 10_000,
    });
    expect(command("compose ps -aq omb").stdout).toBe("one\nremaining=answer\n");
    expect(command("compose exec omb openmausbot doctor").stdout).toBe("ready\nremaining=\n");
    const binary = "\0first\0last\n\n";
    const remaining = (args: string) => spawnSync("bash", ["-c", `docker ${args} >/dev/null; cat`], {
      cwd: box.deploy, env: box.env, input: binary, encoding: "utf8", timeout: 10_000,
    });
    expect(remaining("compose ps -aq omb").stdout).toBe(binary);
    expect(remaining("compose exec omb openmausbot doctor").stdout).toBe("");
    const script = 'IFS= read -r answer; printf "%s:%s\\n" "$answer" "$SYNTHETIC_VALUE"; printf "%s:%s:%s\\n" "${EMPTY_VALUE+x}" "$EMPTY_VALUE" "${UNSET_VALUE+x}"; pwd; exit 7';
    const value = "v 'quoted'\n=\"double\"\\backslash %s\n";
    const real = box.run(["run", "--entrypoint", "sh", "image", "-c", script], "kept\n", { SYNTHETIC_VALUE: value, EMPTY_VALUE: "" });
    expect(real.status).toBe(7);
    expect(real.stdout).toBe(`kept:${value}\nx::\n${realpathSync(box.deploy)}\n`);
    expect(real.stderr).toBe("helper exited 7\n");
    const missing = box.run(["run", "--entrypoint", "no-such-fixture-command", "image"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe("helper exited null\n");
  });

  it.each([undefined, "", "another-fixture"])("refuses fixture identity %s and reaps its child", async (identity) => {
    const box = await fixture();
    const result = box.run(["compose", "ps", "-aq", "omb"], "", { FAKE_DOCKER_DIR: identity });
    expect(result.status).toBe(125);
    expect(existsSync(join(box.fake, "calls.log"))).toBe(false);
    await expect(box.docker.close()).rejects.toThrow("fake Docker fixture mismatch");
    expect(box.docker.child.exitCode).toBe(125);
    expect(() => process.kill(box.docker.child.pid!, 0)).toThrow();
    box.entry.docker = undefined;
  });

  it("exits on owner EOF and refuses calls after its exact child is reaped", async () => {
    const box = await fixture();
    await box.docker.close();
    expect(box.docker.child.exitCode).toBe(0);
    expect(() => process.kill(box.docker.child.pid!, 0)).toThrow();
    const result = box.run(["compose", "ps", "-aq", "omb"]);
    expect(result.status).toBe(125);
    expect(result.stderr).toContain("interpreter unavailable");
    expect(existsSync(join(box.fake, "calls.log"))).toBe(false);
  });

  it("refuses an unknown response without treating it as command success", async () => {
    const box = await fixture();
    const inject = spawnSync("bash", ["-c", 'exec 4<>"$1/responses"; printf "unknown\\n" >&4', "bash", box.docker.transport], { encoding: "utf8", timeout: 5_000 });
    expect(inject.status).toBe(0);
    const result = box.run(["compose", "ps", "-aq", "omb"]);
    expect(result.status).toBe(125);
    expect(result.stderr).toContain("unknown response");
    const later = box.run(["compose", "ps", "-aq", "omb"]);
    expect(later.status).toBe(125);
    expect(later.stderr).toContain("interpreter transport failed");
  });

  it("refuses an invalid release acknowledgement and all later calls", async () => {
    const box = await fixture();
    writeFileSync(join(box.docker.transport, "stdout"), "");
    writeFileSync(join(box.docker.transport, "stderr"), "");
    const inject = spawnSync("bash", ["-c", 'exec 4<>"$1/responses"; printf "done 0\\nunknown\\n" >&4', "bash", box.docker.transport], { encoding: "utf8", timeout: 5_000 });
    expect(inject.status).toBe(0);
    const result = box.run(["compose", "ps", "-aq", "omb"]);
    expect(result.status).toBe(125);
    expect(result.stderr).toContain("invalid release response");
    expect(box.run(["compose", "ps", "-aq", "omb"]).status).toBe(125);
  });

  it("reports malformed transport and retains its child's cleanup failure", async () => {
    const box = await fixture();
    const inject = spawnSync("bash", ["-c", 'exec 3<>"$1/requests"; printf "bad\\n" >&3', "bash", box.docker.transport], { encoding: "utf8", timeout: 5_000 });
    expect(inject.status).toBe(0);
    if (box.docker.child.exitCode === null) await once(box.docker.child, "close");
    await expect(box.docker.close()).rejects.toThrow("unknown fake Docker request");
    expect(box.docker.child.exitCode).toBe(125);
    expect(() => process.kill(box.docker.child.pid!, 0)).toThrow();
    box.entry.docker = undefined;
  });

  it("refuses a fixture whose command shim cannot be installed", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-fake-setup-"));
    owned.push({ root });
    const fake = join(root, "fake");
    mkdirSync(fake);
    await expect(startFakeDocker(root, fake)).rejects.toThrow("ENOENT");
  });
});
