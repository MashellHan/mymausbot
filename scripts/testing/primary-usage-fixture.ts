import type { LocalContributionsResponse } from "../../shared/local-contributions.ts";
import { aggregateContributionSnapshot, parseContributionSnapshot } from "../../server/local-usage-contributions.ts";

export function primaryUsageSnapshotFixture(endDay = "2026-11-03") {
  const end = Date.parse(`${endDay}T00:00:00Z`);
  const dates = Array.from({ length: 60 }, (_, index) => new Date(end - (59 - index) * 86_400_000).toISOString().slice(0, 10));
  const capturedAt = `${endDay}T08:30:00Z`;
  const provider = (kind: "github" | "ado") => {
    const github = kind === "github";
    const id = `fixture:${kind}:source`;
    const rows = dates.map((day) => {
      const active = day === endDay;
      const prs = active ? github ? 3 : 2 : 0;
      const commits = active ? github ? 4 : 5 : 0;
      return { day, capturedAt, status: "ready", prs, knownPrs: prs, commits, knownCommits: commits,
        repositories: active ? [{ id: `${kind}-repo`, name: `fixture/${kind}-repo`,
          category: github ? "personal" : "work", status: "ready", prs, knownPrs: prs, commits, knownCommits: commits }] : [] };
    });
    return { version: 2, metricDefinition: github ? "github-profile-v2" : "ado-default-head-v1", provider: kind,
      asOfAt: capturedAt, capturedAt,
      dateBasis: github ? { prs: "github-profile-day", commits: "github-profile-day" }
        : { prs: "created-at/UTC", commits: "author-at/UTC" },
      operationWindow: { startDay: dates[0], endDay, todayPartial: true },
      activeSourceIds: [id], sources: [{ id, account: {
        host: github ? "github.example" : "dev.azure.com", login: github ? "fixture-gh" : "fixture-ado", stableId: `fixture-${kind}-id` },
        ...(github ? {} : { scope: { organization: "fixture-org", project: "fixture-project" } }),
        status: "ready", coverage: { identityVerified: true, paginationComplete: true, visibilityComplete: true, reasons: [] }, days: rows }],
      collection: { requestCount: 1, elapsedSeconds: 0.1, complete: true, reasons: [] } };
  };
  return { version: 2, github: provider("github"), ado: provider("ado") };
}

export function primaryUsageFixture(endDay = "2026-11-03"): LocalContributionsResponse {
  const now = Date.parse(`${endDay}T08:31:00Z`);
  const snapshot = parseContributionSnapshot(primaryUsageSnapshotFixture(endDay), now);
  return aggregateContributionSnapshot(snapshot, now);
}
