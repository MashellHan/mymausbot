import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalUsageGithubReader } from "./local-usage-github.ts";
import { createLocalUsageProvider } from "./local-usage.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { localUsageView } from "../src/lib/local-usage-view.ts";

const now = Date.parse("2026-11-09T08:24:11Z");
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await removeTempDir(folder); });
function syntheticCapture() {
  return JSON.parse(execFileSync("python3", ["-c", [
    "import json,runpy,sys; sys.path.insert(0,'scripts')",
    "fixture=runpy.run_path('scripts/local_usage_github.test.py')",
    "print(json.dumps(fixture['collect']()))",
  ].join("; ")], { encoding: "utf8" }));
}
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "mausbot-profile-"));
  folders.push(folder);
  const file = join(folder, "github-profile-v1.json"), raw = syntheticCapture();
  raw.capturedAt = raw.asOfAt;
  await writeFile(file, JSON.stringify(raw));
  return { file, raw, read: createLocalUsageGithubReader(file, () => now) };
}

describe("GitHub Profile source contract", () => {
  it("reads the Python capture without rebinning commit buckets or certifying the nonfork PR subset", async () => {
    const { read, raw } = await fixture();
    expect(raw.sources[0].days.at(-1)).toMatchObject({ rawPrs: 1, knownPrs: 1, excludedForkPrs: 0 });
    const result = await read();
    expect(result).toMatchObject({ status: "partial", metricDefinition: "github-profile-v1",
      qualification: "nonfork-at-capture", chinaCommitAlignment: "unknown", sourceCoverage: { ready: 1 },
      windows: { "1": { prs: null, knownPrs: 1, commits: null, knownCommits: 100 },
        "7": { knownPrs: 2, knownCommits: 107, missingDays: [], comparison: { prs: null, commits: null } },
        "30": { prs: null, commits: null, knownCommits: 107 } } });
    expect(result!.windows!["30"].missingDays).toHaveLength(23);
    expect(result!.trend.at(-2)).toMatchObject({ day: "2026-11-08", knownPrs: 1, knownCommits: 7 });
    expect(result!.trend[0]).toMatchObject({ prs: null, commits: null, knownCommits: null, coverage: "unavailable" });
    expect(result!.windows!["7"].repositories.rows[0]).toMatchObject({ name: "sample/project", knownPrs: 2, knownCommits: 107, commits: null });
  });

  it("keeps Profile source and Tokens independent through the actual provider and view", async () => {
    const { file } = await fixture();
    const local = join(file, "..", "latest.json");
    const counts = { prs: 999, knownPrs: 999, commits: 999, newTokens: 10, cacheRead: 20,
      input: 5, output: 5, cacheWrite: 0, reasoning: 0 };
    await writeFile(local, JSON.stringify({ version: 1, updatedAt: now, timeZone: "Asia/Shanghai", status: "ready",
      sources: [{ status: "ok" }], prSources: [], prCoverage: { work: "ready", personal: "ready", unclassified: "ready" }, daily: [{ day: "2026-11-09", tokenStatus: "ready",
        categories: { work: counts, personal: { ...counts, input: 0, output: 0, newTokens: 0, cacheRead: 0 }, unclassified: { ...counts, input: 0, output: 0, newTokens: 0, cacheRead: 0 } } }] }));
    const provider = createLocalUsageProvider({ file: local, mergedFile: join(file, "..", "absent.json"), githubFile: file, now: () => now });
    const response = await provider.get();
    const view = localUsageView(response);
    expect(view.windows!["1"]).toMatchObject({ knownPrs: 1, knownCommits: 100, commits: null, totalTokens: 30 });
    expect(view.trend.at(-1)).toMatchObject({ knownPrs: 1, knownCommits: 100, totalTokens: 30 });
    expect(response.windows!["1"].commits).toBe(2997);
    const onlyGithub = await createLocalUsageProvider({ file: join(file, "..", "no-local.json"), githubFile: file,
      mergedFile: join(file, "..", "no-merged.json"), now: () => now }).get();
    expect(localUsageView(onlyGithub).windows!["1"]).toMatchObject({ knownPrs: 1, totalTokens: null });
  });

  it("rejects malformed or mixed definitions and preserves only an already observed stream as stale", async () => {
    const { file, raw, read } = await fixture();
    await read();
    const cases = [
      (value: typeof raw) => { value.metricDefinition = "merged-v1"; },
      (value: typeof raw) => { value.dateBasis.commits = "Asia/Shanghai"; },
      (value: typeof raw) => { value.qualification = "event-time-certified"; },
      (value: typeof raw) => { value.activeSourceIds.push(value.activeSourceIds[0]); },
      (value: typeof raw) => { value.sources[0].days.at(-1).profileCommits = 0; },
      (value: typeof raw) => { value.sources[0].days.at(-1).repositories[0].profileCommits = null; },
      (value: typeof raw) => { value.sources[0].days.at(-1).rawPrs = 0; },
      (value: typeof raw) => { value.sources[0].days.at(-1).status = "ready"; },
      (value: typeof raw) => { value.sources[0].days.at(-1).knownPrs = true; },
      (value: typeof raw) => { value.sources[0].days.at(-1).day = "2026-02-30"; },
      (value: typeof raw) => { value.sources[0].days.push(value.sources[0].days[0]); },
      (value: typeof raw) => { value.sources[0].days.at(-1).repositories[0].name = "/private/local/path"; },
    ];
    for (const mutate of cases) {
      const invalid = structuredClone(raw); mutate(invalid);
      await writeFile(file, JSON.stringify(invalid));
      expect((await read())!.status).toBe("stale");
      expect(await createLocalUsageGithubReader(file, () => now)()).toBeUndefined();
    }
  });

  it("keeps inaccessible accounts unknown, explicit empty observations distinct, and old captures stale", async () => {
    const { file, raw, read } = await fixture();
    const second = structuredClone(raw.sources[0]);
    second.id = "a".repeat(64); second.status = "unavailable"; second.days = [];
    raw.sources.push(second); raw.activeSourceIds.push(second.id);
    await writeFile(file, JSON.stringify(raw));
    const partial = await read();
    expect(partial!.windows!["1"]).toMatchObject({ prs: null, knownPrs: 1, commits: null, knownCommits: 100,
      missingDays: ["2026-11-09"] });
    expect(partial!.windows!["7"].categories.personal.knownCommits).toBe(107);
    expect(partial!.trend.at(-3)).toMatchObject({ knownPrs: 0, knownCommits: 0, coverage: "partial" });
    raw.sources[0].days = []; raw.sources[0].status = "unavailable";
    await writeFile(file, JSON.stringify(raw));
    const unknown = await createLocalUsageGithubReader(file, () => now)();
    expect(unknown).toMatchObject({ status: "unavailable", windows: { "1": { prs: null, commits: null, knownCommits: null } } });
    expect((await createLocalUsageGithubReader(file, () => now + 86_400_000)())!.status).toBe("unavailable");
    const fresh = syntheticCapture(); fresh.capturedAt = fresh.asOfAt;
    await writeFile(file, JSON.stringify(fresh));
    expect((await createLocalUsageGithubReader(file, () => now + 86_400_000)())!.status).toBe("stale");
  });
});
