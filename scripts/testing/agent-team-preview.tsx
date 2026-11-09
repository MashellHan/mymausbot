import { createRoot } from "react-dom/client";
import { AgentTeamPanel } from "../../src/components/AgentTeamPanel";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { setLocale } from "../../src/lib/i18n";
import { loadLocalePack } from "../../src/locales";
import { applySkin } from "../../src/lib/skins";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const width = Number(params.get("width"));
if ([360, 400, 960].includes(width)) {
  const style = document.createElement("style");
  style.textContent = `[data-computer-panel] { width: ${width}px !important; }`;
  document.head.append(style);
}
setAnalyticsEnabled(false);
const locale = params.get("locale") === "zh" ? "zh" : "en";
await loadLocalePack(locale);
setLocale(locale);
applySkin(params.get("skin") === "atelier" ? "atelier" : "midnight");
createRoot(document.getElementById("root")!).render(
    <div className="flex h-screen overflow-hidden bg-app text-ink">
      <main className="min-w-0 flex-1 p-6" aria-label="Synthetic chat background">
        <h1 className="text-[15px] font-medium">Sample assistant</h1>
        <p className="mt-3 text-[13px] text-ink-secondary">Synthetic visual fixture</p>
      </main>
      <aside data-computer-panel className="flex w-[400px] min-w-0 shrink-0 flex-col bg-panel"><AgentTeamPanel /></aside>
    </div>,
);

if (params.has("select") || params.has("focus")) {
  const applySelection = () => {
    const offices = [...document.querySelectorAll<HTMLButtonElement>("[data-team-house]")];
    if (!offices.length) return;
    observer.disconnect();
    const office = params.get("select") === "second" ? offices[1] : offices[0];
    if (params.has("select") && office?.getAttribute("aria-pressed") !== "true") office?.click();
    const target = params.get("focus") === "tab"
      ? document.querySelector<HTMLElement>('[data-team-house][aria-pressed="true"]')
      : params.get("focus") === "selector" ? document.querySelector<HTMLElement>(".agent-town-offices")
        : params.get("focus") === "office" ? office : null;
    target?.focus();
    document.documentElement.dataset.fixtureFocusVisible = String(target?.matches(":focus-visible") ?? false);
  };
  const observer = new MutationObserver(applySelection);
  observer.observe(document.getElementById("root")!, { childList: true, subtree: true });
  applySelection();
}
