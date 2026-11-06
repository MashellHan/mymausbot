import { AppWindow, ChartColumnIncreasing, GitBranch, Newspaper, ReceiptText, UsersRound, type LucideIcon } from "lucide-react";
import type { MiniAppDashboardKind, MiniAppSummary } from "../../../shared/mini-apps";
import type { ReportKind } from "../../../shared/report-mini-app";

export type MiniAppIconKind = "bookkeeping" | ReportKind | MiniAppDashboardKind;

const icons: Record<MiniAppIconKind, { Icon: LucideIcon; tone: string }> = {
  bookkeeping: { Icon: ReceiptText, tone: "#b47b37" },
  x_ai_digest: { Icon: Newspaper, tone: "#608bb7" },
  github_activity: { Icon: GitBranch, tone: "#6e7c8b" },
  "agent-team": { Icon: UsersRound, tone: "#738c70" },
  usage: { Icon: ChartColumnIncreasing, tone: "#397db6" },
};

export function iconKindForApp(app: MiniAppSummary): MiniAppIconKind | null {
  return app.dashboardIdentity ?? app.shippedTemplateKind ?? null;
}

export function MiniAppIcon({ kind, large = false }: { kind: MiniAppIconKind | null; large?: boolean }) {
  const entry = kind ? icons[kind] : null;
  const Icon = entry?.Icon ?? AppWindow;
  return <span data-mini-app-icon={kind ?? "custom"}
    className={`inline-flex shrink-0 items-center justify-center rounded-lg ${large ? "h-9 w-9" : "h-6 w-6"} ${entry ? "" : "bg-inset text-ink-secondary"}`}
    style={entry ? { color: `color-mix(in oklab, ${entry.tone} 72%, var(--color-ink))`,
      backgroundColor: `color-mix(in oklab, ${entry.tone} 14%, var(--color-inset))` } : undefined}>
    <Icon size={large ? 19 : 14} strokeWidth={1.8} aria-hidden="true" />
  </span>;
}
