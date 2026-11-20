import { AppWindow, ChartColumnIncreasing, Clapperboard, Flame, GitBranch, Newspaper, ReceiptText, UsersRound, type LucideIcon } from "lucide-react";
import { LEGACY_MINI_APP_IDS } from "../../../shared/mini-app-release-packages";
import type { MiniAppDashboardKind, MiniAppNativeKind, MiniAppSummary } from "../../../shared/mini-apps";
import type { ReportKind } from "../../../shared/report-mini-app";

export type MiniAppIconKind = "bookkeeping" | "mojo" | ReportKind | MiniAppDashboardKind | MiniAppNativeKind;

const icons: Record<Exclude<MiniAppIconKind, "mojo">, { Icon: LucideIcon; tone: string }> = {
  bookkeeping: { Icon: ReceiptText, tone: "#b47b37" },
  x_ai_digest: { Icon: Newspaper, tone: "#608bb7" },
  github_activity: { Icon: GitBranch, tone: "#6e7c8b" },
  "agent-team": { Icon: UsersRound, tone: "#738c70" },
  usage: { Icon: ChartColumnIncreasing, tone: "#397db6" },
  hongguo: { Icon: Clapperboard, tone: "#a84f46" },
};

export function iconKindForApp(app: MiniAppSummary): MiniAppIconKind | null {
  return app.dashboardIdentity ?? app.nativeIdentity ?? app.shippedTemplateKind ?? null;
}

export function MiniAppIcon({ kind, app, large = false, launcher = false }: { kind: MiniAppIconKind | null; app?: MiniAppSummary; large?: boolean; launcher?: boolean }) {
  const mojo = kind === "mojo" || app?.id === LEGACY_MINI_APP_IDS.mojo && app.slug === "mojo";
  const entry = kind && kind !== "mojo" ? icons[kind] : null;
  const Icon = mojo ? Flame : entry?.Icon ?? AppWindow;
  return <span data-mini-app-icon={mojo ? "mojo" : kind ?? "custom"}
    className={`inline-flex shrink-0 items-center justify-center ${launcher ? "h-14 w-14 rounded-xl" : large ? "h-9 w-9 rounded-lg" : "h-6 w-6 rounded-lg"} ${entry || mojo ? "" : "bg-inset text-ink-secondary"}`}
    style={mojo ? { color: "#f6d177", backgroundColor: "#a8402e", border: "1px solid #d6a64f" }
      : entry ? { color: `color-mix(in oklab, ${entry.tone} 72%, var(--color-ink))`,
      backgroundColor: `color-mix(in oklab, ${entry.tone} 14%, var(--color-inset))` } : undefined}>
    <Icon size={launcher ? 26 : large ? 19 : 14} strokeWidth={1.8} aria-hidden="true" />
  </span>;
}
