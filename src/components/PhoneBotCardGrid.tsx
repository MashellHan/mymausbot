import { memo, useMemo } from "react";
import { Crown, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { stateForBot } from "@/lib/mascot";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useShowThreads } from "@/lib/thread-preferences";
import { openBotRow } from "@/state/thread-navigation";
import { visibleMessages, type Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { botPreview, lastLine } from "./sidebar-preview";
import { sidebarBotStatus } from "./SidebarBotActivity";
import { useBotUnread } from "./unread-notice";
import type { BotRowProps } from "./Sidebar";

const PhoneBotCard = memo(function PhoneBotCard(props: BotRowProps) {
  const { bot, selected, deleting, mascotMotion, pendingQueued, instances, dispatch, onMenu } = props;
  const advanced = useAdvancedMode();
  const showThreads = useShowThreads();
  const visible = useMemo(() => visibleMessages({ messages: bot.messages, activeLeafId: bot.activeLeafId }), [bot.messages, bot.activeLeafId]);
  const { waiting, working, failed, teammateWait, queued } = sidebarBotStatus(bot, pendingQueued, visible);
  const { unread, noticing } = useBotUnread(bot);
  const preview = deleting
    ? t("sidebar.bot.deletingRow")
    : waiting
      ? t("sidebar.preview.waiting")
      : working
        ? t("chat.activity.working")
        : teammateWait
          ? t("sidebar.preview.waitingOnTeammate")
          : queued && !failed
            ? t("task.queued")
            : failed
              ? lastLine(bot, visible, instances, advanced)
              : botPreview(bot, visible, instances, advanced);

  return (
    <button
      type="button"
      data-sidebar-bot-row={bot.id}
      data-phone-bot-card={bot.id}
      data-look="sidebar-bot"
      aria-current={selected ? "page" : undefined}
      aria-busy={deleting || undefined}
      onClick={() => openBotRow(dispatch, bot, showThreads, selected)}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu({ botId: bot.id, x: event.clientX, y: event.clientY });
      }}
      className={cn(
        "relative flex min-w-0 flex-col items-start gap-2 rounded-2xl border p-3 text-left outline-none transition-[transform,background-color,border-color] duration-100 active:scale-[0.98] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
        selected ? "border-accent/40 bg-raised" : "border-hairline bg-card hover:bg-raised/60",
      )}
    >
      {unread && (
        <span
          data-testid="card-unread-dot"
          aria-label={t("task.unreadMany")}
          className="absolute right-2.5 top-2.5 size-2 rounded-full bg-accent"
        />
      )}
      <span className="relative flex shrink-0">
        <BotAvatar
          bot={bot}
          state={stateForBot({ ...bot, messages: visible })}
          size={48}
          motion={mascotMotion?.kind ?? "none"}
          motionKey={mascotMotion?.nonce ?? 0}
          animated={working || noticing || (mascotMotion?.kind ?? "none") !== "none"}
        />
        {working && (
          <span
            data-testid="working-dot"
            aria-label={t("chat.activity.working")}
            className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-card bg-success"
          />
        )}
        {!working && waiting && (
          <span
            data-testid="waiting-dot"
            role="status"
            aria-label={t("sidebar.preview.waiting")}
            className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full border-2 border-card bg-warning text-[11px] font-black text-panel"
          >
            <span aria-hidden="true">!</span>
          </span>
        )}
        {!working && !waiting && failed && (
          <span
            data-testid="failed-dot"
            aria-label={t("sidebar.preview.failed")}
            className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card bg-danger"
          />
        )}
        {bot.chiefOfStaff && (
          <span className="absolute -left-1 -top-1 flex rounded-full bg-raised p-[3px]">
            <Crown size={11} strokeWidth={2.25} className="shrink-0 text-accent" aria-hidden="true" />
          </span>
        )}
      </span>
      <span className="flex w-full min-w-0 flex-col gap-0.5">
        <span className="truncate text-[14px] font-semibold leading-5 text-ink">{bot.name}</span>
        <span className={cn("flex min-w-0 items-center gap-1 truncate text-[12px] leading-4", waiting ? "font-medium text-warning" : "text-ink-secondary")}>
          {deleting && <Loader2 size={11} className="shrink-0 animate-spin" aria-hidden="true" />}
          <span className="truncate">{preview}</span>
        </span>
      </span>
    </button>
  );
});

export function PhoneBotCardGrid({ bots, row }: { bots: readonly Bot[]; row: (bot: Bot) => BotRowProps }) {
  if (bots.length === 0) return null;
  return (
    <div data-phone-bot-grid="" className="grid grid-cols-2 gap-2.5">
      {bots.map((bot) => <PhoneBotCard key={bot.id} {...row(bot)} />)}
    </div>
  );
}
