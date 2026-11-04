import { createRoot } from "react-dom/client";
import { ComputerPanel } from "../../src/components/ComputerPanel";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { writeComputerPanelView } from "../../src/lib/computer-panel-view";
import { setAdvancedMode } from "../../src/lib/interface-mode";
import { setLocale } from "../../src/lib/i18n";
import { loadLocalePack } from "../../src/locales";
import { applySkin } from "../../src/lib/skins";
import { BotEditorStore, initialState, type Bot } from "../../src/state/store";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const width = Number(params.get("width"));
if ([360, 400, 960].includes(width)) localStorage.setItem("omb-computer-panel-width", String(width));
setAnalyticsEnabled(false);
const locale = params.get("locale") === "zh" ? "zh" : "en";
await loadLocalePack(locale);
setLocale(locale);
applySkin(params.get("skin") === "atelier" ? "atelier" : "midnight");
setAdvancedMode(params.get("mode") === "advanced");

const bot: Bot = await fetch("/__agent-team-bot").then((response) => response.json());
writeComputerPanelView(bot.id, "agent-team");
const value = {
  state: { ...initialState, bots: [bot], selectedId: bot.id },
  dispatch: () => {},
  flushBotPatches: async () => null,
  refreshInstances: async () => {},
  refreshModels: async () => {},
};

createRoot(document.getElementById("root")!).render(
  <BotEditorStore value={value}>
    <div className="flex h-screen overflow-hidden bg-app text-ink">
      <main className="min-w-0 flex-1 p-6" aria-label="Synthetic chat background">
        <h1 className="text-[15px] font-medium">Sample assistant</h1>
        <p className="mt-3 text-[13px] text-ink-secondary">Synthetic visual fixture</p>
      </main>
      <ComputerPanel bot={bot} />
    </div>
  </BotEditorStore>,
);

if (params.has("open") || params.has("focus")) {
  setTimeout(() => {
    const groups = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="agent-team-panel"] section h3 button')];
    if (params.get("open") === "first" || params.get("open") === "both") groups[0]?.click();
    if (params.get("open") === "both") groups[1]?.click();
    const target = params.get("focus") === "tab"
      ? document.querySelector<HTMLElement>('[data-testid="computer-tabs"] [aria-selected="true"]')
      : params.get("focus") === "team" ? groups[0] : null;
    target?.focus();
    document.documentElement.dataset.fixtureFocusVisible = String(target?.matches(":focus-visible") ?? false);
  }, 800);
}
