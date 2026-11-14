import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findRetryEntry, loadRetryList, retriesInCi, testIdentity } from "./ci-retry-list.mjs";
import { retrySummary } from "./ci-retry-summary.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RUNNER = fileURLToPath(new URL("./ci-retry-runner.ts", import.meta.url));
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const list = loadRetryList({});

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("the known-flaky list", () => {
  it("names an existing test, an owner and a reason for every entry, once", () => {
    expect(list.length).toBeGreaterThan(0);
    for (const entry of list) {
      expect(Object.keys(entry).sort()).toEqual(["file", "owner", "reason", "since", "test"]);
      for (const value of Object.values(entry)) expect(value.trim()).not.toBe("");
      expect(entry.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(existsSync(join(ROOT, entry.file)), entry.file).toBe(true);
      // Each part of the name is a describe or test title in that file.
      const source = readFileSync(join(ROOT, entry.file), "utf8");
      for (const title of entry.test.split(" > ")) expect(source, `${entry.file}: ${title}`).toContain(JSON.stringify(title).slice(1, -1));
    }
    const keys = list.map((entry) => `${entry.file} :: ${entry.test}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("retries only in CI", () => {
    expect(retriesInCi({ CI: "true" })).toBe(true);
    expect(retriesInCi({ CI: "1" })).toBe(true);
    for (const CI of [undefined, "", "false", "0"]) expect(retriesInCi({ CI })).toBe(false);
  });

  it("matches a test by its file and its full name, nothing looser", () => {
    const file = { filepath: join(ROOT, "server", "boat-included.test.ts") };
    const suite = { name: "waking a sleeping computer", suite: file, filepath: undefined as unknown as string };
    delete (suite as { filepath?: string }).filepath;
    const task = (name: string, parent: object = suite) => ({ name, file, suite: parent as never });
    const listed = testIdentity(ROOT, task("forgets a server error once a later resume is accepted"));
    expect(listed).toEqual({ file: "server/boat-included.test.ts", test: "waking a sleeping computer > forgets a server error once a later resume is accepted" });
    expect(findRetryEntry(list, listed)?.owner).toBeTruthy();
    expect(findRetryEntry(list, testIdentity(ROOT, task("reports the last server error, not a bare timeout, when the wait runs out on it")))).toBeUndefined();
    // the same title outside its describe block is another test
    expect(findRetryEntry(list, testIdentity(ROOT, task("forgets a server error once a later resume is accepted", file)))).toBeUndefined();
  });
});

describe("the job summary", () => {
  it("lists each retried test with its owner, and warns about it", () => {
    const entry = list[0]!;
    const log = [
      JSON.stringify({ file: entry.file, test: entry.test, retries: 1, state: "pass", platform: "win32" }),
      JSON.stringify({ file: "server/x.test.ts", test: "a > b", retries: 2, state: "fail", platform: "linux" }),
      "not json",
    ].join("\n");
    const { markdown, annotations } = retrySummary(log, list);
    expect(markdown).toContain("### Flaky tests that needed a retry");
    expect(markdown).toContain(`| \`${entry.file}\` > ${entry.test.replace(/\|/g, "\\|")} | 1 | passed on a retry | ${entry.owner} |`);
    expect(markdown).toContain("| `server/x.test.ts` > a > b | 2 | failed every attempt | unlisted |");
    expect(annotations).toHaveLength(2);
    expect(annotations[0]).toMatch(new RegExp(`^::warning file=${entry.file.replace(/[.]/g, "\\.")},title=Flaky test retried::`));
  });

  it("reports an unreadable list as a warning, apart from the retries", () => {
    const log = `${JSON.stringify({ listError: "the flaky-test list could not be read, so no test is retried: boom" })}\n${JSON.stringify({ listError: "the flaky-test list could not be read, so no test is retried: boom" })}\n`;
    const { markdown, annotations } = retrySummary(log, list);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatch(/^::warning title=Flaky-test list unreadable::/);
    expect(markdown).toContain("The flaky-test list could not be read");
    expect(markdown).not.toContain("needed a retry");
  });

  it("says nothing when no test needed a retry", () => {
    expect(retrySummary("", list)).toEqual({ markdown: "", annotations: [] });
  });
});

describe("the runner", () => {
  /** A one-file vitest project: a listed test that fails its first attempt. */
  function project() {
    const directory = mkdtempSync(join(tmpdir(), "omb-ci-retry-"));
    scratch.push(directory);
    writeFileSync(join(directory, "flaky.test.mjs"), [
      'import { existsSync, writeFileSync } from "node:fs";',
      'const marker = new URL("./attempted", import.meta.url);',
      'describe("group", () => {',
      '  it("fails once", () => { if (!existsSync(marker)) { writeFileSync(marker, ""); throw new Error("first attempt"); } });',
      '  it("fails always", () => { throw new Error("unlisted"); });',
      "});",
      "",
    ].join("\n"));
    writeFileSync(join(directory, "vitest.config.mjs"), `export default { test: { globals: true, include: ["flaky.test.mjs"], runner: ${JSON.stringify(RUNNER)} } };\n`);
    writeFileSync(join(directory, "list.json"), JSON.stringify({ tests: [{ file: "flaky.test.mjs", test: "group > fails once", owner: "o", reason: "r", since: "2026-10-08" }] }));
    return directory;
  }

  async function vitest(directory: string, env: Record<string, string | undefined>, stopAt?: string) {
    const childEnv: Record<string, string | undefined> = { ...process.env, OMB_VITEST_RETRY_LIST: join(directory, "list.json"), OMB_VITEST_RETRY_LOG: join(directory, "retries.jsonl"), ...env };
    for (const [key, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[key];
    return new Promise<{ code: number; output: string; stopped: boolean }>((resolve) => {
      let stopped = false;
      let observed = "";
      const child = execFile(process.execPath, [VITEST, "run", "--config", join(directory, "vitest.config.mjs"), "--reporter=json"], { cwd: directory, env: childEnv as NodeJS.ProcessEnv, encoding: "utf8", timeout: stopAt ? 10_000 : 60_000, killSignal: stopAt ? "SIGKILL" : "SIGTERM" },
        (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, output: `${stdout}\n${stderr}`, stopped }));
      if (stopAt) child.stderr?.on("data", (chunk: string) => {
        observed += chunk;
        if (!stopped && observed.includes(stopAt)) {
          stopped = true;
          child.kill("SIGKILL");
        }
      });
    });
  }

  const results = (output: string) => {
    const report = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
    return Object.fromEntries(report.testResults[0].assertionResults.map((test: { title: string; status: string }) => [test.title, test.status]));
  };

  const filePhases = (output: string) => [...output.matchAll(/^\[ci-file\] (collect|run|complete) ([a-zA-Z0-9_./-]+) (\d+)ms$/gm)]
    .map((match) => ({ phase: match[1], file: match[2], elapsed: Number(match[3]) }));

  it("retries a listed test in CI, records it, and leaves other tests alone", async () => {
    const directory = project();
    const { output } = await vitest(directory, { CI: "true" });
    expect(results(output)).toEqual({ "fails once": "passed", "fails always": "failed" });
    const lines = readFileSync(join(directory, "retries.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([{ file: "flaky.test.mjs", test: "group > fails once", retries: 1, state: "pass", platform: process.platform }]);
    const phases = filePhases(output);
    expect(phases.map(({ phase, file }) => [phase, file])).toEqual(["collect", "run", "complete"].map((phase) => [phase, "flaky.test.mjs"]));
    expect(phases.map(({ elapsed }) => elapsed)).toEqual(phases.map(({ elapsed }) => elapsed).sort((a, b) => a - b));
    expect(phases.every(({ elapsed }) => Number.isInteger(elapsed) && elapsed >= 0)).toBe(true);
  }, 60_000);

  it.each(["collect", "run"])("exposes an unfinished file's %s phase before final results exist", async (phase) => {
    const directory = project();
    const hold = 'writeSync(2, "fixture suspended\\n"); await new Promise(() => {});';
    writeFileSync(join(directory, "flaky.test.mjs"), `import { writeSync } from "node:fs";\n${phase === "collect" ? hold : `it("pending", async () => { ${hold} });`}\n`);
    writeFileSync(join(directory, "vitest.config.mjs"), `export default { test: { globals: true, pool: "threads", maxWorkers: 1, include: ["flaky.test.mjs"], runner: ${JSON.stringify(RUNNER)} } };\n`);
    const { output, stopped } = await vitest(directory, { CI: "true" }, "fixture suspended\n");
    expect(stopped).toBe(true);
    expect(output).not.toContain('"testResults"');
    const phases = filePhases(output);
    expect(phases.map(({ phase: value, file }) => [value, file])).toEqual((phase === "collect" ? ["collect"] : ["collect", "run"]).map((value) => [value, "flaky.test.mjs"]));
    expect(existsSync(join(directory, "retries.jsonl"))).toBe(false);
  }, 30_000);

  it("stops retrying a file's listed tests once one of them fails every attempt", async () => {
    // A broken fixture, not a flake: three attempts of every listed test
    // would multiply the shard's time past its job cap.
    const directory = mkdtempSync(join(tmpdir(), "omb-ci-retry-"));
    scratch.push(directory);
    writeFileSync(join(directory, "broken.test.mjs"), [
      'import { appendFileSync } from "node:fs";',
      'const attempt = (name) => appendFileSync(new URL("./attempts", import.meta.url), `${name}\\n`);',
      'it("first", () => { attempt("first"); throw new Error("broken"); });',
      'it("second", () => { attempt("second"); throw new Error("broken"); });',
      "",
    ].join("\n"));
    writeFileSync(join(directory, "vitest.config.mjs"), `export default { test: { globals: true, include: ["broken.test.mjs"], runner: ${JSON.stringify(RUNNER)} } };\n`);
    writeFileSync(join(directory, "list.json"), JSON.stringify({ tests: ["first", "second"].map((test) => ({ file: "broken.test.mjs", test, owner: "o", reason: "r", since: "2026-10-08" })) }));
    const { output } = await vitest(directory, { CI: "true" });
    expect(results(output)).toEqual({ first: "failed", second: "failed" });
    expect(readFileSync(join(directory, "attempts"), "utf8").trim().split("\n")).toEqual(["first", "first", "first", "second"]);
  }, 60_000);

  it("reads its own list in a happy-dom test file, where the global URL is the DOM's", async () => {
    // A jsdom/happy-dom file must still load the default list. Beside
    // node_modules so happy-dom resolves, outside Vitest's excluded dependency tree.
    const directory = mkdtempSync(join(ROOT, ".omb-ci-retry-"));
    scratch.push(directory);
    writeFileSync(join(directory, "dom.test.mjs"), 'it("runs in a DOM", () => { expect(typeof document).toBe("object"); });\n');
    writeFileSync(join(directory, "vitest.config.mjs"), `export default { test: { globals: true, environment: "happy-dom", include: ["dom.test.mjs"], runner: ${JSON.stringify(RUNNER)} } };\n`);
    const { code, output } = await vitest(directory, { CI: "true", OMB_VITEST_RETRY_LIST: undefined });
    expect(output).not.toContain("Unhandled");
    expect(results(output)).toEqual({ "runs in a DOM": "passed" });
    expect(code).toBe(0);
    // the list really loaded: the runner records nothing when it can read it
    expect(existsSync(join(directory, "retries.jsonl"))).toBe(false);
  }, 60_000);

  it("runs every test without retries when the list cannot be read", async () => {
    const directory = project();
    const { output } = await vitest(directory, { CI: "true", OMB_VITEST_RETRY_LIST: join(directory, "missing.json") });
    expect(output).not.toContain("Unhandled");
    expect(results(output)).toEqual({ "fails once": "failed", "fails always": "failed" });
    const logged = readFileSync(join(directory, "retries.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(logged).toEqual([{ listError: expect.stringContaining("the flaky-test list could not be read") }]);
  }, 60_000);

  it("never retries outside CI", async () => {
    const directory = project();
    const { output } = await vitest(directory, { CI: undefined });
    expect(results(output)).toEqual({ "fails once": "failed", "fails always": "failed" });
    expect(existsSync(join(directory, "retries.jsonl"))).toBe(false);
    expect(filePhases(output)).toEqual([]);
  }, 60_000);

  it("retains naming mismatch evidence in JSON when Vitest truncates its error message", async () => {
    const directory = project();
    writeFileSync(join(directory, "flaky.test.mjs"), [
      'it("equality", () => expect("Restart mymausbot").toBe("Restart MausBot"));',
      'it("contains", () => expect("<section>" + "x".repeat(100) + "Fully quit mymausbot</section>").toContain("Fully quit MausBot"));',
      'it("object", () => expect({name: "mymausbot", version: 2}).toEqual({name: "MausBot", version: 2}));',
      'it("auth", () => expect(200).toBe(403));',
      'it("literal operation", () => expect("choose to include mymausbot").toBe("MausBot"));',
      'it("hidden behavior", () => { const deep = (value) => Array.from({length: 25}).reduce((nested) => ({nested}), value); expect({name: "mymausbot", data: deep(403)}).toEqual({name: "MausBot", data: deep(200)}); });',
      'it("non-string error", () => { throw {message: 200}; });',
    ].join("\n"));
    const { output, code } = await vitest(directory, { CI: undefined });
    expect(code).toBe(1);
    const data = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
    const cases = data.testResults[0].assertionResults;
    expect(cases.map((entry: any) => entry.meta.qaTextChange)).toEqual([
      { from: "MausBot", to: "mymausbot" }, { from: "MausBot", to: "mymausbot" }, undefined, undefined, undefined, undefined, undefined,
    ]);
    expect(cases.every((entry: any) => entry.status === "failed")).toBe(true);
  }, 60_000);
});
