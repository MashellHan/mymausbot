import { useCallback, useEffect, useRef } from "react";
import type { MessageAttachmentContext } from "@/components/AttachmentPreview";
import { useOptionalStoreRef } from "@/state/store-ref";
import { writeComputerPanelView } from "./computer-panel-view";
import { rememberComputerPanelOpen } from "./computer-panel-focus";
import { tableDelimiter } from "./table-data";

export interface MessageFilePreview {
  path: string;
  name: string;
  message: MessageAttachmentContext;
}

export interface PanelFilePreview extends MessageFilePreview {
  botId: string;
  nonce: number;
  at: number;
  returnFocus: HTMLElement | null;
}

export function filePreviewKind(name: string, path = name): "markdown" | "table" | null {
  if (/\.(md|markdown)$/i.test(name) || /\.(md|markdown)$/i.test(path)) return "markdown";
  return tableDelimiter(name) || tableDelimiter(path) ? "table" : null;
}

let pending: PanelFilePreview | null = null;
let nonce = 0;
const takers = new Set<() => void>();

export function useFilePreviewScope(botId: string | undefined, threadId: string | undefined, open: boolean): void {
  useEffect(() => {
    if (pending && (!open || pending.botId !== botId || pending.message.threadId !== threadId)) pending = null;
  }, [botId, threadId, open]);
}

export function usePanelFileRequest(botId: string, threadId: string, open: (file: PanelFilePreview) => void): void {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    const take = () => {
      const file = pending;
      if (!file || file.botId !== botId || file.message.threadId !== threadId) return;
      pending = null;
      if (Date.now() - file.at <= 10_000) latest.current(file);
    };
    take();
    takers.add(take);
    return () => { takers.delete(take); };
  }, [botId, threadId]);
}

export function useFilePanelOpener(): (file: MessageFilePreview, trigger: HTMLElement) => boolean {
  const store = useOptionalStoreRef();
  const latest = useRef(store);
  latest.current = store;
  return useCallback((file: MessageFilePreview, trigger: HTMLElement) => {
    const app = latest.current;
    const state = app?.state();
    const bot = state?.bots.find((candidate) => candidate.id === state.selectedId && candidate.threadId === file.message.threadId);
    if (!app || !bot || window.ogb?.remoteClient?.active || !filePreviewKind(file.name, file.path)) return false;
    pending = { ...file, botId: bot.id, nonce: ++nonce, at: Date.now(), returnFocus: trigger };
    if (!trigger.closest("[data-computer-panel]")) rememberComputerPanelOpen({ botId: bot.id, opener: trigger, tabs: false });
    writeComputerPanelView(bot.id, "files");
    for (const take of takers) take();
    app.dispatch({ type: "toggleComputer", open: true });
    return true;
  }, []);
}
