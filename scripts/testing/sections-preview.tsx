import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SectionPicker } from "../../src/components/SidebarSectionPicker";
import { Sidebar } from "../../src/components/Sidebar";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { setAdvancedMode } from "../../src/lib/interface-mode";
import { setLocale } from "../../src/lib/i18n";
import { SIDEBAR_COLLAPSED_SECTIONS_KEY } from "../../src/lib/sidebar-preferences";
import { userSectionId } from "../../src/lib/sidebar-layout";
import { applySkin } from "../../src/lib/skins";
import { BotEditorStore, initialState, type Bot, type Group } from "../../src/state/store";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const picker = params.get("view") === "picker";
setAnalyticsEnabled(false);
setLocale("en");
applySkin(params.get("skin") === "atelier" ? "atelier" : "midnight");
setAdvancedMode(params.get("mode") === "advanced");
localStorage.setItem(SIDEBAR_COLLAPSED_SECTIONS_KEY, JSON.stringify([userSectionId("Work")]));

const bot = (id: string, name: string, section = "", hidden = false): Bot => ({
  id, threadId: `${id}-thread`, name, title: "", description: "", color: "green", section, hidden,
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "fixture", model: "fixture" },
  tasks: [{ threadId: `${id}-thread`, title: `${name} sample task`, createdAt: 1, approvalMode: "ask" }],
}) as Bot;
const bots = [bot("fixture-atlas", "Atlas"), bot("fixture-writer", "Writer", "Work"),
  bot("fixture-hidden", "Hidden sample", "Work", true), bot("fixture-travel", "Travel", "Home")];
const room = { id: "fixture-room", threadId: "fixture-room-thread", name: "Launch room", section: "Work", memberIds: ["fixture-writer"],
  messages: [], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1 } as Group;
const sections = picker ? ["Work", "Home", ...Array.from({ length: 36 }, (_, index) => `Department ${String(index + 1).padStart(2, "0")}`)] : ["Work", "Home"];
const state = { ...initialState, connected: true, selectedId: "fixture-atlas", activeView: "chat" as const,
  bots, groups: [room], sections };
const value = { state, dispatch: () => {}, flushBotPatches: async () => null,
  refreshInstances: async () => {}, refreshModels: async () => {} };

function Fixture() {
  const [selected, setSelected] = useState<string | null>(null);
  return <BotEditorStore value={value}>
    <div className="flex h-screen overflow-hidden bg-app text-ink">
      <Sidebar open onClose={() => {}} />
      <main className="min-w-0 flex-1 p-6"><h1 className="text-[15px] font-medium">Synthetic department fixture</h1>
        {selected !== null && <p className="mt-2 text-[12px]">Moved to department: {selected || "General"}</p>}
      </main>
      {picker && <SectionPicker current="Work" anchor={{ x: 320, y: 120 }} onClose={() => {}} onAssign={setSelected} />}
    </div>
  </BotEditorStore>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);

const search = params.get("query");
const filter = params.get("filter");
if (search || filter) {
  let openedSearch = false;
  const applyFixtureState = () => {
    if (filter) {
      const field = document.querySelector<HTMLInputElement>('[data-section-picker] input');
      if (!field) return false;
      setTimeout(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, filter);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        setTimeout(() => { document.documentElement.dataset.fixtureReady = "true"; }, 250);
      }, 200);
      return true;
    }
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Search bots and messages"]');
    if (!field) {
      const toggle = document.querySelector<HTMLButtonElement>("[data-sidebar-search-toggle]");
      if (!openedSearch && toggle) {
        toggle.click();
        openedSearch = true;
      }
      return false;
    }
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, search);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    setTimeout(() => { document.documentElement.dataset.fixtureReady = "true"; }, 250);
    return true;
  };
  if (!applyFixtureState()) {
    const observer = new MutationObserver(() => { if (applyFixtureState()) observer.disconnect(); });
    observer.observe(document.getElementById("root")!, { childList: true, subtree: true });
  }
}
