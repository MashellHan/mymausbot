import { useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/cn";
import { usePwaPrefs } from "@/lib/pwa-cache";
import { selectQuickSwitchBots } from "@/lib/pwa-quick-bots";
import { isRemotePwaMode } from "@/lib/pwa-transport";
import { useShowThreads } from "@/lib/thread-preferences";
import { openBot } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { BotAvatar } from "../Avatar";

/** Calm mobile-only quick-switcher strip for pinned, active, and recent bots in Remote PWA. */
export function PwaBotQuickStrip({ activeBotId, hidden = false }: { activeBotId: string; hidden?: boolean }) {
  const remotePwa = isRemotePwaMode();
  const bots = useStoreSelector((state) => state.bots);
  const dispatch = useStoreDispatch();
  const showThreads = useShowThreads();
  const prefs = usePwaPrefs();
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const items = useMemo(
    () =>
      remotePwa && !hidden
        ? selectQuickSwitchBots({
            bots,
            selectedBotId: activeBotId,
            pinnedBotId: prefs?.openPinnedOnLaunch ? prefs.pinnedBotId : undefined,
          })
        : [],
    [remotePwa, hidden, bots, activeBotId, prefs?.openPinnedOnLaunch, prefs?.pinnedBotId],
  );

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [activeBotId]);

  if (items.length === 0) return null;

  return (
    <nav
      aria-label="Bots"
      data-pwa-quick-bots=""
      data-no-drawer-swipe=""
      className="hidden max-md:flex items-center gap-1.5 overflow-x-auto overscroll-x-contain px-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {items.map((item) => (
        <button
          key={item.bot.id}
          ref={item.selected ? activeRef : undefined}
          type="button"
          aria-current={item.selected ? "page" : undefined}
          onClick={() => openBot(dispatch, item.bot, showThreads)}
          className={cn(
            "flex min-h-9 touch:min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors active:scale-[0.98] motion-reduce:transition-none",
            item.selected
              ? "border-edge bg-raised font-medium text-ink"
              : "border-hairline/50 bg-card/75 text-ink-secondary hover:bg-raised/60 hover:text-ink",
          )}
        >
          <BotAvatar bot={item.bot} state={item.busy ? "working" : "happy"} size={18} animated={false} />
          <span className="max-w-[7.5rem] truncate">{item.bot.name}</span>
          {item.waiting ? (
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />
          ) : item.busy ? (
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success animate-status-pulse motion-reduce:animate-none" />
          ) : item.unread && !item.selected ? (
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent" />
          ) : null}
        </button>
      ))}
    </nav>
  );
}
