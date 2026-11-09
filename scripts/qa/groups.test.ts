import { describe, expect, it, vi } from "vitest";
import { holdsFor } from "./contracts.mjs";
import { qaGroups } from "./groups.mjs";
import { queueItems } from "./queue.mjs";
import { deliverReport, signature } from "./report.mjs";

const keys = [signature("case A", "linux"), signature("case B", "win32")];
const labels = ["qa", "qa:triaged", "qa:p1", "qa:scope:global", "qa:kind:product", "owner:back"];
const policy = { areas: [] };

function fixture() {
  const issues: any[] = keys.map((key, index) => ({
    number: index + 1, state: "closed", labels: [...labels],
    body: `<!-- mausbot-qa:${key} -->\n\n<!-- mausbot-qa:start -->\n\n<!-- mausbot-qa-state ${JSON.stringify({ key, area: "global", firstSeen: "2026-11-01T00:00:00Z", triageEpoch: "2026-11-01T00:00:00Z", count: 1, lastRun: "1:1", lastExecution: "1:1" })} -->\n\nOriginal failure\n\n<!-- mausbot-qa:end -->\n\nConsolidated into #3; original evidence retained.`,
  }));
  const parent = { number: 3, state: "open", labels: [...labels], body: `Confirmed shared cause.\n\n<!-- mausbot-qa-group ${JSON.stringify(keys)} -->\n\nQA-Owner: mausbot-back\nQA-Next: verify each platform\nQA-Due: 2026-11-10T00:00:00Z` };
  issues.push(parent);
  const api = vi.fn(async (path: string, options: any = {}) => {
    if (path.startsWith("/issues?") && options.method !== "POST") return structuredClone(issues);
    if (path === "/issues" && options.method === "POST") {
      const created = { number: issues.length + 1, state: "open", ...options.body };
      issues.push(created);
      return structuredClone(created);
    }
    const issue = issues.find((item) => path === `/issues/${item.number}`);
    if (issue && options.method === "PATCH") {
      Object.assign(issue, options.body);
      return structuredClone(issue);
    }
    throw new Error(`Unexpected API request: ${path}`);
  });
  return { issues, parent, api };
}

function report(id: number, passed: string[] = [], failed: string[] = [], executionComplete = true) {
  return { runId: id, attempt: 1, sha: "a".repeat(40), finishedAt: `2026-11-09T01:${String(id).padStart(2, "0")}:00Z`,
    url: `https://github.com/example/repo/actions/runs/${id}`, executionComplete, deliveryComplete: false, passed,
    findings: failed.map((key) => ({ key, contract: "case", platform: "linux", file: "server/case.test.ts", kind: "product", assertion: "new failure", retries: 0 })) };
}

describe("confirmed QA root-cause groups", () => {
  it("reopens one parent while preserving closed records, quality holds and unrelated findings", async () => {
    const { issues, parent, api } = fixture();
    parent.state = "closed";
    parent.labels.push("qa:verified");
    const unrelated = signature("independent defect", "linux");
    await deliverReport(report(2, [], [keys[0], unrelated], false), { api, policy });
    expect(issues[0].state).toBe("closed");
    expect(issues[0].body).toContain("Consolidated into #3");
    expect(issues[0].body).toContain('"triageEpoch":"2026-11-01T00:00:00Z"');
    expect(issues[0].body).toContain("new failure");
    expect(parent.state).toBe("open");
    expect(parent.labels).toContain("qa:untriaged");
    expect(parent.labels).not.toContain("qa:verified");
    expect(parent.body).toContain("Verified member cases: 0/2");
    expect(holdsFor([parent], ["usage"])).toEqual([parent]);
    expect(issues).toHaveLength(4);
    expect(issues[3].body).toContain(`<!-- mausbot-qa:${unrelated} -->`);
    expect(issues[3].state).toBe("open");
  });

  it("requires every platform's positive evidence and leaves parent closure to Lead", async () => {
    const { issues, parent, api } = fixture();
    await deliverReport(report(2, [keys[0]]), { api, policy });
    expect(parent.body).toContain("Verified member cases: 1/2");
    expect(parent.labels).not.toContain("qa:verified");
    await deliverReport(report(3, [keys[1]], [], false), { api, policy });
    expect(parent.labels).not.toContain("qa:verified");
    await deliverReport(report(4, [keys[1]]), { api, policy });
    expect(parent.body).toContain("Verified member cases: 2/2");
    expect(parent.body).toContain("Confirmed shared cause.");
    expect(parent.labels).toContain("qa:verified");
    expect(parent.state).toBe("open");
    expect(issues.slice(0, 2).every((issue) => issue.state === "closed")).toBe(true);
    await deliverReport(report(5, [], [keys[0]]), { api, policy });
    expect(parent.body).toContain("Verified member cases: 1/2");
    expect(parent.labels).not.toContain("qa:verified");
    expect(parent.labels).toContain("qa:untriaged");
  });

  it("retains retry findings and does not substitute a pass for them", async () => {
    const { parent, api } = fixture();
    const retried = report(2, keys, [keys[0]]);
    retried.findings[0].kind = "flake";
    retried.findings[0].retries = 1;
    await deliverReport(retried, { api, policy });
    expect(parent.body).toContain("Verified member cases: 1/2");
    expect(parent.labels).not.toContain("qa:verified");
  });

  it("does not let late reports overwrite newer failures or the group's latest source", async () => {
    const { issues, parent, api } = fixture();
    await deliverReport(report(4, keys), { api, policy });
    await deliverReport(report(6, [], [keys[0]]), { api, policy });
    await deliverReport(report(5, [keys[0]]), { api, policy });
    expect(issues[0].body).toContain('"lastExecution":"6:1"');
    await deliverReport(report(5, [], [keys[1]]), { api, policy });
    expect(parent.body).toContain("Verified member cases: 0/2");
    expect(parent.body).toContain('"runId":6');
    expect(parent.labels).not.toContain("qa:verified");
  });

  it("repairs a partial delivery when member evidence was saved but the parent update failed", async () => {
    const { parent, api } = fixture();
    let fail = true;
    const interrupted = async (path: string, options: any = {}) => {
      if (path === "/issues/3" && fail) { fail = false; throw new Error("parent unavailable"); }
      return api(path, options);
    };
    await expect(deliverReport(report(2, keys), { api: interrupted, policy })).rejects.toThrow("parent unavailable");
    expect(parent.labels).not.toContain("qa:verified");
    await deliverReport(report(2, keys), { api: interrupted, policy });
    expect(parent.labels).toContain("qa:verified");
    expect(parent.body).toContain("Verified member cases: 2/2");
  });

  it("gives each reopened parent a new queue epoch without waking all consolidated records", async () => {
    const { parent, api } = fixture();
    parent.state = "closed";
    const now = Date.parse("2026-11-09T12:00:00Z");
    await deliverReport(report(2, [], [keys[0]]), { api, policy });
    const first = queueItems([parent], [], now);
    expect(first).toHaveLength(1);
    await deliverReport(report(3, keys), { api, policy });
    parent.state = "closed";
    await deliverReport(report(4, [], [keys[0]]), { api, policy });
    const second = queueItems([parent], [], now);
    expect(second).toHaveLength(1);
    expect(second[0].key).not.toBe(first[0].key);
  });

  it.each(["duplicate", "missing", "priority", "scope", "overlap"])("rejects %s membership before writing any evidence", async (invalid) => {
    const { issues, parent, api } = fixture();
    if (invalid === "duplicate") parent.body = parent.body.replace(JSON.stringify(keys), JSON.stringify([keys[0], keys[0]]));
    if (invalid === "missing") issues.splice(0, 1);
    if (invalid === "priority") parent.labels = parent.labels.map((label) => label === "qa:p1" ? "qa:p2" : label);
    if (invalid === "scope") parent.labels = parent.labels.map((label) => label === "qa:scope:global" ? "qa:scope:usage" : label);
    if (invalid === "overlap") issues.push({ ...parent, number: 4 });
    await expect(deliverReport(report(2, keys), { api, policy })).rejects.toThrow();
    expect(api.mock.calls.every(([, options]) => options?.method !== "PATCH" && options?.method !== "POST")).toBe(true);
  });

  it("reads explicitly confirmed members without grouping merely similar cases", () => {
    const { issues } = fixture();
    const { groups, byKey } = qaGroups(issues);
    expect(groups).toHaveLength(1);
    expect([...byKey.keys()]).toEqual(keys);
    expect(byKey.has(signature("similar words, different cause", "linux"))).toBe(false);
  });
});
