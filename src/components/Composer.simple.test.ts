// @vitest-environment happy-dom
// Simple mode's composer: one pill with unfolded toolbar icon buttons (attach files, optional attach photo,
// Teach a task, Work until done or Finish together with aria-pressed), the field, and one round button in the bot's tone.
// Advanced keeps its row of buttons.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group, Message } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";
import { setCallMode } from "@/lib/call-mode";
import { userBubbleTone } from "@/lib/user-bubble-tone";
import { BOT_BUTTON, botButtonTone } from "@/lib/bot-button";
import { RawPresentation } from "@/lib/raw-presentation";

const fixture = vi.hoisted(() => ({
  advanced: false,
  raw: false,
  admin: true,
  agentsMcp: true,
  images: false,
  dispatch: vi.fn(),
  call: null as Record<string, unknown> | null,
  groupCall: null as Record<string, unknown> | null,
  liveCall: null as unknown,
  config: undefined as unknown,
}));
const ENGINE = "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: fixture.config ?? original.initialState.config, bots: [bot, peer], liveCall: fixture.liveCall, instances: [{
      instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: fixture.agentsMcp, images: fixture.images },
    }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/cloud-guest")>(), useReactor: () => "user" }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, useInterfaceMode: () => fixture.advanced ? "advanced" : "simple", setAdvancedMode: vi.fn() }));
vi.mock("./CallView", () => ({ CallButton: (props: Record<string, unknown>) => {
  fixture.call = props;
  return null;
} }));
vi.mock("./GroupCallView", () => ({ GroupCallButton: (props: Record<string, unknown>) => {
  fixture.groupCall = props;
  return null;
} }));

import { Composer } from "./Composer";

const bot: Bot = {
  id: "atlas", threadId: "atlas-thread", name: "Atlas", title: "", description: "",
  color: "purple", notifications: false, unread: false, busy: false, messages: [], approvalMode: "ask",
  modelSelection: { instanceId: ENGINE, model: "fake" },
};
const peer: Bot = { ...bot, id: "juniper", threadId: "juniper-thread", name: "Juniper", color: "teal" };
const room: Group = {
  id: "room", threadId: "room-thread", name: "Launch planning", memberIds: [bot.id, peer.id],
  defaultResponder: { kind: "member", botId: bot.id }, bulletin: "", unread: false,
  createdAt: 1, setupCompletedAt: 1, messages: [],
};

let root: Root;
let container: HTMLDivElement;
const render = (props: Parameters<typeof Composer>[0]) => flushSync(() => root.render(createElement(RawPresentation.Provider, { value: fixture.raw }, createElement(Composer, props))));
const plus = () => container.querySelector<HTMLElement>("[data-composer-plus]")?.closest("button") ?? null;
const popover = () => document.body.querySelector<HTMLElement>('[data-sidebar-popover-menu="anchored"]');
const click = (element: Element | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => (element as HTMLElement).click());
};
/** The bot's own button: its bubble's fill and ink, with the darker hover and press steps. */
function expectBotButton(button: HTMLElement | null, color: Bot["color"]) {
  const tone = botButtonTone(color);
  expect(button?.className.split(" ")).toContain(BOT_BUTTON);
  expect(button?.style.getPropertyValue("--bot-button")).toBe(tone.fill);
  expect(button?.style.getPropertyValue("--bot-button-ink")).toBe(tone.ink);
  expect(button?.style.getPropertyValue("--bot-button-hover")).toBe(tone.hover);
  expect(button?.style.getPropertyValue("--bot-button-pressed")).toBe(tone.pressed);
}
const sendButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');

beforeEach(() => {
  fixture.advanced = false;
  fixture.raw = false;
  fixture.admin = true;
  fixture.agentsMcp = true;
  fixture.images = false;
  fixture.liveCall = null;
  fixture.config = undefined;
  setCallMode("turns");
  fixture.call = null;
  fixture.groupCall = null;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  for (const id of [`bot:${bot.id}:${bot.threadId}`, `group:${room.id}:${room.threadId}`]) restoreComposerDraft(id, { text: "", attachments: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the Simple composer in a bot chat", () => {
  it("keeps an unresolved quoted source visible and refuses a silent unquoted send", () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "Current request", attachments: [] });
    const onClearReply = vi.fn();
    render({ bot, replyDraftId: "missing-source", replyTo: null, onClearReply });
    const guidance = "Cancel this reply to send a new message.";
    expect(container.querySelector("[data-composer-reply]")?.textContent).toContain("Original message unavailable");
    expect(container.querySelector("[data-composer-reply]")?.textContent).toContain(guidance);
    const input = container.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(input.value).toBe("Current request");
    expect(input.placeholder).toBe(guidance);
    const blockedSend = container.querySelector<HTMLButtonElement>(`button[aria-label="${guidance}"]`)!;
    expect(blockedSend.disabled).toBe(true);
    expect(blockedSend.title).toBe(guidance);
    click(blockedSend);
    expect(fixture.dispatch.mock.calls.some(([action]) => action.type === "send")).toBe(false);
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "error", message: "Cancel this reply to send a new message." });
    expect(fixture.dispatch.mock.calls.some(([action]) => action.type === "send")).toBe(false);
    expect(input.value).toBe("Current request");
    click(container.querySelector('button[aria-label="Cancel reply"]'));
    expect(onClearReply).toHaveBeenCalledOnce();
  });

  it.each([false, true])("sends the current request with its resolved quoted source id, busy=%s", (busy) => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "Current request", attachments: [] });
    const source = { id: "source", role: "bot", kind: "text", at: 1, text: "Earlier answer" } as Message;
    const onConsumeReply = vi.fn();
    render({ bot: { ...bot, busy }, replyDraftId: source.id, replyTo: source, onConsumeReply });
    click(busy ? container.querySelector('button[aria-label="Sends when Atlas is done"]') : sendButton());
    expect(fixture.dispatch.mock.calls.find(([action]) => action.type === "send")?.[0]).toMatchObject({
      text: "Current request", replyToId: "source", threadId: bot.threadId,
    });
    expect(onConsumeReply).toHaveBeenCalledOnce();
  });

  it("is one pill: unfolded icon buttons directly on the bar, the field, and one round button in the bot's tone", () => {
    render({ bot });
    expect(plus()).toBeNull();
    const pill = container.querySelector('[data-tour="composer"]')!.className.split(" ");
    expect(pill).toEqual(expect.arrayContaining(["rounded-[22px]", "bg-composer", "p-2", "ring-[0.5px]", "hover:ring-ink/[0.22]", "focus-within:ring-ink/[0.22]",
      "[transition:border-radius_300ms,box-shadow_150ms]"]));
    expect(pill.filter((name) => name.startsWith("shadow"))).toEqual(["shadow-[0_2px_8px_-1px_rgb(0_0_0/0.05),0_1px_2px_rgb(0_0_0/0.03),0_0_0_1px_rgb(228_228_228/0.04)]"]);
    expect(container.querySelector("[data-composer-row]")!.className).not.toContain("flex-wrap");
    expect(container.querySelector("[data-composer-actions]")!.className.split(" ")).toContain("gap-2");
    const attach = container.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]')!;
    const goal = container.querySelector<HTMLButtonElement>('button[aria-label="Work until done"]')!;
    const teach = container.querySelector<HTMLButtonElement>('button[aria-label="Teach a task"]')!;
    expect(attach.className.split(" ")).toEqual(expect.arrayContaining(["size-7", "bg-ink/[0.05]", "ring-inset", "text-ink-tertiary"]));
    expect(goal.getAttribute("aria-pressed")).toBe("false");
    expect(teach.getAttribute("title")).toBe("Teach a task");
    expect(container.querySelector("[data-approval-chip]")).toBeNull();
    const tone = userBubbleTone("purple");
    expect(fixture.call).toMatchObject({ bot: { id: "atlas" }, placement: "composer", fill: tone.background, ink: tone.ink });
  });

  it("starts a /learn draft from the unfolded Teach a task button, ahead of anything already typed", () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "how I file expenses", attachments: [] });
    render({ bot });
    click(container.querySelector('button[aria-label="Teach a task"]'));
    expect(container.querySelector("textarea")!.value).toBe("/learn how I file expenses");
  });

  it("keeps only Attach files on a DM when skill authoring is off, and opens the file picker straight away", () => {
    fixture.config = { features: { skillAuthoring: false } };
    const picker = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    render({ group: { ...room, dm: true }, members: [bot, peer] });
    const attach = container.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]')!;
    expect(attach.getAttribute("aria-haspopup")).toBeNull();
    expect(container.querySelector('button[aria-label="Teach a task"]')).toBeNull();
    expect(container.querySelector("[data-composer-goal]")).toBeNull();
    click(attach);
    expect(picker).toHaveBeenCalledOnce();
    expect(plus()).toBeNull();
  });

  it("keeps the plain placeholder while the bot works and says what Send does in the bot's terms", () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "and this", attachments: [] });
    render({ bot: { ...bot, busy: true } });
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe("Message Atlas");
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Sends when Atlas is done"]')!;
    expect(send.getAttribute("title")).toBe("Sends when Atlas is done");
  });

  it("rounds its corners in from 22 to 18 once the message takes a second line", () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "one\ntwo", attachments: [] });
    render({ bot });
    const pill = container.querySelector('[data-tour="composer"]')!;
    expect(pill.hasAttribute("data-multiline")).toBe(true);
    expect(pill.className.split(" ")).toContain("rounded-[18px]");
  });

  it("sets the composer on plain canvas from its top edge down, with no fade above it", () => {
    render({ bot });
    const backdrop = container.querySelector("[data-composer-backdrop]")!.className.split(" ");
    expect(backdrop).toEqual(expect.arrayContaining(["bg-app", "top-0", "-bottom-4", "-left-5", "-right-5"]));
    expect(backdrop.some((name) => /gradient|blur|^from-|^to-|^opacity/.test(name))).toBe(false);
  });

  it("keeps Raw's composer backdrop within its 16px gutter", () => {
    fixture.raw = true;
    render({ bot });
    const backdrop = container.querySelector("[data-composer-backdrop]")!.className.split(" ");
    expect(container.querySelector("[data-raw-composer]")).not.toBeNull();
    expect(backdrop).toEqual(expect.arrayContaining(["-left-4", "-right-4"]));
    expect(backdrop).not.toContain("-left-5");
  });

  it("attaches files and photos from the unfolded toolbar buttons", () => {
    fixture.images = true;
    const clicked: HTMLInputElement[] = [];
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      clicked.push(this);
    });
    render({ bot });
    click(container.querySelector('button[aria-label="Attach files"]'));
    click(container.querySelector('button[aria-label="Attach photo"]'));
    expect(clicked).toHaveLength(2);
    expect(clicked[0]!.accept).toBe("");
    expect(clicked[1]!.accept).toBe("image/*");
  });

  it("turns its round button into Send while there is text, in the bot's colour", () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "hello", attachments: [] });
    render({ bot });
    const send = sendButton()!;
    expect(send.className.split(" ")).toContain("size-7");
    expectBotButton(send, "purple");
    expect(send.className).not.toMatch(/\bbg-accent\b|brightness/);
    expect(fixture.call).toBeNull();
    render({ bot: { ...bot, color: "yellow" } });
    expectBotButton(sendButton(), "yellow");
  });

  it("keeps Call beside Stop while the bot works, including while typing", () => {
    const busy = { ...bot, busy: true };
    render({ bot: busy });
    const slot = container.querySelector<HTMLButtonElement>('[data-composer-stop="slot"]')!;
    expect(slot.getAttribute("aria-label")).toBe("Stop this turn");
    expectBotButton(slot, "purple");
    expect(fixture.call).toMatchObject({ bot: { id: "atlas" }, placement: "composer" });
    click(slot);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "interrupt", botId: "atlas", threadId: "atlas-thread" });

    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "and also this", attachments: [] });
    fixture.call = null;
    render({ bot: busy });
    expect(container.querySelector('[data-composer-stop="beside"]')).not.toBeNull();
    expect(container.querySelector('[data-composer-stop="slot"]')).toBeNull();
    expect(fixture.call).toMatchObject({ bot: { id: "atlas" }, placement: "composer" });
  });

  it("stops the exact parked thread without treating an idle bot or another thread as busy", () => {
    render({ bot, needsInputStop: true });
    const stop = container.querySelector<HTMLButtonElement>('[data-composer-stop="slot"]');
    expect(stop?.getAttribute("aria-label")).toBe("Stop this turn");
    click(stop);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "interrupt", botId: bot.id, threadId: bot.threadId });
    render({ bot, needsInputStop: false });
    expect(container.querySelector("[data-composer-stop]")).toBeNull();
  });

  it("shows the approval level as a chip only while this conversation overrides the bot, in the panel's words", () => {
    render({ bot: { ...bot, approvalMode: "full" } });
    expect(container.querySelector("[data-approval-chip]")).toBeNull();
    const task = { threadId: bot.threadId, title: "New thread", createdAt: 1 };
    render({ bot: { ...bot, tasks: [{ ...task, approvalMode: "full" }] } });
    const chip = container.querySelector("[data-approval-chip]")!;
    expect(chip.getAttribute("data-approval-chip")).toBe("full");
    expect(chip.textContent).toBe("Full access");
    click(chip.closest("button"));
    const level = popover()!;
    expect(level.textContent).toContain("Ask for approval");
    expect(level.textContent).toContain("Command allowlist");
    expect(level.querySelector('[data-menu-key="approval:full"] .lucide-check')).not.toBeNull();
    click(level.querySelector('[data-menu-key="approval:ask"]'));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateTask", botId: "atlas", threadId: "atlas-thread", patch: { approvalMode: "ask" } });
  });

  it("shows Work until done as an unfolded toggle button with aria-pressed and turns it off on click", () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "", attachments: [], channelMode: "goal" });
    render({ bot });
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Work until done"]')!;
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.className.split(" ")).toEqual(expect.arrayContaining(["size-7", "bg-accent/15", "text-accent"]));
    click(button);
    expect(container.querySelector('button[aria-label="Work until done"]')?.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("the composer after Set me up", () => {
  it("asks for the job and shows a chip to stop it while the conversation waits, and neither once it does not", () => {
    render({ bot: { ...bot, tasks: [{ threadId: bot.threadId, title: "New thread", createdAt: 1, setupRequest: { at: 2 } }] } });
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe("Tell Atlas what you'd like help with");
    expect(container.querySelector("[data-setup-request]")?.textContent).toContain("Atlas is ready to be set up");
    expect(container.querySelector(`[aria-label="Stop setting up Atlas"]`)).not.toBeNull();
    render({ bot: { ...bot, tasks: [{ threadId: bot.threadId, title: "New thread", createdAt: 1 }] } });
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe("Message Atlas");
    expect(container.querySelector("[data-setup-request]")).toBeNull();
  });
});

describe("the Simple composer in a group chat", () => {
  it("unfolds Finish together directly on the bar with aria-pressed", () => {
    render({ group: room, members: [bot, peer] });
    const goal = container.querySelector<HTMLButtonElement>('button[aria-label="Finish together"]')!;
    expect(goal.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe("Message Launch planning");
    expect(fixture.groupCall).toMatchObject({ group: { id: "room" }, placement: "composer", fill: "var(--color-accent)", ink: "var(--color-accent-ink)" });
    restoreComposerDraft(`group:${room.id}:${room.threadId}`, { text: "hello room", attachments: [] });
    render({ group: room, members: [bot, peer] });
    const send = sendButton()!;
    expect(send.className.split(" ")).not.toContain(BOT_BUTTON);
    expect(send.style.backgroundColor).toBe("var(--color-accent)");
    expect(send.style.color).toBe("var(--color-accent-ink)");
    restoreComposerDraft(`group:${room.id}:${room.threadId}`, { text: "", attachments: [] });
    render({ group: room, members: [bot, peer] });
    click(container.querySelector('button[aria-label="Finish together"]'));
    expect(container.querySelector('button[aria-label="Finish together"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toContain("finish together");
    click(container.querySelector('button[aria-label="Finish together"]'));
    expect(container.querySelector('button[aria-label="Finish together"]')?.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the room's @ hint only when the room answers to mentions", () => {
    render({ group: { ...room, defaultResponder: { kind: "mentions" } }, members: [bot, peer] });
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe("Message Launch planning (@ to bring a bot in)");
  });
});

describe("the Advanced composer", () => {
  it("keeps the paperclip, the approval shield and the split call button, with no +, on Simple's floating surface", () => {
    fixture.advanced = true;
    render({ bot });
    expect(plus()).toBeNull();
    expect(container.querySelector('[data-tour="composer"]')!.className.split(" ")).toEqual(expect.arrayContaining(["rounded-2xl", "bg-composer", "ring-[0.5px]", "shadow-(--shadow-float)"]));
    expect(container.querySelector('button[aria-label="Attach a file"]')).not.toBeNull();
    expect(container.querySelector('[aria-haspopup="menu"][aria-label$="for Claude"]')).not.toBeNull();
    expect(fixture.call).toMatchObject({ placement: "composer" });
    expect(fixture.call?.fill).toBeUndefined();
    expect(container.querySelector("[data-composer-backdrop]")!.className.split(" ")).toContain("top-1/2");
  });

  it("offers Teach a task as its own button, which starts a /learn draft ahead of anything typed", () => {
    fixture.advanced = true;
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "how I file expenses", attachments: [] });
    render({ bot });
    const teach = container.querySelector<HTMLButtonElement>('button[aria-label="Teach a task"]');
    expect(teach).not.toBeNull();
    click(teach);
    expect(container.querySelector("textarea")!.value).toBe("/learn how I file expenses");
  });

  it("leaves Teach a task out when skill authoring is off", () => {
    fixture.advanced = true;
    fixture.config = { features: { skillAuthoring: false } };
    render({ bot });
    expect(container.querySelector('button[aria-label="Teach a task"]')).toBeNull();
  });

  it("leaves Teach a task out when the bot's engine can't run agents", () => {
    fixture.advanced = true;
    fixture.agentsMcp = false;
    render({ bot });
    expect(container.querySelector('button[aria-label="Teach a task"]')).toBeNull();
  });

  it("sends with the bot's own button too, and keeps the accent in a room", () => {
    fixture.advanced = true;
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "hello", attachments: [] });
    render({ bot: { ...bot, color: "teal" } });
    const send = sendButton()!;
    expect(send.className.split(" ")).toContain("size-8");
    expectBotButton(send, "teal");
    expect(send.className).not.toMatch(/\bbg-accent\b|text-white/);
    restoreComposerDraft(`group:${room.id}:${room.threadId}`, { text: "hello room", attachments: [] });
    render({ group: room, members: [bot, peer] });
    expect(sendButton()!.className.split(" ")).not.toContain(BOT_BUTTON);
    expect(sendButton()!.style.backgroundColor).toBe("var(--color-accent)");
  });

  it("keeps the room's Goal chip and its header call button", () => {
    fixture.advanced = true;
    render({ group: room, members: [bot, peer] });
    expect(container.querySelector('[aria-label="Finish together"]')?.getAttribute("aria-pressed")).toBe("false");
    expect(fixture.groupCall).toBeNull();
  });

  describe("with a message longer than one line", () => {
    const type = (value: string) => {
      const field = container.querySelector("textarea")!;
      flushSync(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const classes = (selector: string) => container.querySelector(selector)!.className.split(" ");
    const stacked = () => classes(".mention-editor").includes("basis-full");
    /** A field 20 characters wide: longer text wraps onto a second 24px line. */
    const wrapPast20 = () => vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLTextAreaElement) { return this.value.length > 20 ? 48 : 24; });

    it("gives the text the full width above the buttons, and puts it back beside them on one line", () => {
      fixture.advanced = true;
      render({ bot });
      expect(stacked()).toBe(false);
      type("Okay I have done my outreach.\nAnother line of text.");
      expect(classes(".mention-editor")).toEqual(expect.arrayContaining(["order-first", "basis-full"]));
      expect(classes("[data-composer-row]")).toContain("flex-wrap");
      expect(classes("[data-composer-actions]")).toContain("ml-auto");
      type("Okay I have done my outreach.");
      expect(stacked()).toBe(false);
      expect(classes("[data-composer-row]")).not.toContain("flex-wrap");
    });

    it("stacks once the text wraps beside the buttons, and stays stacked until it is shorter than where it wrapped", () => {
      wrapPast20();
      fixture.advanced = true;
      render({ bot });
      type("a".repeat(25));
      expect(stacked()).toBe(true);
      // Wider on its own line, it would fit on one row there; it still must not flip back and forth.
      type("a".repeat(30));
      expect(stacked()).toBe(true);
      type("a".repeat(24));
      expect(stacked()).toBe(true);
      type("a".repeat(10));
      expect(stacked()).toBe(false);
    });

    it("measures each new message afresh, so a wrap from a narrower composer does not stick", () => {
      const wrap = wrapPast20();
      fixture.advanced = true;
      render({ bot });
      type("a".repeat(25));
      expect(stacked()).toBe(true);
      type("");
      // Wider now: 30 characters fit on the one row.
      wrap.mockImplementation(function (this: HTMLTextAreaElement) { return this.value.length > 40 ? 48 : 24; });
      type("a".repeat(30));
      expect(stacked()).toBe(false);
    });

    it("never stacks an empty field, even when its placeholder wraps", () => {
      vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(48);
      fixture.advanced = true;
      render({ bot });
      expect(stacked()).toBe(false);
    });

    it("leaves Simple's pill alone", () => {
      wrapPast20();
      render({ bot });
      type("a".repeat(25) + "\nb");
      expect(stacked()).toBe(false);
      expect(classes("[data-composer-row]")).not.toContain("flex-wrap");
    });
  });
});

it.each([false, true])("keeps Call for a shared viewer without Stop permission (waiting for teammates: %s)", waiting => {
  fixture.admin = false;
  fixture.config = { team: true };
  const shared: Bot = { ...bot, tasks: [{ threadId: bot.threadId, title: "Shared", createdAt: 1, busy: !waiting, waitingForTeammates: waiting, askedBy: { id: "other-person", name: "Other person" } }] };
  restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "Follow-up from another viewer", attachments: [] });
  render({ bot: shared });
  expect(container.querySelector('[aria-label="Stop this turn"]')).toBeNull();
  expect(fixture.call).toMatchObject({ bot: { id: "atlas" }, placement: "composer" });
});
