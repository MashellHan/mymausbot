import { t } from "@/lib/i18n";
import type { MiniAppSummary } from "../../../shared/mini-apps";
import { REPORT_APPS } from "../../../shared/report-mini-app";

const usageDefaultTitles = new Set(["Usage", "用量", "Work Tracker", "工作追踪"]);

export function miniAppDisplayName(app: MiniAppSummary): string {
  return app.dashboardIdentity === "usage" && usageDefaultTitles.has(app.title)
    ? t("computer.miniApps.dashboard.workTrackerTitle") : app.title;
}

const defaultDescriptions = {
  bookkeeping: "Records, calendar, cash flow and trends from your existing ledger.",
  x_ai_digest: REPORT_APPS.x_ai_digest.description,
  github_activity: REPORT_APPS.github_activity.description,
  "agent-team": "Your local teams and their current activity.",
  usage: "Your work, contributions and agent activity.",
};

export function miniAppDisplayDescription(app: MiniAppSummary): string {
  const kind = app.dashboardIdentity ?? app.shippedTemplateKind;
  if (!kind || app.description !== defaultDescriptions[kind]) return app.description;
  return t(kind === "bookkeeping" ? "computer.miniApps.bookkeepingDefaultDescription"
    : kind === "x_ai_digest" ? "computer.miniApps.report.xDescription"
      : kind === "github_activity" ? "computer.miniApps.report.githubDescription"
        : kind === "agent-team" ? "computer.miniApps.dashboard.teamDescription"
          : "computer.miniApps.dashboard.workTrackerDescription");
}
