import { Crown, MoreHorizontal } from "lucide-react";
import { botShowsUnread } from "@/lib/bot-unread";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { stateForBot } from "@/lib/mascot";
import { useStoreDispatch } from "@/state/store-select";
import type { Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { MobileSwipeReadRow, toggleBotUnread } from "./MobileSwipeReadRow";
import { openBotContextMenu, useVisibleMessages, type MenuState } from "./Sidebar";

/** The phone's home leads with the chief of staff, large and centred on the canvas like Grokbot. */
export function PhoneHero({ bot, selected, deleting = false, onOpen, onMenu }: { bot: Bot; selected: boolean; deleting?: boolean; onOpen: () => void; onMenu: (menu: MenuState) => void }) {
  const dispatch = useStoreDispatch();
  const visible = useVisibleMessages(bot);
  const unread = botShowsUnread(bot);
  return (
    <div className="mb-1.5">
      <MobileSwipeReadRow enabled={!deleting} unread={unread} onToggleUnread={() => toggleBotUnread(bot, unread, dispatch)}>
        <div className="group relative flex flex-col items-center pt-1">
          <button
            type="button"
            data-sidebar-hero={bot.id}
            data-sidebar-bot-row={bot.id}
            aria-current={selected ? "page" : undefined}
            onClick={onOpen}
            onContextMenu={(event) => openBotContextMenu(onMenu, bot.id, event)}
            className={cn(
              "flex flex-col items-center gap-1.5 rounded-2xl px-6 py-1.5 text-center outline-none transition-[transform,background-color] duration-100 active:scale-[0.97] focus-visible:ring-1 focus-visible:ring-accent/60",
              selected ? "bg-raised" : "hover:bg-raised/50",
            )}
          >
            <span className="relative flex">
              <BotAvatar bot={bot} state={stateForBot({ ...bot, messages: visible })} size={76} motion="none" motionKey={0} animated={Boolean(bot.busy)} />
              <span className={cn("absolute -bottom-0.5 -right-0.5 flex rounded-full border-2 border-app bg-raised p-1")}>
                <Crown size={12} strokeWidth={2.25} className="text-accent" aria-hidden="true" />
              </span>
            </span>
            <span className="text-[14px] font-medium leading-5 text-ink">{bot.name}</span>
          </button>
          <button type="button" data-bot-actions={bot.id} aria-label={t("sidebar.bot.actions", { name: bot.name })} title={t("sidebar.bot.actions", { name: bot.name })} aria-haspopup="menu"
            onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onMenu({ botId: bot.id, x: rect.left, y: rect.bottom }); }}
            className="absolute right-1 top-1 flex size-8 items-center justify-center rounded-full text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 touch:opacity-100 max-md:hidden"><MoreHorizontal size={16} /></button>
        </div>
      </MobileSwipeReadRow>
    </div>
  );
}
