// @vitest-environment happy-dom
// Picking a bot from the @ list sends its id with the words, so the bot picked is the one reached even when another
// bot has the same name. Typed names carry no ids. The desktop app and the web app share this composer.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";
import { failedComposerSends, forgetFailedComposerSend, markDraftEdited, restoreComposerDraft } from "@/lib/drafts";
import { addPointedChip, forgetPointedChips, takePointedChips } from "@/lib/pointed-chips";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), queued: [] as Array<{ queueId: string; text: string; pointedChips?: import("@/lib/pointed-chips").PointedChip[] }> }));
const ENGINE = "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, bots: [scout, analyst, chief], pendingQueued: { [room.threadId]: fixture.queued }, instances: [{
      instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: true },
    }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/live-call-media", () => ({ isLiveCallRunning: () => false, useLiveMedia: () => ({ phase: "idle", botId: null }) }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./CallView", () => ({ CallButton: () => null }));
vi.mock("./GroupCallView", () => ({ GroupCallButton: () => null }));

import { Composer } from "./Composer";

const scout: Bot = {
  id: "scout", threadId: "scout-thread", name: "Scout", title: "Support agent", description: "",
  color: "blue", notifications: false, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: ENGINE, model: "fake" },
};
const analyst: Bot = { ...scout, id: "quill-analyst", threadId: "analyst-thread", name: "Quill", title: "Analyst", color: "teal" };
const chief: Bot = { ...scout, id: "quill-chief", threadId: "chief-thread", name: "Quill", title: "", color: "purple", chiefOfStaff: true };
const room: Group = {
  id: "room", threadId: "room-thread", name: "Launch", memberIds: [scout.id, analyst.id, chief.id],
  defaultResponder: { kind: "member", botId: scout.id }, bulletin: "", unread: false, createdAt: 1, setupCompletedAt: 1, messages: [],
};
const drafts = [`group:${room.id}:${room.threadId}`, `bot:${scout.id}:${scout.threadId}`];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  fixture.queued = [];
  forgetPointedChips();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  for (const id of drafts) restoreComposerDraft(id, { text: "", attachments: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  for (const id of drafts) restoreComposerDraft(id, { text: "", attachments: [] });
  for (const draftId of drafts) for (const failed of failedComposerSends(draftId)) forgetFailedComposerSend(draftId, failed.id);
  forgetPointedChips();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const input = () => container.querySelector("textarea")!;
function type(draftId: string, text: string) {
  flushSync(() => restoreComposerDraft(draftId, { text, attachments: [] }));
  input().setSelectionRange(text.length, text.length);
  flushSync(() => input().dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true })));
}
const options = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
function pick(name: string, role: string) {
  const option = options().find((one) => one.textContent?.includes(name) && one.textContent.includes(role));
  if (!option) throw new Error(`no ${name}, ${role} in the @ list: ${options().map((one) => one.textContent).join(" | ")}`);
  flushSync(() => option.click());
}
function send() {
  flushSync(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
}
const sent = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "sendGroup" || action.type === "send");

describe("a room's @ list", () => {
  beforeEach(() => flushSync(() => root.render(createElement(Composer, { group: room, members: [scout, analyst, chief] }))));

  it("shows each Quill by its role, and sends the picked one's id", () => {
    type(drafts[0]!, "@Qu");
    expect(options().map((one) => one.textContent)).toEqual([expect.stringContaining("Analyst"), expect.stringContaining("Chief of Staff")]);
    pick("Quill", "Chief of Staff");
    expect(input().value).toBe("@Quill ");
    send();
    expect(sent()).toEqual([expect.objectContaining({ type: "sendGroup", groupId: room.id, text: "@Quill", mentions: [chief.id] })]);
  });

  it("sends a typed name with no ids, and forgets a pick once its line is sent", () => {
    type(drafts[0]!, "@Qu");
    pick("Quill", "Analyst");
    send();
    type(drafts[0]!, "@Quill check the numbers");
    send();
    expect(sent().map((action) => action.mentions)).toEqual([[analyst.id], []]);
  });

  it("keeps the pick with words a failed send hands back", () => {
    type(drafts[0]!, "@Qu");
    pick("Quill", "Chief of Staff");
    send();
    flushSync(() => sent()[0]!.onError());
    expect(input().value).toBe("@Quill ");
    send();
    expect(sent().map((action) => action.mentions)).toEqual([[chief.id], [chief.id]]);
  });
});

describe("room Point recovery", () => {
  const chip = (selector: string, note: string) => ({ appId: "page", rev: 2, title: "Pricing", tag: "button", role: "button", text: selector, selector, html: `<button>${selector}</button>`, note });

  beforeEach(() => flushSync(() => root.render(createElement(Composer, { group: room, members: [scout, analyst, chief] }))));

  it("keeps failed picks in the outbox and retries the same send without taking a newer draft's picks", () => {
    addPointedChip(room.threadId, chip("original", "make it larger"));
    type(drafts[0]!, "Change this");
    send();
    const first = sent()[0]!;
    type(drafts[0]!, "New request");
    markDraftEdited(drafts[0]!);
    addPointedChip(room.threadId, chip("newer", "leave this alone"));
    flushSync(() => first.onError());
    expect(input().value).toBe("New request");
    const outbox = failedComposerSends(drafts[0]!)[0]!;
    expect(outbox).toMatchObject({ sendId: first.sendId, pointed: first.pointed });
    const current = takePointedChips(room.threadId)!;
    expect(current.pointed.map((point) => point.selector)).toEqual(["newer"]);
    current.restore();
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Retry")!;
    flushSync(() => retry.click());
    expect(sent()[1]).toMatchObject({ type: "sendGroup", sendId: first.sendId, pointed: first.pointed, pointedChips: first.pointedChips });
    flushSync(() => sent()[1]!.onError());
    expect(failedComposerSends(drafts[0]!)[0]).toMatchObject({ sendId: first.sendId, pointed: first.pointed });
  });

  it("restores queued picks and notes only after Edit's confirmed withdrawal", () => {
    addPointedChip(room.threadId, chip("original", "make it larger"));
    addPointedChip(room.threadId, chip("second", "make it blue"));
    type(drafts[0]!, "Change this");
    send();
    const first = sent()[0]!;
    fixture.queued = [{ queueId: "queued-point", text: first.text, pointedChips: first.pointedChips }];
    flushSync(() => root.render(createElement(Composer, { group: room, members: [scout, analyst, chief] })));
    const edit = [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.startsWith("Edit queued message"))!;
    flushSync(() => edit.click());
    const withdrawal = fixture.dispatch.mock.calls.at(-1)![0];
    expect(withdrawal).toMatchObject({ type: "cancelGroupQueued", groupId: room.id, queueId: "queued-point" });
    expect(takePointedChips(room.threadId)).toBeNull();
    flushSync(() => withdrawal.onCancelled());
    expect(input().value).toBe("Change this");
    const restored = takePointedChips(room.threadId)!;
    expect(restored.pointed).toEqual(first.pointed);
    expect(restored.chips.map(({ selector, title, note }) => ({ selector, title, note }))).toEqual([
      { selector: "original", title: "Pricing", note: "make it larger" },
      { selector: "second", title: "Pricing", note: "make it blue" },
    ]);
  });
});

describe("a one-to-one chat's @ list", () => {
  it("sends the picked teammate's id too", () => {
    flushSync(() => root.render(createElement(Composer, { bot: scout })));
    type(drafts[1]!, "ask @Qu");
    pick("Quill", "Analyst");
    send();
    expect(sent()).toEqual([expect.objectContaining({ type: "send", botId: scout.id, text: "ask @Quill", mentions: [analyst.id] })]);
  });
});
