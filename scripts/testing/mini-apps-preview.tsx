import { createRoot } from "react-dom/client";
import { ComputerPanel } from "../../src/components/ComputerPanel";
import { mountMiniAppFrame } from "../../src/components/mini-apps/MiniAppFrame";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { writeComputerPanelView } from "../../src/lib/computer-panel-view";
import { setAdvancedMode } from "../../src/lib/interface-mode";
import { setLocale } from "../../src/lib/i18n";
import { applySkin } from "../../src/lib/skins";
import { loadLocalePack } from "../../src/locales";
import { BotEditorStore, initialState, type Bot } from "../../src/state/store";
import type { MiniAppDocument, MiniAppState } from "../../shared/mini-apps";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const locale = params.get("locale") === "zh" ? "zh" : "en";
setAnalyticsEnabled(false);
await loadLocalePack(locale);
setLocale(locale);
applySkin(params.get("skin") === "atelier" ? "atelier" : "midnight");
setAdvancedMode(false);
const width = Number(params.get("width"));
if ([360, 400, 960].includes(width)) localStorage.setItem("omb-computer-panel-width", String(width));

if (params.has("probe")) {
  const { document, state } = await fetch(`/__mini-app-probe?vector=${encodeURIComponent(params.get("probe")!)}`).then((res) => res.json()) as { document: MiniAppDocument; state: MiniAppState };
  mountMiniAppFrame({ container: window.document.getElementById("root")!, document, state, onRevoked: () => {} });
} else {
  const { id, threadId } = await fetch("/__mini-app-fixture").then((res) => res.json()) as { id: string; threadId: string };
  const bot = { id, threadId, name: "Bookkeeping fixture", title: "", description: "", color: "green", notifications: true,
    unread: false, busy: false, computer: "off", messages: [], modelSelection: { instanceId: "fixture-engine", model: "fixture-model" },
    tasks: [{ threadId, title: "Synthetic records", createdAt: 1, approvalMode: "ask" }] } as Bot;
  writeComputerPanelView(bot.id, "mini-apps");
  const value = { state: { ...initialState, bots: [bot], selectedId: bot.id }, dispatch: () => {},
    flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  createRoot(document.getElementById("root")!).render(
    <BotEditorStore value={value}>
      <div className="flex h-screen overflow-hidden bg-app text-ink">
        <main className="min-w-0 flex-1 p-6" aria-label="Synthetic chat background">
          <h1 className="text-[15px] font-medium">{locale === "zh" ? "记账助手" : "Bookkeeping assistant"}</h1>
          <p className="mt-3 text-[13px] text-ink-secondary">{locale === "zh" ? "隔离验证 · 全部为合成数据" : "Isolated verification · Synthetic data only"}</p>
        </main>
        <ComputerPanel bot={bot} />
      </div>
    </BotEditorStore>,
  );
}
