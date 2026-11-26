import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { RawPresentation } from "@/lib/raw-presentation";
import { contrastRatio } from "@/lib/color-contrast";

const fixture = vi.hoisted(() => ({ colorMine: false }));

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test" } as InstanceInfo] }, dispatch: vi.fn() }) };
});
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => false, useShowThreadsChoice: () => false, setShowThreads: vi.fn() }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, useInterfaceMode: () => "simple", setAdvancedMode: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useReactor: () => "user" }));
vi.mock("./CitationUI", () => ({ CitationSelectionToolbar: () => null, SentCitations: () => null }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: () => null }));
vi.mock("@/lib/user-bubble-preference", () => ({ useColorUserBubbles: () => fixture.colorMine }));

const { ChatView } = await import("./ChatView");
const { userBubbleTone } = await import("@/lib/user-bubble-tone");
const { rawUserBubbleStyle } = await import("@/lib/raw-presentation");

const bot: Bot = {
  id: "bot", threadId: "selected", name: "Sample", title: "", description: "", color: "yellow",
  notifications: true, unread: false, busy: false, messages: [
    { id: "u", role: "user", kind: "text", at: 1, text: "hello from me" },
    { id: "b", role: "bot", kind: "text", at: 2, text: "hello back" },
  ],
  modelSelection: { instanceId: "test", model: "profile-default" },
  tasks: [{ threadId: "selected", title: "Selected", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "thread-model" }, approvalMode: "ask" }],
};

afterEach(() => { fixture.colorMine = false; vi.unstubAllGlobals(); });

beforeEach(() => {
  vi.stubGlobal("window", {});
});

describe("bot-colored user bubbles", () => {
  it("uses black for the main bot and each ordinary bot's own color in Raw", () => {
    const renderRaw = (candidate: Bot) => renderToStaticMarkup(createElement(RawPresentation, { value: true }, createElement(ChatView, { bot: candidate })));
    const main = renderRaw({ ...bot, defaultBot: {} });
    expect(main).toContain("background-color:#1c1c1c");
    expect(main).toContain("--color-bubble-user-ink:#fcfcfc");
    const ordinary = renderRaw(bot);
    expect(ordinary).toContain(`background-color:${userBubbleTone("yellow").background}`);
    expect(ordinary).not.toContain("background-color:#1c1c1c");
  });

  it("keeps a long quoted main-bot message readable beyond its body text", () => {
    const long = { ...bot, defaultBot: {}, messages: [...bot.messages, { id: "long", role: "user" as const, kind: "text" as const, at: 3, text: "word ".repeat(160), replyToId: "b" }] };
    const html = renderToStaticMarkup(createElement(RawPresentation, { value: true }, createElement(ChatView, { bot: long })));
    expect(html).toContain("Show full message");
    expect(html).toContain("data-reply-quote");
    const style = rawUserBubbleStyle("yellow", true) as Record<string, string>;
    for (const token of ["--color-ink", "--color-ink-secondary", "--color-ink-tertiary", "--color-accent", "--color-danger", "--color-success"]) {
      expect(contrastRatio(style[token]!, style.backgroundColor), token).toBeGreaterThanOrEqual(4.5);
      expect(html).toContain(`${token}:${style[token]}`);
    }
    expect(html).toContain(`--color-inset:${style["--color-inset"]}`);
    expect(html).toContain(`--color-raised:${style["--color-raised"]}`);
    expect(html).toContain(`--bubble-selection:${style["--bubble-selection"]}`);
  });

  it("keeps the skin bubble when the setting is off", () => {
    const html = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(html).toContain("bg-bubble-user");
    expect(html).not.toContain("user-bubble-colored");
    expect(html).toContain("hello from me");
  });

  it("paints the person's bubble in one flat tone of the bot, with readable text", () => {
    fixture.colorMine = true;
    const tone = userBubbleTone("yellow");
    const html = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(html).toContain("user-bubble-colored");
    expect(html).toContain(`background-color:${tone.background}`);
    expect(html).toContain("background-image:none");
    expect(html).not.toContain(tone.gradient);
    expect(html).toContain(`--color-ink:${tone.ink}`);
    expect(html).toContain("hello from me");
    const mine = html.indexOf("user-bubble-colored");
    const reply = html.indexOf("hello back");
    expect(mine).toBeGreaterThan(-1);
    expect(html.slice(reply - 80, reply)).not.toContain(tone.background);
  });
});

it("marks a steered message as sent mid-turn without claiming the bot read it", () => {
  const steered: Bot = {
    ...bot,
    messages: [{ ...bot.messages[0]!, steered: true }, bot.messages[1]!],
  };
  const html = renderToStaticMarkup(createElement(ChatView, { bot: steered }));

  expect(html).toContain(">sent mid-turn</div>");
  expect(html).not.toContain("It saw this before its next step");
});

describe("progressive intake labels on user messages", () => {
  it("renders optimistic received state immediately while busy and updates calmly through folding, processing, worker answer, and superseded", () => {
    const busyBot: Bot = {
      ...bot,
      busy: true,
      tasks: [{ ...bot.tasks![0]!, busy: true }],
      messages: [
        { id: "optimistic-send-1", role: "user", kind: "text", at: 10, text: "Queued without stopping" },
      ],
    };
    expect(renderToStaticMarkup(createElement(ChatView, { bot: busyBot }))).toContain(">Received</span>");

    const foldingBot: Bot = {
      ...busyBot,
      messages: [
        {
          id: "u-fold",
          role: "user",
          kind: "text",
          at: 11,
          text: "Fold this in",
          intake: { mode: "progressive-continue", state: "folding", targetTurnId: "t1", updatedAt: 12 },
        },
      ],
    };
    const foldingHtml = renderToStaticMarkup(createElement(ChatView, { bot: foldingBot }));
    expect(foldingHtml).toContain('data-intake-state="folding"');
    expect(foldingHtml).toContain(">Folding in…</span>");

    const workerBot: Bot = {
      ...busyBot,
      messages: [
        {
          id: "u-work",
          role: "user",
          kind: "text",
          at: 15,
          text: "Quick side question",
          intake: { mode: "readonly-concurrent", state: "processing", workerTurnId: "w1", updatedAt: 16 },
        },
        {
          id: "b-work",
          role: "bot",
          kind: "text",
          at: 20,
          text: "Direct read-only answer",
          replyToId: "u-work",
          turnId: "w1",
          concurrentWorker: { workerId: "cw-1", readOnly: true, parentTurnId: "t1" },
        },
      ],
    };
    const workerHtml = renderToStaticMarkup(createElement(ChatView, { bot: workerBot }));
    expect(workerHtml).toContain('data-intake-state="answered"');
    expect(workerHtml).toContain(">Replied directly</span>");
    expect(workerHtml).toContain('data-concurrent-worker="cw-1"');
    expect(workerHtml).toContain(">Parallel answer</div>");

    const supersededBot: Bot = {
      ...busyBot,
      messages: [
        {
          id: "u-old",
          role: "user",
          kind: "text",
          at: 25,
          text: "Older request",
          intake: { mode: "soft-redirect", state: "superseded", updatedAt: 26 },
        },
      ],
    };
    const supersededHtml = renderToStaticMarkup(createElement(ChatView, { bot: supersededBot }));
    expect(supersededHtml).toContain('data-intake-state="superseded"');
    expect(supersededHtml).toContain(">Replaced by newer message</span>");
  });
});
