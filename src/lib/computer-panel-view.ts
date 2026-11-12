import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { focusComputerPanelEntry } from "./computer-panel-focus";

export type ComputerPanelView = "computer" | "android" | "browser" | "routines" | "files" | "data" | "mini-apps";

type PanelTabsContext = { advanced: boolean; androidConnected: boolean };

export function computerPanelTabs({ advanced, androidConnected }: PanelTabsContext): ComputerPanelView[] {
  const android = androidConnected ? (["android"] as const) : [];
  return advanced
    ? ["computer", "routines", ...android, "browser", "data", "files", "mini-apps"]
    : ["computer", ...android, "browser", "data", "files", "mini-apps"];
}

export function resolveComputerPanelView(view: ComputerPanelView, context: PanelTabsContext): ComputerPanelView {
  return computerPanelTabs(context).includes(view) ? view : "computer";
}

const STORAGE_PREFIX = "omb-computer-panel-view";
export const COMPUTER_PANEL_VIEW_REQUEST = "omb-computer-panel-view-request";

function storageKey(botId: string): string {
  return `${STORAGE_PREFIX}:${botId}`;
}

export function readComputerPanelView(
  botId: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): ComputerPanelView {
  try {
    const value = storage.getItem(storageKey(botId));
    if (value === "agent-team" || value === "usage") return "mini-apps";
    if (value === "computer" || value === "android" || value === "browser" || value === "routines" || value === "files" || value === "data" || value === "mini-apps") return value;
  } catch {
  }
  return "computer";
}

export function writeComputerPanelView(
  botId: string,
  view: ComputerPanelView,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(storageKey(botId), view);
  } catch {
  }
}

export function requestComputerPanelView(botId: string, view: ComputerPanelView, focusTabs = false): void {
  writeComputerPanelView(botId, view);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(COMPUTER_PANEL_VIEW_REQUEST, { detail: { botId, view, focusTabs } }));
}

export function useComputerPanelViewRequest(
  botId: string,
  panelRef: RefObject<HTMLElement | null>,
  explicitView: RefObject<boolean>,
  setView: Dispatch<SetStateAction<ComputerPanelView>>,
): void {
  useEffect(() => {
    const onView = (event: Event) => {
      const request = (event as CustomEvent<{ botId: string; view: ComputerPanelView; focusTabs: boolean }>).detail;
      if (request?.botId !== botId) return;
      explicitView.current = true;
      setView(request.view);
      if (request.focusTabs) requestAnimationFrame(() => focusComputerPanelEntry(panelRef.current));
    };
    window.addEventListener(COMPUTER_PANEL_VIEW_REQUEST, onView);
    return () => window.removeEventListener(COMPUTER_PANEL_VIEW_REQUEST, onView);
  }, [botId, panelRef, explicitView, setView]);
}
