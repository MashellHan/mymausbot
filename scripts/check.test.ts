import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ciOutputs, FULL_SCOPE, readCheckPolicy, selectCheckPlan, selectCiScope } from "./ci-scope.mjs";
import { localChange } from "./check.mjs";

const policy = JSON.parse(readFileSync("scripts/testing/check-policy.json", "utf8"));
const admitted = { ...policy, areas: policy.areas.map((area: object) => ({ ...area, admitted: true })) };
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const plan = (files: string[], options: object = {}) => selectCheckPlan({ files, policy: admitted, mode: "tiered", qa: { healthy: true, blockedAreas: [] }, ...options });

describe("shared local and CI check policy", () => {
  it("keeps pilot areas in shadow until admitted and health permits reduction", () => {
    expect(readCheckPolicy()).toEqual(policy);
    const files = ["src/components/LocalUsagePanel.tsx"];
    expect(plan(files, { policy }).reduced).toBe(false);
    for (const mode of ["legacy", "shadow"]) expect(plan(files, { mode }).scope).toEqual(selectCiScope(files));
    const selected = plan(files);
    expect(selected.reduced).toBe(true);
    expect(selected.core).toEqual(expect.arrayContaining(policy.core));
    expect(selected.core).toContain("scripts/testing/local-dashboard-ui.e2e.test.ts");
    expect(ciOutputs(selected.scope, ["ubuntu-latest"]).vitest_matrix.include).toEqual([
      expect.objectContaining({ part: "core + affected", shards: 1, files: selected.core.join(" "), workers: 4 }),
    ]);
    for (const qa of [{ healthy: false }, { healthy: true, blockedAreas: ["usage"] }, { healthy: true, blockedAreas: ["global"] }]) {
      expect(plan(files, { qa }).scope).toEqual(selectCiScope(files));
    }
    expect(plan(files, { qa: { healthy: true, blockedAreas: ["agents"] } }).reduced).toBe(true);
  });

  it("combines affected areas but preserves the broader checks for known new files and deletions", () => {
    const both = plan(["src/components/LocalUsagePanel.tsx", "src/components/AgentTown.tsx"]);
    expect(both.fastAreas).toEqual(["usage", "agents"]);
    expect(both.core).toContain("src/components/AgentTeamPanel.auth.test.ts");
    for (const files of [["src/new-helper.ts"], ["src/components/LocalUsagePanel.tsx", "src/new-helper.ts"]]) {
      expect(plan(files)).toMatchObject({ full: false, reduced: false, scope: selectCiScope(files) });
    }
    expect(plan(["src/components/LocalUsagePanel.tsx"], { present: (file: string) => file !== "src/components/LocalUsagePanel.tsx" && existsSync(file) }).reduced).toBe(false);
  });

  it("makes unsafe, mixed sensitive, forced-full and policy changes require all platforms", () => {
    for (const files of [[], ["unknown/runtime.conf"], ["pnpm-lock.yaml"], ["scripts/testing/check-policy.json"], ["src/components/AgentTown.tsx", "server/request-auth.ts"], ["shared/local-dashboard.ts"]]) {
      expect(plan(files).scope).toEqual(FULL_SCOPE);
    }
    expect(plan(["src/components/AgentTown.tsx"], { labels: ["ci:full"] }).full).toBe(true);
    expect(plan(["src/components/AgentTown.tsx"], { labels: ["qa:repair"] }).full).toBe(true);
    expect(plan(["src/components/AgentTown.tsx"], { lines: ['+fetch("/api/private")'] }).full).toBe(true);
    expect(plan(["src/components/AgentTown.tsx"], { lines: ['-authorize(permission)'] }).full).toBe(true);
  });

  it("fails on missing tests and invalid policies without selecting an empty success", () => {
    expect(() => readCheckPolicy(JSON.stringify({ ...policy, core: [] }))).toThrow();
    expect(() => readCheckPolicy(JSON.stringify({ ...policy, core: ["server/missing.test.ts"] }))).toThrow();
    expect(() => readCheckPolicy(JSON.stringify({ ...policy, core: ["a.test.ts;curl bad"] }))).toThrow();
    expect(() => ciOutputs({ checks: ["core-tests"], files: [] }, ["ubuntu-latest"])).toThrow();
    expect(plan(["docs/verification/local-dashboard.md"]).edit).toContain("scripts/testing/verification-docs.test.ts");
  });

  it("includes the merge-base range, both rename sides, staged/unstaged changes and untracked source", () => {
    const directory = mkdtempSync(join(tmpdir(), "mausbot-check-")); temporary.push(directory);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid"); git("config", "commit.gpgsign", "false");
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src/old.ts"), "first\n");
    git("add", "."); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    renameSync(join(directory, "src/old.ts"), join(directory, "src/new.ts"));
    git("add", "."); git("commit", "-qm", "rename");
    writeFileSync(join(directory, "src/new.ts"), "staged\n"); git("add", ".");
    writeFileSync(join(directory, "src/new.ts"), "dirty\n");
    writeFileSync(join(directory, "src/untracked.ts"), "new\n");
    const before = localChange(base, directory);
    expect(before.files).toEqual(["src/new.ts", "src/old.ts", "src/untracked.ts"]);
    expect(before.dirty).toBe(true);
    writeFileSync(join(directory, "src/untracked.ts"), "changed\n");
    expect(localChange(base, directory).sourceHash).not.toBe(before.sourceHash);
  });

  it("refuses a passing local receipt when source changes during the command", () => {
    const directory = mkdtempSync(join(tmpdir(), "mausbot-check-receipt-")); temporary.push(directory);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid"); git("config", "commit.gpgsign", "false");
    for (const dir of ["server", "scripts/testing", "node_modules/vitest"]) mkdirSync(join(directory, dir), { recursive: true });
    writeFileSync(join(directory, ".gitignore"), ".omb-scratch\nnode_modules\n");
    writeFileSync(join(directory, "server/core.test.ts"), "");
    writeFileSync(join(directory, "scripts/guard.test.ts"), "");
    writeFileSync(join(directory, "scripts/testing/check-policy.json"), JSON.stringify({ version: 1, core: ["server/core.test.ts"], guards: ["scripts/guard.test.ts"], areas: [] }));
    writeFileSync(join(directory, "node_modules/vitest/vitest.mjs"), `import { writeFileSync } from "node:fs";
      const path = process.argv.find(arg => arg.startsWith("--outputFile.json=")).slice(18);
      writeFileSync(path, JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0 }));
      if (process.env.FIXTURE_CHANGE === "1") writeFileSync("server/core.test.ts", "changed");`);
    git("add", "."); git("commit", "-qm", "fixture");
    const script = fileURLToPath(new URL("./check.mjs", import.meta.url));
    const run = (change: string) => spawnSync(process.execPath, [script, "edit", "--base", "HEAD", "--test", "server/core.test.ts"], { cwd: directory, encoding: "utf8", env: { ...process.env, FIXTURE_CHANGE: change } });
    const stable = run("0");
    expect(stable.status, stable.stderr).toBe(0);
    const changed = run("1");
    expect(changed.status, changed.stderr).toBe(1);
    expect(changed.stderr).toContain("Source inputs changed during validation");
  });
});
