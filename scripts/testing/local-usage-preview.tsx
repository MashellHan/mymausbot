import { createRoot } from "react-dom/client";
import { LocalUsagePanel } from "../../src/components/LocalUsagePanel";
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
      <aside data-computer-panel className="flex w-[400px] min-w-0 shrink-0 flex-col bg-panel"><LocalUsagePanel /></aside>
    </div>,
);

if (params.has("focus") || params.has("scroll")) {
  const applyFixtureState = () => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="local-usage-panel"]');
    const details = scroller?.querySelector<HTMLDetailsElement>("[data-usage-daily]");
    if (details && (params.get("scroll") === "values" || params.get("focus") === "table")) details.open = true;
    const table = details?.querySelector<HTMLElement>('[role="region"]');
    if ((params.get("scroll") === "values" || params.get("focus") === "table") && !table) return false;
    if (params.get("scroll") === "values") table?.scrollIntoView({ block: "start" });
    if (params.get("hscroll") === "end" && table) table.scrollLeft = table.scrollWidth;
    const target = params.get("focus") === "tab" ? document.querySelector<HTMLElement>('[data-testid="local-usage-panel"] [role="tab"][aria-selected="true"]')
      : params.get("focus") === "table" ? table : null;
    if (params.get("focus") === "tab" && !target) return false;
    target?.focus();
    document.documentElement.dataset.fixtureFocusVisible = String(target?.matches(":focus-visible") ?? false);
    document.documentElement.dataset.fixtureReady = "true";
    return true;
  };
  if (!applyFixtureState()) {
    const observer = new MutationObserver(() => { if (applyFixtureState()) observer.disconnect(); });
    observer.observe(document.getElementById("root")!, { childList: true, subtree: true });
  }
}
