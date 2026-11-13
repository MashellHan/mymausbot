import { describe, expect, it, vi } from "vitest";
import { backlogSlot, beijingDay, planBacklog } from "./backlog.mjs";
import { drainQueue, queueItems } from "./queue.mjs";
import { recordCases } from "./scan.mjs";

const start = Date.parse("2026-11-13T00:00:00Z");
const old = "2026-11-10T00:00:00Z";

function issue(number: number, labels = ["qa", "qa:triaged", "qa:p2", "qa:kind:infrastructure", "qa:scope:global", "owner:upstream"], body = `QA-Owner: mausbot-upstream\nQA-Next: inspect saved evidence\nQA-Due: 2026-11-15T00:00:00Z`) {
  return { number, state: "open", created_at: old, updated_at: old, labels, body,
    html_url: `https://github.com/example/mausbot/issues/${number}` };
}

function harness(initial = [issue(1)]) {
  let open = initial;
  const closed = new Map<number, object>();
  const api = vi.fn(async (path: string) => {
    if (path.startsWith("/issues?state=open&labels=qa")) return open.filter((item) => item.labels.includes("qa"));
    if (path.startsWith("/issues?state=open")) return open;
    if (path.startsWith("/pulls?state=open")) return [];
    const id = Number(path.match(/^\/issues\/(\d+)$/)?.[1]);
    if (id && closed.has(id)) return closed.get(id);
    throw new Error(`Unexpected API read: ${path}`);
  });
  const send = vi.fn(() => ({ submittedAt: new Date(start).toISOString() }));
  const tick = (state: Record<string, any>, now: number, sender = send) => drainQueue(state, {
    api, now, send: sender, recover: async () => ({ healthy: true }),
    scan: async () => ({ handoffs: [] }), save: () => {},
  });
  return { tick, send, api, update: (number: number, body: string) => {
    open = open.map((item) => item.number === number ? { ...item, body } : item);
  }, close: (number: number, body: string) => {
    open = open.filter((item) => item.number !== number);
    closed.set(number, { number, state: "closed", closed_at: new Date(start).toISOString(), body });
  } };
}

describe("hourly QA backlog", () => {
  it("runs one Beijing daily inventory, resurfaces unchanged stale work by cadence and survives state reload", async () => {
    expect(beijingDay(Date.parse("2026-11-12T15:59:59Z"))).toBe("2026-11-12");
    expect(beijingDay(Date.parse("2026-11-12T16:00:00Z"))).toBe("2026-11-13");
    const h = harness(), state: Record<string, any> = {};
    expect((await h.tick(state, start)).sent).toBe(true);
    expect(h.send.mock.calls[0][0]).toContain("Beijing daily open backlog 2026-11-13");
    expect(state.backlog.records[1]).toMatchObject({ stage: "assigned", delivery: { status: "notification_sent" } });
    expect(state.backlog.records[1]).not.toHaveProperty("completedAt");
    expect((await h.tick(state, start + 60_000)).sent).toBe(false);
    const resumed = JSON.parse(JSON.stringify(state));
    expect((await h.tick(resumed, start + 6 * 60 * 60_000)).sent).toBe(true);
    expect(h.send.mock.calls[1][0]).toContain("Unresolved work follow-up");
    expect(resumed.backlog.lastFollowupSlot).toBe(backlogSlot(start + 6 * 60 * 60_000));
    expect((await h.tick(resumed, start + 6 * 60 * 60_000 + 60_000)).sent).toBe(false);
    expect((await h.tick(resumed, start + 24 * 60 * 60_000)).sent).toBe(true);
    expect(h.send.mock.calls[2][0]).toContain("Beijing daily open backlog 2026-11-14");
    expect(h.send).toHaveBeenCalledTimes(3);
  });

  it("records a verified closure separately from notification and excludes closed work", async () => {
    const h = harness(), state: Record<string, any> = {};
    await h.tick(state, start);
    h.close(1, "QA-Disposition-Evidence: accepted review and exact integrated report");
    await h.tick(state, start + 24 * 60 * 60_000);
    expect(state.backlog.records[1]).toMatchObject({ stage: "closed", closureEvidence: "accepted review and exact integrated report" });
    expect(state.backlog.lastInventory).toMatchObject({ total: 0, qa: 0 });
    expect(h.send.mock.calls[1][0]).not.toContain("#1 https://");
    expect(h.api.mock.calls.every((call) => call.length === 1)).toBe(true);
  });

  it("requires evidence for a closed disposition", async () => {
    const h = harness(), state: Record<string, any> = {};
    await h.tick(state, start);
    h.close(1, "Closed without a verification record");
    await h.tick(state, start + 24 * 60 * 60_000);
    expect(state.backlog.records[1]).toMatchObject({ stage: "closed_evidence_pending", closureEvidence: null });
  });

  it("fairly rereads more than four closed records and settles only later evidence after restart", async () => {
    const h = harness(Array.from({ length: 6 }, (_, index) => issue(index + 1)));
    const state: Record<string, any> = {};
    const detailReads = () => h.api.mock.calls.filter(([path]) => /^\/issues\/\d+$/.test(path)).map(([path]) => path);
    await h.tick(state, start);
    for (let number = 1; number <= 6; number++) h.close(number, "Closed without evidence");
    await h.tick(state, start + 24 * 60 * 60_000);
    expect(detailReads()).toEqual(["/issues/1", "/issues/2", "/issues/3", "/issues/4"]);
    expect([1, 2, 3, 4].map((number) => state.backlog.records[number].stage)).toEqual(Array(4).fill("closed_evidence_pending"));
    const resumed = JSON.parse(JSON.stringify(state));
    await h.tick(resumed, start + 48 * 60 * 60_000);
    expect(detailReads().slice(4)).toEqual(["/issues/5", "/issues/6", "/issues/1", "/issues/2"]);
    expect([1, 2, 3, 4, 5, 6].map((number) => resumed.backlog.records[number].stage)).toEqual(Array(6).fill("closed_evidence_pending"));
    expect(h.send.mock.calls[2][0]).toContain("Closed items awaiting exact disposition evidence: #5, #6, #1, #2");
    h.close(3, "QA-Disposition-Evidence: accepted review and exact integrated report");
    await h.tick(resumed, start + 72 * 60 * 60_000);
    expect(detailReads().slice(8)).toEqual(["/issues/3", "/issues/4", "/issues/1", "/issues/2"]);
    expect(resumed.backlog.records[3]).toMatchObject({ stage: "closed", closureEvidence: "accepted review and exact integrated report" });
    expect(resumed.backlog.records[4]).toMatchObject({ stage: "closed_evidence_pending", closureEvidence: null });
    expect(h.send.mock.calls[3][0]).toContain("Closed items awaiting exact disposition evidence: #4");
    expect(h.send.mock.calls[3][0]).not.toContain("Closed items awaiting exact disposition evidence: #3");
  });

  it("uses the native process record through assignment and six-hour follow-up", async () => {
    let generated: ReturnType<typeof issue> | undefined;
    await recordCases([{ key: "a".repeat(16), rule: "ci-latency", subject: "run:123:1", text: "Inspect the measured CI phase." }], {
      now: start,
      api: async (path: string, options?: { method?: string; body?: { body: string; labels: string[] } }) => {
        if (path.startsWith("/issues?state=all&labels=qa:process")) return [];
        if (path === "/issues" && options?.method === "POST") {
          generated = { ...issue(9, options.body!.labels, options.body!.body), created_at: new Date(start).toISOString() };
          return generated;
        }
        throw new Error(`Unexpected process API call: ${path}`);
      },
    });
    const h = harness([generated!]), state: Record<string, any> = {};
    await h.tick(state, start);
    expect(state.backlog.records[9]).toMatchObject({ process: true, stage: "assigned", owner: "mausbot-lead",
      next: expect.stringContaining("assign an existing owner") });
    const resumed = JSON.parse(JSON.stringify(state));
    h.update(9, generated!.body.replace(/^Process-Owner: .+$/m, "Process-Owner: mausbot-upstream")
      .replace(/^Process-Next: .+$/m, "Process-Next: inspect the saved phase trace")
      + "\nProcess-Evidence: bounded trace accepted");
    await h.tick(resumed, start + 6 * 60 * 60_000);
    expect(resumed.backlog.records[9]).toMatchObject({ stage: "assigned", owner: "mausbot-upstream",
      next: "inspect the saved phase trace", evidence: "bounded trace accepted", lastProgressAt: new Date(start + 6 * 60 * 60_000).toISOString() });
    expect(resumed.backlog.records[9]).not.toHaveProperty("completedAt");
    expect(h.send.mock.calls[1][0]).toContain("Unresolved work follow-up");
    expect(h.send.mock.calls[1][0]).toContain("Process-Next=inspect the saved phase trace");
    expect(h.send.mock.calls[1][0]).toContain("keep Process-Owner and Process-Next on process cases");
  });

  it("recognizes the existing Lead closure marker on an exact closed issue", async () => {
    const h = harness(), state: Record<string, any> = {};
    await h.tick(state, start);
    h.close(1, "<!-- lead-qa-close:ac79:1 -->\nOriginal review and exact integrated report are retained below.");
    await h.tick(state, start + 24 * 60 * 60_000);
    expect(state.backlog.records[1]).toMatchObject({ stage: "closed", closureEvidence: "<!-- lead-qa-close:ac79:1 -->" });
  });

  it("keeps ambiguous submission pending and retries only a known preflight rejection", async () => {
    const h = harness(), uncertain: Record<string, any> = {};
    const unknown = vi.fn(() => { throw new Error("possible submission"); });
    await expect(h.tick(uncertain, start, unknown)).rejects.toThrow("possible submission");
    expect(uncertain.pending.status).toBe("uncertain");
    expect(uncertain.backlog).not.toHaveProperty("lastDailyDay");
    expect((await h.tick(uncertain, start + 60_000, unknown)).uncertain).toBe(true);
    expect(unknown).toHaveBeenCalledTimes(1);
    const known: Record<string, any> = {};
    const preflight = vi.fn(() => { throw Object.assign(new Error("unavailable before prompt"), { notSubmitted: true }); });
    await expect(h.tick(known, start, preflight)).rejects.toMatchObject({ notSubmitted: true });
    expect(known).not.toHaveProperty("pending");
    expect(known.backlog).not.toHaveProperty("lastDailyDay");
    expect((await h.tick(known, start + 60_000)).sent).toBe(true);
  });

  it("bounds the all-open batch, keeps paused requests disposition-only and retains active owners", () => {
    const verified = issue(1, ["qa", "qa:verified", "qa:triaged", "qa:p2", "qa:kind:infrastructure", "qa:scope:global", "owner:upstream"]);
    const qa = Array.from({ length: 19 }, (_, i) => issue(i + 2));
    const other = Array.from({ length: 10 }, (_, i) => issue(i + 30, ["feature", "status:paused"], "Request held for product decision"));
    const pr = { number: 44, draft: true, head: { sha: "a".repeat(40) }, body: "QA-Repair: #2" };
    const plan = planBacklog([verified, ...qa, ...other], [pr], {}, start);
    expect(plan.inventory).toMatchObject({ total: 30, qa: 20, other: 10, verified: 1, paused: 10 });
    expect(plan.items[0].selected).toHaveLength(8);
    expect(plan.items[1].selected).toHaveLength(6);
    expect(plan.items[0].selected[0]).toMatchObject({ number: 1, stage: "verification", owner: "mausbot-upstream" });
    expect(plan.observed.find((item) => item.number === 2)).toMatchObject({ stage: "fixing", repair: { number: 44 } });
    expect(plan.items[0].selected.filter((item) => item.stage === "disposition_needed")).toHaveLength(3);
    expect(plan.items[0].text).toContain("do not resume paused or product work");
    expect(plan.items[0].text).toContain("existing PR #44");
  });

  it("observes an existing repair through fixing, review and verification without declaring it complete", () => {
    const source = issue(2);
    const draft = { number: 44, draft: true, head: { sha: "a".repeat(40) }, body: "QA-Repair: #2" };
    const fixing = planBacklog([source], [draft], {}, start).observed[0];
    const ready = { ...draft, draft: false, body: `${draft.body}\nQA-Handoff: ${draft.head.sha}` };
    const review = planBacklog([source], [ready], { 2: fixing }, start + 60_000).observed[0];
    const verified = planBacklog([{ ...source, labels: [...source.labels, "qa:verified"] }], [], { 2: review }, start + 120_000).observed[0];
    expect([fixing.stage, review.stage, verified.stage]).toEqual(["fixing", "review", "verification"]);
    expect([fixing, review, verified].every((item) => !Object.hasOwn(item, "completedAt"))).toBe(true);
  });

  it("does not wake immediate QA again for cosmetic due or comment changes", () => {
    const first = issue(1, ["qa", "qa:triaged", "qa:p2", "qa:kind:infrastructure", "qa:scope:global", "owner:upstream"],
      "QA-Owner: mausbot-upstream\nQA-Next: inspect saved evidence\nQA-Due: 2026-11-12T00:00:00Z");
    const renewed = { ...first, body: first.body.replace("2026-11-12T00:00:00Z", "2026-11-12T12:00:00Z") + "\nCheckpoint comment" };
    expect(queueItems([first], [], start)[0].key).toBe(queueItems([renewed], [], start)[0].key);
  });
});
