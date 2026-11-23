import { use } from "react";
import { ChevronRight, MessagesSquare } from "lucide-react";
import { openThread, useStore, type Message } from "@/state/store";
import { useShowThreads } from "@/lib/thread-preferences";
import { t } from "@/lib/i18n";
import { activityText } from "@/lib/activity-text";
import { cn } from "@/lib/cn";
import { BotAvatar } from "./Avatar";
import { OpenExchangeContext } from "./HandoffExchange";
import { HandoffReply } from "./HandoffReply";

export function ThreadChip({ message, threadId }: { message: Message; threadId?: string }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const openExchange = use(OpenExchangeContext);
  const ref = message.threadRef;
  const tool = message.tool;
  if (!ref || !tool) return null;
  const bot = state.bots.find((candidate) => candidate.id === ref.botId);
  const direct = message.sentDirectly;
  const label = !direct ? activityText(tool, tool.name)
    : direct.room ? t("chat.sentDirectlyNotInRoom", { name: direct.name, room: direct.room }) : t("chat.sentDirectly", { name: direct.name });
  const asker = message.from;
  const workThread = bot && ref.threadId !== (bot.mainThreadId ?? bot.threadId) && bot.tasks?.some((task) => task.threadId === ref.threadId);
  const exchange = openExchange && threadId === openExchange.threadId && !direct && tool.ok === true &&
    asker && asker.botId === openExchange.askerId && bot && asker.botId !== bot.id && workThread
    ? { asker, helper: { botId: bot.id, name: bot.name, color: bot.color }, threadId: ref.threadId } : null;
  const exchangeLabel = exchange ? t("chat.handoffExchange.open", { name: exchange.helper.name }) : undefined;
  return (
    <HandoffReply message={message} threadId={threadId}>
      <button
        type="button"
        data-thread-chip={ref.threadId}
        data-exchange-chip={exchange ? "" : undefined}
        onClick={() => exchange && openExchange ? openExchange.open(exchange) : openThread(dispatch, ref, state, showThreads)}
        aria-label={exchangeLabel}
        title={exchangeLabel ?? t("chat.openThread", { title: ref.title })}
        className={cn("ui-pill", tool.ok === false && "text-danger")}
      >
        {bot ? <BotAvatar bot={bot} state="happy" size={16} animated={false} /> : <MessagesSquare size={13} aria-hidden="true" />}
        {exchange ? <span dir="auto" className="max-w-[240px] truncate">{exchange.helper.name}</span>
          : <><span className="max-w-[480px] truncate">{label}</span><ChevronRight size={13} aria-hidden="true" /></>}
      </button>
    </HandoffReply>
  );
}
