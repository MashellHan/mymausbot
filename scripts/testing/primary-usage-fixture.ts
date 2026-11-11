import type { LocalContributionsResponse } from "../../shared/local-contributions.ts";
import { aggregateContributionSnapshot, parseContributionSnapshot } from "../../server/local-usage-contributions.ts";

type SourceTotals = Record<"github" | "ado", { prs: number; commits: number }>;
const defaultTotals: SourceTotals = { github: { prs: 3, commits: 4 }, ado: { prs: 2, commits: 5 } };

export function primaryUsageSnapshotFixture(endDay = "2026-11-03", asOfAt = `${endDay}T08:30:00Z`,
                                            totals: SourceTotals = defaultTotals) {
  const end = Date.parse(`${endDay}T00:00:00Z`);
  const dates = Array.from({ length: 60 }, (_, index) => new Date(end - (59 - index) * 86_400_000).toISOString().slice(0, 10));
  const capturedAt = new Date(Date.parse(asOfAt) + 60_000).toISOString();
  const provider = (kind: "github" | "ado") => {
    const github = kind === "github";
    const id = `fixture:${kind}:source`;
    const rows = dates.map((day) => {
      const active = day === endDay;
      const prs = active ? totals[kind].prs : 0;
      const commits = active ? totals[kind].commits : 0;
      return { day, capturedAt, status: "ready", prs, knownPrs: prs, commits, knownCommits: commits,
        repositories: active ? [{ id: `${kind}-repo`, name: `fixture/${kind}-repo`,
          category: github ? "personal" : "work", status: "ready", prs, knownPrs: prs, commits, knownCommits: commits }] : [] };
    });
    return { version: 2, metricDefinition: github ? "github-profile-beijing-v1" : "ado-default-head-beijing-v1", provider: kind,
      asOfAt, capturedAt,
      dateBasis: { prs: "created-at/Asia-Shanghai", commits: "author-at/Asia-Shanghai" },
      operationWindow: { startDay: dates[0], endDay, todayPartial: true },
      activeSourceIds: [id], sources: [{ id, account: {
        host: github ? "github.example" : "dev.azure.com", login: github ? "fixture-gh" : "fixture-ado", stableId: `fixture-${kind}-id` },
        ...(github ? {} : { scope: { organization: "fixture-org", project: "fixture-project" } }),
        status: "ready", coverage: { identityVerified: true, paginationComplete: true, visibilityComplete: true, reasons: [] }, days: rows }],
      collection: { requestCount: 1, elapsedSeconds: 0.1, complete: true, reasons: [] } };
  };
  return { version: 2, github: provider("github"), ado: provider("ado") };
}

export function primaryUsageFixture(endDay = "2026-11-03", knownOnly = false,
                                    asOfAt = `${endDay}T08:30:00Z`, totals: SourceTotals = defaultTotals): LocalContributionsResponse {
  const now = Date.parse(asOfAt) + 60_000;
  const snapshot = parseContributionSnapshot(primaryUsageSnapshotFixture(endDay, asOfAt, totals), now);
  if (knownOnly) for (const source of snapshot.github.sources) {
    source.status = "partial";
    source.coverage.visibilityComplete = false;
    for (const day of source.days) {
      day.status = "partial";
      day.prs = null;
      day.commits = null;
    }
  }
  return aggregateContributionSnapshot(snapshot, now);
}
