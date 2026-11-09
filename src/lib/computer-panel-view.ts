export type ComputerPanelView = "computer" | "android" | "browser" | "routines" | "files" | "data" | "mini-apps";

type PanelTabsContext = { advanced: boolean; androidConnected: boolean };

export function computerPanelTabs({ advanced, androidConnected }: PanelTabsContext): ComputerPanelView[] {
  return advanced
    ? ["computer", "routines", ...(androidConnected ? (["android"] as const) : []), "browser", "data", "files", "mini-apps"]
    : ["computer", "browser", "data", "files", "mini-apps"];
}

export function resolveComputerPanelView(view: ComputerPanelView, context: PanelTabsContext): ComputerPanelView {
  return computerPanelTabs(context).includes(view) ? view : "computer";
}

const STORAGE_PREFIX = "omb-computer-panel-view";

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
  return "mini-apps";
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
