import { t } from "@/lib/i18n";
import type { MiniAppSummary } from "../../../shared/mini-apps";

const usageDefaultTitles = new Set(["Usage", "用量", "Work Tracker", "工作追踪"]);

export function miniAppDisplayName(app: MiniAppSummary): string {
  return app.dashboardIdentity === "usage" && usageDefaultTitles.has(app.title)
    ? t("computer.miniApps.dashboard.workTrackerTitle") : app.title;
}
