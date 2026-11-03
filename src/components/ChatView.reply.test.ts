// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";
import { clearReplyDraft, rememberReplyDraft } from "@/lib/drafts";
import { setAdvancedMode } from "@/lib/interface-mode";
import { setLocale } from "@/lib/i18n";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useReactor: () => "user" }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState } = await import("@/state/store");

const threadId = "sample-thread";
const source = { id: "source", role: "bot", kind: "text", at: 1, text: "Earlier answer",
  from: { botId: "sample", name: "Willow", color: "green" } } as Message;
const current = { id: "current", parentId: "source", role: "user", kind: "text", at: 2,
  text: "Current request", replyToId: "source" } as Message;
const bot = (messages: Message[]): Bot => ({
  id: "sample", threadId, name: "Sample", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: "current",
  modelSelection: { instanceId: "fixture", model: "model" },
  tasks: [{ threadId, title: "Sample thread", createdAt: 1, approvalMode: "ask" }],
}) as Bot;

let host: HTMLDivElement;
let root: Root;
const draw = (messages: Message[]) => {
  const shown = bot(messages);
  const state: AppState = { ...initialState, connected: true, selectedId: shown.id, bots: [shown],
    instances: [{ instanceId: "fixture", driverKind: "codex", displayName: "Fixture", snapshot: { state: "available" } } as InstanceInfo] };
  const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot: shown }) })));
};

beforeEach(() => {
  setLocale("en");
  setAdvancedMode(false);
  clearReplyDraft(threadId);
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  clearReplyDraft(threadId);
  host.remove();
  vi.unstubAllGlobals();
});

it("re-resolves an ID-only draft from current messages and shows missing sources after they disappear", () => {
  rememberReplyDraft(threadId, source.id);
  draw([source, current]);
  expect(host.querySelector('[data-composer-reply]')?.textContent).toContain("Willow");
  expect(host.querySelector('[data-reply-quote]')?.textContent).toContain("Willow");

  draw([current]);
  expect(host.querySelector('[data-composer-reply]')?.textContent).toContain("Original message unavailable");
  expect(host.querySelector('[data-reply-quote]')?.textContent).toContain("Original message unavailable");
  flushSync(() => host.querySelector<HTMLButtonElement>('[data-composer-reply] button[aria-label="Cancel reply"]')!.click());
  expect(host.querySelector('[data-composer-reply]')).toBeNull();
});
