import { t } from "@/lib/i18n";
import { botEngine, failedTurnCause } from "@/lib/failed-turn";
import { cn } from "@/lib/cn";
import { openRoomThread, useStore, type Message } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { FailedTurnRow } from "./ChatView";
import { HandoffChip } from "./HandoffReply";
import { TeammateChip } from "./TeammateChip";
import { ThreadChip } from "./ThreadChip";
import { ToolActivity } from "./ToolActivity";

export function RoomToolChip({ message, roomId, threadId, live = false }: { message: Message; roomId?: string; threadId?: string; live?: boolean }) {
  const { state, dispatch } = useStore();
  const tool = message.tool;
  if (!tool) return null;
  if (message.threadRef) return <ThreadChip message={message} />; if (message.relay) return <TeammateChip message={message} />;
  if (failedTurnCause(tool.name) !== null) {
    return <FailedTurnRow tool={tool} engine={botEngine(state.bots.find((b) => b.id === message.from?.botId), state.instances)} botId={message.from?.botId} messageAt={message.at} />;
  }
  const comm = message.comm;
  if (comm && comm.groupId !== roomId) {
    return <HandoffChip message={message} bots={state.bots} title={t("room.openBot", { name: comm.withName })} onClick={() => openRoomThread(dispatch, comm, state.groups)} />;
  }
  if (!comm) return <ToolActivity tool={tool} live={live} source={threadId ? { threadId, messageId: message.id } : undefined} />;
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "ui-pill",
          tool.ok === false && "text-danger",
        )}
      >
        {comm && <BotAvatar bot={state.bots.find(b => b.id === comm.withBotId) ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} animated={false} />}
        <span className={cn("max-w-[480px] truncate", !comm && "font-mono")}>{tool.name}</span>
      </div>
    </div>
  );
}
