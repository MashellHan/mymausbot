import {
  Activity, AppWindow, BookOpen, Briefcase, Calendar, ChartColumnIncreasing, CheckCircle2, Clapperboard, Clock, Code2,
  Flame, Folder, GitBranch, Globe, Heart, Inbox, Mail, MessageSquare, Newspaper, ReceiptText, Shield, Sparkles, Terminal,
  UsersRound, Wallet, type LucideIcon,
} from "lucide-react";
import { LEGACY_MINI_APP_IDS } from "../../../shared/mini-app-release-packages";
import type { MiniAppCustomIcon, MiniAppDashboardKind, MiniAppIconPreset, MiniAppNativeKind, MiniAppSummary } from "../../../shared/mini-apps";
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

const presetIcons: Record<Exclude<MiniAppIconPreset, "microsoft">, { Icon: LucideIcon; tone: string }> = {
  briefcase: { Icon: Briefcase, tone: "#3b6e9c" },
  mail: { Icon: Mail, tone: "#2563eb" },
  inbox: { Icon: Inbox, tone: "#0284c7" },
  message: { Icon: MessageSquare, tone: "#0d9488" },
  calendar: { Icon: Calendar, tone: "#4f46e5" },
  heart: { Icon: Heart, tone: "#e11d48" },
  activity: { Icon: Activity, tone: "#16a34a" },
  book: { Icon: BookOpen, tone: "#7c3aed" },
  code: { Icon: Code2, tone: "#475569" },
  chart: { Icon: ChartColumnIncreasing, tone: "#0891b2" },
  sparkles: { Icon: Sparkles, tone: "#d97706" },
  folder: { Icon: Folder, tone: "#ca8a04" },
  globe: { Icon: Globe, tone: "#0ea5e9" },
  shield: { Icon: Shield, tone: "#059669" },
  terminal: { Icon: Terminal, tone: "#334155" },
  check: { Icon: CheckCircle2, tone: "#15803d" },
  clock: { Icon: Clock, tone: "#6366f1" },
  flame: { Icon: Flame, tone: "#ea580c" },
  users: { Icon: UsersRound, tone: "#2f855a" },
  wallet: { Icon: Wallet, tone: "#b47b37" },
};

const MICROSOFT_DEFAULT_TONE = "#00a4ef";
const tonedPlateStyle = (tone: string) => ({
  color: `color-mix(in oklab, ${tone} 72%, var(--color-ink))`,
  backgroundColor: `color-mix(in oklab, ${tone} 14%, var(--color-inset))`,
});

function MicrosoftMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="7.2" height="7.2" rx="1.2" fill="#f25022" />
      <rect x="10.8" y="2" width="7.2" height="7.2" rx="1.2" fill="#7fba00" />
      <rect x="2" y="10.8" width="7.2" height="7.2" rx="1.2" fill="#00a4ef" />
      <rect x="10.8" y="10.8" width="7.2" height="7.2" rx="1.2" fill="#ffb900" />
    </svg>
  );
}

export function iconKindForApp(app: MiniAppSummary): MiniAppIconKind | null {
  return app.dashboardIdentity ?? app.nativeIdentity ?? app.shippedTemplateKind
    ?? (app.id === LEGACY_MINI_APP_IDS.mojo && app.slug === "mojo" ? "mojo" : null);
}

export function MiniAppIcon({ kind, app, large = false, launcher = false }: { kind: MiniAppIconKind | null; app?: MiniAppSummary; large?: boolean; launcher?: boolean }) {
  const plateCls = launcher ? "h-14 w-14 rounded-xl" : large ? "h-9 w-9 rounded-lg" : "h-6 w-6 rounded-lg";
  const iconSize = launcher ? 26 : large ? 19 : 14;
  const custom: MiniAppCustomIcon | null = app?.icon ?? null;
  if (custom) {
    if (custom.kind === "preset") {
      if (custom.name === "microsoft") {
        return <span data-mini-app-icon="preset:microsoft"
          className={`inline-flex shrink-0 items-center justify-center ${plateCls}`}
          style={{ backgroundColor: `color-mix(in oklab, ${custom.tone ?? MICROSOFT_DEFAULT_TONE} 12%, var(--color-inset))` }}>
          <MicrosoftMark size={iconSize} />
        </span>;
      }
      const preset = presetIcons[custom.name];
      if (preset) {
        const Icon = preset.Icon;
        return <span data-mini-app-icon={`preset:${custom.name}`}
          className={`inline-flex shrink-0 items-center justify-center ${plateCls}`}
          style={tonedPlateStyle(custom.tone ?? preset.tone)}>
          <Icon size={iconSize} strokeWidth={1.8} aria-hidden="true" />
        </span>;
      }
    } else if (custom.kind === "emoji" && custom.value) {
      return <span data-mini-app-icon="emoji"
        className={`inline-flex shrink-0 items-center justify-center leading-none select-none ${plateCls} ${custom.tone ? "" : "bg-inset"} ${launcher ? "text-[24px]" : large ? "text-[18px]" : "text-[13px]"}`}
        style={custom.tone ? tonedPlateStyle(custom.tone) : undefined}>
        <span aria-hidden="true">{custom.value}</span>
      </span>;
    }
  }

  const mojo = kind === "mojo" || app?.id === LEGACY_MINI_APP_IDS.mojo && app.slug === "mojo";
  const entry = kind && kind !== "mojo" ? icons[kind] : null;
  const Icon = mojo ? Flame : entry?.Icon ?? AppWindow;
  return <span data-mini-app-icon={mojo ? "mojo" : kind ?? "custom"}
    className={`inline-flex shrink-0 items-center justify-center ${plateCls} ${entry || mojo ? "" : "bg-inset text-ink-secondary"}`}
    style={mojo ? { color: "#f6d177", backgroundColor: "#a8402e", border: "1px solid #d6a64f" }
      : entry ? tonedPlateStyle(entry.tone) : undefined}>
    <Icon size={iconSize} strokeWidth={1.8} aria-hidden="true" />
  </span>;
}
