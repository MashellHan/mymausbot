import { createRoot } from "react-dom/client";
import { ChatView } from "../../src/components/ChatView";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { rememberReplyDraft, restoreComposerDraft } from "../../src/lib/drafts";
import { setAdvancedMode } from "../../src/lib/interface-mode";
import { setLocale } from "../../src/lib/i18n";
import { applySkin } from "../../src/lib/skins";
import { BotEditorStore, initialState, type Bot, type InstanceInfo, type Message } from "../../src/state/store";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "ready";
setAnalyticsEnabled(false);
setLocale("en");
applySkin(params.get("skin") === "atelier" ? "atelier" : "midnight");
setAdvancedMode(params.get("mode") === "advanced");

const source = { id: "source", role: "bot", kind: "text", at: 1, text: "Please check the sample plan before sending it.",
  from: { botId: "sample", name: "Willow", color: "green" } } as Message;
const current = { id: "current", parentId: "source", role: "user", kind: "text", at: 2,
  text: "Use the revised numbers and tell me what changed.", replyToId: "source" } as Message;
const attachmentOnly = { id: "attachment-only", role: "bot", kind: "text", at: 1, text: "",
  attachments: [{ kind: "image", path: "/fixture/image.png", mime: "image/png" }],
  from: { botId: "sample", name: "Willow", color: "green" } } as Message;
const attachedText = { id: "attached-text", parentId: "attachment-only", role: "user", kind: "text", at: 2,
  text: '<attached-file path="/fixture/report.txt" name="report.txt" />' } as Message;
const messages = scenario === "missing" ? [current] : scenario === "attachments" ? [attachmentOnly, attachedText] : [source, current];
const bot = { id: "sample", threadId: "sample-thread", name: "Sample", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: messages.at(-1)?.id,
  modelSelection: { instanceId: "fixture", model: "fixture-model" },
  tasks: [{ threadId: "sample-thread", title: "Sample chat", createdAt: 1, approvalMode: "ask" }],
} as Bot;
const state = { ...initialState, connected: true, selectedId: bot.id, activeView: "chat" as const, bots: [bot],
  instances: [{ instanceId: "fixture", driverKind: "codex", displayName: "Fixture", snapshot: { state: "available" },
    models: { default: "fixture-model", options: [{ id: "fixture-model", label: "Fixture model" }] },
    capabilities: { queueing: true } } as InstanceInfo] };
const value = { state, dispatch: () => {}, flushBotPatches: async () => null,
  refreshInstances: async () => {}, refreshModels: async () => {} };
if (scenario !== "attachments") rememberReplyDraft(bot.threadId, source.id);
if (scenario === "missing") restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "What changed in the revised plan?", attachments: [] });

createRoot(document.getElementById("root")!).render(<BotEditorStore value={value}>
  <div className="h-screen overflow-hidden bg-app text-ink"><ChatView bot={bot} /></div>
</BotEditorStore>);

if (params.get("focus") === "reply") {
  const applyFixtureFocus = () => {
    const button = document.querySelector<HTMLElement>('button[aria-label="Reply to message"]');
    if (!button) return false;
    setTimeout(() => {
      button.closest<HTMLElement>("[data-message-row]")?.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
      button.focus();
      setTimeout(() => {
        document.documentElement.dataset.fixtureFocusVisible = String(button.matches(":focus-visible"));
        document.documentElement.dataset.fixtureActionsShown = String(button.closest<HTMLElement>('[data-testid="message-actions"]')?.dataset.shown === "true");
        document.documentElement.dataset.fixtureReady = "true";
      }, 250);
    }, 200);
    return true;
  };
  if (!applyFixtureFocus()) {
    const observer = new MutationObserver(() => { if (applyFixtureFocus()) observer.disconnect(); });
    observer.observe(document.getElementById("root")!, { childList: true, subtree: true });
  }
}
