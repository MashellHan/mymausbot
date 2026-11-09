import { describe, expect, it, vi } from "vitest";
import { deliverReport, signature, testFindings } from "./report.mjs";

const change = { from: "MausBot", to: "mymausbot" };
const rootKey = signature(`text:${change.from}\0${change.to}`, "shared");
const stateOf = (issue: any) => JSON.parse(issue.body.match(/<!-- mausbot-qa-state (.+) -->/)[1]);

function finding(file = "src/menu.test.ts", platform = "linux") {
  return testFindings({ "vitest.json": JSON.stringify({ numTotalTests: 1, numFailedTests: 1, numPendingTests: 0,
    testResults: [{ name: file, assertionResults: [{ title: "uses the product name", status: "failed",
      failureMessages: ["expected mymausbot to equal MausBot"], meta: { qaTextChange: change } }] }] }) }, platform).findings[0];
}

const report = (runId: number, findings: any[] = [], passed: string[] = [], executionComplete = true) => ({
  runId, attempt: 1, sha: "a".repeat(40), finishedAt: "2026-11-09T01:00:00Z", url: `https://github.com/example/repo/actions/runs/${runId}`,
  findings, passed, executionComplete, deliveryComplete: false,
});

function fixture(issues: any[] = []) {
  const api = vi.fn(async (path: string, options: any = {}) => {
    if (path.startsWith("/issues?")) return structuredClone(issues);
    if (path === "/issues" && options.method === "POST") {
      const created = { number: issues.length + 1, state: "open", ...options.body };
      issues.push(created);
      return structuredClone(created);
    }
    const issue = issues.find((entry) => path === `/issues/${entry.number}`);
    if (!issue || options.method !== "PATCH") throw new Error(`Unexpected API request: ${path}`);
    Object.assign(issue, options.body);
    return structuredClone(issue);
  });
  return { issues, api, policy: { areas: [] } };
}

describe("one issue per product naming problem", () => {
  it("combines the first report across files and platforms and updates it without losing triage", async () => {
    const env = fixture();
    const cases = [finding(), finding("src/banner.test.ts"), finding("src/menu.test.ts", "win32")];
    const first = report(1, cases);
    await deliverReport(first, env);
    await deliverReport(first, env);
    expect(env.issues).toHaveLength(1);
    expect(first.findings).toHaveLength(3);
    expect(stateOf(env.issues[0])).toMatchObject({ key: rootKey, count: 1, caseKeys: cases.map((entry) => entry.key) });
    for (const entry of cases) expect(env.issues[0].body).toContain(`${entry.platform}\` · ${entry.contract}`);
    env.issues[0].body += "\nQA-Owner: mausbot-back\nQA-Next: update expectations\n";
    env.issues[0].labels = ["qa", "qa:triaged", "qa:p1", "owner:back", "qa:scope:global"];
    const added = finding("src/about.test.ts", "darwin");
    await deliverReport(report(2, [added]), env);
    expect(env.issues).toHaveLength(1);
    expect(stateOf(env.issues[0]).caseKeys).toEqual([...cases.map((entry) => entry.key), added.key]);
    expect(env.issues[0].body).toContain("QA-Next: update expectations");
    expect(env.issues[0].body).toContain("actions/runs/1");
    expect(env.issues[0].labels).toContain("qa:p1");
    expect(env.issues[0].labels).not.toContain("qa:untriaged");
  });

  it("requires all affected cases without retries, rejects stale reports and reopens the same issue", async () => {
    const env = fixture();
    const cases = [finding(), finding("src/banner.test.ts", "win32")], keys = cases.map((entry) => entry.key);
    const issue = () => env.issues[0];
    await deliverReport(report(1, cases), env);
    await deliverReport(report(2, [], keys.slice(0, 1)), env);
    expect(issue().labels).not.toContain("qa:verified");
    await deliverReport(report(3, [], keys, false), env);
    expect(issue().labels).not.toContain("qa:verified");
    await deliverReport(report(4, [{ ...cases[0], textChange: undefined, kind: "flake", retries: 1 }], keys), env);
    expect(env.issues).toHaveLength(1);
    expect(issue().labels).not.toContain("qa:verified");
    await deliverReport(report(5, [], keys), env);
    expect(issue().labels).toContain("qa:verified");
    expect(issue().state).toBe("open");
    issue().state = "closed";
    await deliverReport(report(4, cases), env);
    expect(issue().state).toBe("closed");
    await deliverReport(report(6, cases), env);
    expect(env.issues).toHaveLength(1);
    expect(issue().state).toBe("open");
    expect(issue().labels).not.toContain("qa:verified");
  });

  it("leaves unrelated failures separate and retries partial delivery without duplicate issues", async () => {
    const env = fixture();
    const unrelated = { ...finding("server/auth.test.ts"), textChange: undefined, assertion: "Expected 403, received 200" };
    const current = report(1, [finding(), finding("src/banner.test.ts"), unrelated]);
    let fail = true;
    const api = async (path: string, options?: any) => {
      if (path === "/issues" && env.issues.length === 1 && fail) { fail = false; throw new Error("interrupted"); }
      return env.api(path, options);
    };
    await expect(deliverReport(current, { ...env, api })).rejects.toThrow("interrupted");
    await deliverReport(current, { ...env, api });
    expect(env.issues).toHaveLength(2);
    expect(stateOf(env.issues[0]).caseKeys).toHaveLength(2);
    expect(stateOf(env.issues[1]).key).toBe(unrelated.key);
  });

  it("keeps existing consolidated cases and new cases on one parent without clearing pending members", async () => {
    const old = [finding("src/old-a.test.ts"), finding("src/old-b.test.ts", "win32")];
    const keys = old.map((entry) => entry.key);
    const issues: any[] = old.map((entry, index) => ({ number: index + 1, state: "closed", labels: ["qa", "qa:scope:global"],
      body: `<!-- mausbot-qa:${entry.key} -->\n<!-- mausbot-qa:start -->\n<!-- mausbot-qa-state ${JSON.stringify({ key: entry.key, area: "global", lastRun: "1:1" })} -->\nOld evidence\n<!-- mausbot-qa:end -->` }));
    issues.push({ number: 3, state: "open", labels: ["qa", "qa:scope:global"],
      body: `Existing shared naming cause.\n<!-- mausbot-qa-group ${JSON.stringify(keys)} -->\n<!-- mausbot-qa:${rootKey} -->\nQA-Next: verify all platforms` });
    const env = fixture(issues), added = finding("src/new.test.ts", "darwin");
    await deliverReport(report(2, [...old, added]), env);
    expect(issues).toHaveLength(3);
    expect(issues.slice(0, 2).every((entry) => entry.state === "closed")).toBe(true);
    expect(issues[2].body).toContain("QA-Next: verify all platforms");
    expect(stateOf(issues[2]).caseKeys).toEqual([...keys, added.key]);
    await deliverReport(report(3, [], [added.key]), env);
    expect(issues[2].labels).not.toContain("qa:verified");
    await deliverReport(report(4, [], [...keys, added.key]), env);
    expect(issues[2].labels).toContain("qa:verified");
    let writes = 0;
    const interrupted = async (path: string, options?: any) => {
      if (path === "/issues/3" && ++writes === 2) throw new Error("summary unavailable");
      return env.api(path, options);
    };
    await expect(deliverReport(report(5, [added]), { ...env, api: interrupted })).rejects.toThrow("summary unavailable");
    await deliverReport(report(5, [added]), env);
    expect(issues[2].labels).not.toContain("qa:verified");
    expect(issues[2].body).toContain('"runId":5');
  });
});
