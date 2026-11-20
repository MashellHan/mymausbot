import { memo } from "react";
import { t } from "@/lib/i18n";
import { botEngine, failedTurnCause } from "@/lib/failed-turn";
import { cn } from "@/lib/cn";
import { openRoomThread, type Message } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { useStoreRef } from "@/state/store-ref";
import { BotAvatar } from "./Avatar";
import { FailedTurnRow } from "./ChatView";
import { HandoffChip } from "./HandoffReply";
import { TeammateChip } from "./TeammateChip";
import { ThreadChip } from "./ThreadChip";
import { ToolActivity } from "./ToolActivity";

export const RoomToolChip = memo(function RoomToolChip({ message, roomId, threadId, live = false }: { message: Message; roomId?: string; threadId?: string; live?: boolean; locale?: string }) {
  const bots = useStoreSelector((state) => state.bots);
  const instances = useStoreSelector((state) => state.instances);
  const dispatch = useStoreDispatch();
  const store = useStoreRef();
  const tool = message.tool;
  if (!tool) return null;
  if (message.threadRef) return <ThreadChip message={message} />; if (message.relay) return <TeammateChip message={message} />;
  if (failedTurnCause(tool.name) !== null) {
    return <FailedTurnRow tool={tool} engine={botEngine(bots.find((b) => b.id === message.from?.botId), instances)} botId={message.from?.botId} messageAt={message.at} />;
  }
  const comm = message.comm;
  if (comm && comm.groupId !== roomId) {
    return <HandoffChip message={message} bots={bots} title={t("room.openBot", { name: comm.withName })} onClick={() => openRoomThread(dispatch, comm, store.state().groups)} />;
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
        {comm && <BotAvatar bot={bots.find(b => b.id === comm.withBotId) ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} animated={false} />}
        <span className={cn("max-w-[480px] truncate", !comm && "font-mono")}>{tool.name}</span>
      </div>
    </div>
  );
});
