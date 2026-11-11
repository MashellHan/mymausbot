import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ComputerPanel } from "../../src/components/ComputerPanel";
import { ChatMarkdown } from "../../src/components/ChatMarkdown";
import { BotEditorStore, initialState, type Bot, type Message } from "../../src/state/store";
import { applySkin } from "../../src/lib/skins";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { setLocale } from "../../src/lib/i18n";
import { rememberComputerPanelOpen } from "../../src/lib/computer-panel-focus";
import { useFilePreviewScope } from "../../src/lib/file-preview";
import "../../src/styles.css";

setAnalyticsEnabled(false);
setLocale("en");
applySkin(new URLSearchParams(location.search).get("skin") === "atelier" ? "atelier" : "midnight");
const fixture: { bot: Bot; olderPages: Message[][] } = await fetch("/__computer-files-fixture").then((response) => response.json());
function Preview() {
  const [open, setOpen] = useState(false);
  const [panelReady, setPanelReady] = useState(!new URLSearchParams(location.search).has("defer-panel"));
  const [bot, setBot] = useState(fixture.bot);
  const [olderPage, setOlderPage] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  useFilePreviewScope(bot.id, bot.threadId, open);
  const value: Parameters<typeof BotEditorStore>[0]["value"] = {
    state: { ...initialState, bots: [bot], selectedId: bot.id, computerOpen: open,
      loadingOlder: loadingOlder ? { [bot.threadId]: true } : {} },
    dispatch: (action) => {
      if (action.type === "toggleComputer") setOpen(action.open ?? !open);
      if (action.type === "loadOlderMessages" && !loadingOlder && bot.hasMore) {
        setLoadingOlder(true);
        window.setTimeout(() => {
          setBot((current) => ({ ...current, messages: [...fixture.olderPages[olderPage]!, ...current.messages],
            hasMore: olderPage + 1 < fixture.olderPages.length }));
          setOlderPage((page) => page + 1);
          setLoadingOlder(false);
        }, 250);
      }
    },
    flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {},
  };
  return <BotEditorStore value={value}>
    <main className="relative flex h-screen overflow-hidden bg-app text-ink">
      <section data-file-preview-chat className="min-w-0 flex-1 overflow-y-auto p-6">
        <header className="mb-8 flex items-center justify-between gap-3">
          <h1 className="text-lg font-medium">File reviewer</h1>
          <button type="button" className="ui-button ui-button-sm" onClick={(event) => {
            if (open) { setOpen(false); return; }
            rememberComputerPanelOpen({ botId: bot.id, opener: event.currentTarget, tabs: false }); setOpen(true);
          }}>{open ? "Close panel" : "Open panel"}</button>
          {!panelReady && <button type="button" className="ui-button ui-button-sm" onClick={() => setPanelReady(true)}>Finish loading panel</button>}
        </header>
        {bot.messages.filter((message) => message.role === "bot" && message.kind === "text").map((message) =>
          <article key={message.id} className="mb-6 max-w-2xl text-sm leading-relaxed">
            <ChatMarkdown text={message.text ?? ""} message={{ threadId: bot.threadId, messageId: message.id }} />
          </article>)}
      </section>
      {open && panelReady && <ComputerPanel bot={bot} />}
    </main>
  </BotEditorStore>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Preview /></StrictMode>);
