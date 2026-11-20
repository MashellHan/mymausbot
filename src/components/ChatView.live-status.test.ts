// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import type { RuntimeEvent } from "../../shared/runtime-events";
import { loadLocalePack } from "@/locales";
import { activeLocale, setLocale } from "@/lib/i18n";
import type { ApprovalModeSelector } from "./ApprovalModeSelector";
import type { ModelPicker } from "./ModelPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: null, instances: [{ instanceId: "test", driverKind: "claudeAgent", displayName: "Test" } as InstanceInfo] },
    dispatch,
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/thread-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/thread-preferences")>(),
  useShowThreads: () => true,
}));
const mode = vi.hoisted(() => ({ advanced: true }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => mode.advanced, useInterfaceMode: () => mode.advanced ? "advanced" : "simple", setAdvancedMode: vi.fn() }));
vi.mock("./SidebarPopoverMenu", async (importOriginal) => ({
  ...await importOriginal<typeof import("./SidebarPopoverMenu")>(),
  SidebarPopoverMenu: (props: { renderTrigger: (state: { open: boolean }) => unknown }) => props.renderTrigger({ open: false }),
}));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => null, useReactor: () => "user" }));
vi.mock("./CitationUI", async (importOriginal) => ({
  ...await importOriginal<typeof import("./CitationUI")>(),
  CitationSelectionToolbar: () => createElement("span"),
}));
vi.mock("./ModelPicker", () => ({ ModelPicker: (_props: ComponentProps<typeof ModelPicker>) => createElement("span") }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: (_props: ComponentProps<typeof ApprovalModeSelector>) => createElement("span") }));

const { ChatView } = await import("./ChatView");
const { noteTurnEvent, resetTurnLive } = await import("@/state/turn-status");
const { useActivityFocus } = await import("@/lib/activity-focus");

const THREAD = "selected";
const started = Date.UTC(2026, 9, 23, 12, 0, 0);
const busyBot = (messages: Message[], busy = true): Bot => ({
  id: "bot", threadId: THREAD, name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy, activity: busy ? "working" : "idle", turnStartedAt: busy ? started : undefined, messages,
  modelSelection: { instanceId: "test", model: "profile-default" },
  tasks: [{ threadId: THREAD, title: "Dashboard", createdAt: 1, busy, activity: busy ? "working" : "idle", turnStartedAt: busy ? started : undefined,
    modelSelection: { instanceId: "test", model: "thread-model" }, approvalMode: "full" }],
});
const ask: Message = { id: "ask", role: "user", kind: "text", at: started, text: "Build me a sales dashboard" };
const intro: Message = { id: "intro", role: "bot", kind: "text", at: started + 5_000, text: "I'll build the dashboard now.", turnId: "t1" };

let seq = 0;
const engine = (event: Partial<RuntimeEvent>) => act(() => noteTurnEvent({
  eventId: `e${++seq}`, provider: "claudeAgent", threadId: THREAD, createdAt: new Date().toISOString(), turnId: "t1", ...event,
} as RuntimeEvent));

let host: HTMLDivElement;
let root: Root;
const render = (shown: Bot) => act(() => root.render(createElement(ChatView, { bot: shown })));
const mascot = () => host.querySelector(".turn-presence");
/** The line as it reads: the phrase fading out is not part of it. */
const statusLine = () => {
  const line = host.querySelector("[data-turn-status]")?.cloneNode(true) as HTMLElement | undefined;
  line?.querySelectorAll(".turn-phrase-out").forEach((node) => node.remove());
  return line?.textContent?.replace(/\s+/g, " ").trim() ?? null;
};

beforeEach(() => {
  vi.useFakeTimers({ now: started + 72_000 });
  resetTurnLive();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  mode.advanced = true;
  setLocale("en");
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Simple mode's working line", () => {
  it("shows ACP execution only after a running signal and clears it for permission waits", () => {
    mode.advanced = false;
    engine({ type: "turn.started", requestMessageId: ask.id });
    render(busyBot([ask]));
    engine({ type: "item.started", itemType: "tool", itemId: "acp", title: "Command", toolState: "pending" });
    engine({ type: "turn.progress", activity: "command", itemId: "acp", toolState: "pending", target: "fixture-private-command" });
    expect(statusLine()).toBe("");
    engine({ type: "turn.progress", activity: "command", itemId: "acp", toolState: "running" });
    expect(statusLine()).toBe("Running a command");
    engine({ type: "request.opened", requestType: "permission", requestId: "permission", tool: "Command", summary: "fixture-private-approval" });
    expect(statusLine()).toBe("");
    engine({ type: "item.completed", itemType: "tool", itemId: "acp", ok: false });
    expect(statusLine()).toBe("");
    expect(mascot()?.outerHTML).not.toContain("fixture-private");
  });

  it("keeps the existing avatar and shows a safe phrase only after a tool starts", () => {
    mode.advanced = false;
    engine({ type: "turn.started" });
    render(busyBot([ask]));
    expect(mascot()).not.toBeNull();
    expect(statusLine()).toBe("");
    expect(mascot()!.innerHTML).toContain('width="28px"');
    const row = mascot()!.firstElementChild as HTMLElement;
    expect([...row.classList]).toEqual(expect.arrayContaining(["h-9", "ps-2", "gap-2"]));
    expect(row.title).toBe("1m 12s");
    expect(mascot()!.querySelector("[data-turn-status]")!.classList).toContain("text-ink-tertiary");
    expect(mascot()!.classList).not.toContain("-mt-3");

    engine({ type: "item.completed", itemType: "assistant_text", text: intro.text! } as Partial<RuntimeEvent>);
    render(busyBot([ask, intro]));
    expect(mascot()!.classList, "under the bot's own bubble it sits close, as one more part of the reply").toContain("-mt-3");
    // The reply that just arrived pops in first; the line comes back once it has.
    act(() => void vi.advanceTimersByTime(600));
    engine({ type: "turn.progress", activity: "write", itemId: "toolu_write", file: "index.html", bytes: 14 * 1024 + 300 } as Partial<RuntimeEvent>);
    expect(statusLine()).toBe("");
    engine({ type: "item.started", itemType: "tool", itemId: "toolu_write", title: "Write" });
    expect(statusLine()).toBe("Writing a file");
    expect(row.title).not.toContain("index.html");
  });

  it("says Teammates working while the bot waits on its teammates", () => {
    mode.advanced = false;
    const waiting = busyBot([ask, intro], false);
    render({ ...waiting, waitingForTeammates: true, tasks: waiting.tasks!.map((task) => ({ ...task, waitingForTeammates: true })) });
    expect(statusLine()).toBe("Teammates working");
  });
});

describe("the mascot and its status line through a long turn", () => {
  it("stays after the bot's words while a started file tool runs", () => {
    engine({ type: "turn.started" });
    engine({ type: "item.completed", itemType: "assistant_text", text: intro.text! } as Partial<RuntimeEvent>);
    render(busyBot([ask, intro]));
    expect(mascot(), "the bot said a sentence mid-turn: the mascot must not vanish").not.toBeNull();
    expect(statusLine()).toBe("1m 12s");

    engine({ type: "turn.progress", activity: "write", itemId: "toolu_write", bytes: 0 } as Partial<RuntimeEvent>);
    engine({ type: "turn.progress", activity: "write", itemId: "toolu_write", file: "index.html", bytes: 14 * 1024 + 300 } as Partial<RuntimeEvent>);
    expect(statusLine()).toBe("1m 12s");
    engine({ type: "item.started", itemType: "tool", itemId: "toolu_write", title: "Write" });
    expect(statusLine()).toBe("1m 12s · Writing a file");

    act(() => void vi.advanceTimersByTime(10 * 60_000));
    expect(mascot()).not.toBeNull();
    expect(statusLine()).toBe("11m 12s · Writing a file");
  });

  it("stays through a long silent tool, keeping the call's own words while it runs", () => {
    const bash: Message = { id: "bash", role: "bot", kind: "activity", at: started + 6_000, turnId: "t1", tool: { name: "Bash", itemId: "toolu_bash" } };
    engine({ type: "turn.progress", activity: "command", itemId: "toolu_bash", bytes: 20 } as Partial<RuntimeEvent>);
    engine({ type: "item.started", itemType: "tool", itemId: "toolu_bash", title: "Bash" } as Partial<RuntimeEvent>);
    render(busyBot([ask, intro, bash]));
    expect(statusLine()).toBe("1m 12s · Running a command");
    for (let beat = 0; beat < 20; beat++) {
      act(() => void vi.advanceTimersByTime(30_000));
      engine({ type: "item.updated", itemType: "tool" } as Partial<RuntimeEvent>);
    }
    expect(mascot()).not.toBeNull();
    expect(statusLine()).toBe("11m 12s · Running a command");

    engine({ type: "item.completed", itemType: "tool", itemId: "toolu_bash", ok: true } as Partial<RuntimeEvent>);
    render(busyBot([ask, intro, { ...bash, tool: { ...bash.tool!, ok: true } }]));
    expect(statusLine(), "with nothing reported, the line is its timer alone").toBe("11m 12s");
  });

  it("clears when the turn ends, even before busy winds down", () => {
    engine({ type: "turn.progress", activity: "write", itemId: "toolu_write", file: "index.html", bytes: 15_000 } as Partial<RuntimeEvent>);
    render(busyBot([ask, intro]));
    expect(mascot()).not.toBeNull();

    const done: Message = { id: "done", role: "bot", kind: "text", at: started + 80_000, text: "Done: index.html is ready.", turnId: "t1" };
    engine({ type: "item.started", itemType: "tool", itemId: "toolu_write", title: "Write" } as Partial<RuntimeEvent>);
    engine({ type: "item.completed", itemType: "tool", itemId: "toolu_write", ok: true } as Partial<RuntimeEvent>);
    engine({ type: "item.completed", itemType: "assistant_text", text: done.text! } as Partial<RuntimeEvent>);
    render(busyBot([ask, intro, done]));
    engine({ type: "turn.completed", ok: true } as Partial<RuntimeEvent>);
    act(() => void vi.advanceTimersByTime(600));
    expect(mascot(), "the reply settled and the turn ended: busy is still on, the mascot is not").toBeNull();
    expect(statusLine()).toBeNull();

    render(busyBot([ask, intro, done], false));
    expect(mascot()).toBeNull();
  });

  it("hides while the bot waits on the person, and the next turn starts clean", () => {
    engine({ type: "turn.progress", activity: "edit", itemId: "toolu_edit", file: "app.ts", bytes: 2048 } as Partial<RuntimeEvent>);
    const asking = busyBot([ask, intro]);
    render({ ...asking, activity: "waiting-on-you", tasks: asking.tasks!.map((task) => ({ ...task, activity: "waiting-on-you" })) });
    expect(mascot()).toBeNull();

    engine({ type: "turn.completed", ok: true } as Partial<RuntimeEvent>);
    const next: Message = { id: "next", role: "user", kind: "text", at: started + 90_000, text: "Add a chart" };
    render(busyBot([ask, intro, next]));
    expect(statusLine(), "the timer can show before the new turn's first frame").toBe("1m 12s");
    engine({ type: "turn.started", turnId: "t2" } as Partial<RuntimeEvent>);
    engine({ type: "content.delta", turnId: "t2", streamKind: "reasoning_text", delta: "Plan the chart" } as Partial<RuntimeEvent>);
    expect(statusLine()).toBe("1m 12s");
    expect(mascot()?.textContent).not.toContain("Plan the chart");
    engine({ type: "turn.wait_started", turnId: "t2", resource: "browser:private-seat", holder: { name: "private-holder" } });
    expect(statusLine()).toBe("1m 12s · Waiting for computer access");
    expect(mascot()?.outerHTML).not.toContain("private-");
    engine({ type: "turn.wait_ended", turnId: "t2", resource: "browser:private-seat", outcome: "acquired", waitedMs: 200 });
    expect(statusLine()).toBe("1m 12s");
  });
});

describe("what the bot is doing right now", () => {
  const search: Message = { id: "search", role: "bot", kind: "activity", at: started + 4_000, turnId: "t1",
    tool: { name: "WebSearch", itemId: "s1", ok: true, step: { activity: "web", target: "Acme construction leads" } } };
  const bash: Message = { id: "bash", role: "bot", kind: "activity", at: started + 6_000, turnId: "t1",
    tool: { name: "Bash", itemId: "b1", step: { activity: "command", target: "scrape.py", detail: "python3 scrape.py --pages 40" } } };
  const toggle = () => host.querySelector<HTMLButtonElement>(".turn-presence button[aria-expanded]");
  const steps = () => [...host.querySelectorAll("[data-now-step]")].map((step) => `${step.getAttribute("data-now-step")}: ${step.querySelector("[dir=auto]")?.textContent}`);

  it("keeps raw step details in the explicit activity card and opens the Activity panel for this run", () => {
    engine({ type: "turn.started" });
    engine({ type: "item.started", itemType: "tool", itemId: "b1", title: "Bash" } as Partial<RuntimeEvent>);
    engine({ type: "turn.progress", activity: "command", itemId: "b1", target: "scrape.py", detail: "python3 scrape.py --pages 40", quiet: { kind: "busy" } } as Partial<RuntimeEvent>);
    render(busyBot([ask, search, bash]));
    expect(statusLine()).toBe("1m 12s · Running a command");
    expect(host.querySelector("[data-turn-now]")?.getAttribute("title")).toBeNull();
    expect(mascot()?.outerHTML).not.toContain("scrape.py");
    expect(toggle()?.getAttribute("aria-label")).toBe("What Pepper is doing");
    expect(host.querySelector("[data-now-card]")).toBeNull();

    act(() => toggle()!.click());
    expect(steps()).toEqual(["done: Searched the web for “Acme construction leads”", "now: Running scrape.py"]);
    expect(host.querySelector("[data-now-step] [title]")).toBeNull();
    const seen: Array<ReturnType<typeof useActivityFocus>> = [];
    const probe = createRoot(document.createElement("div"));
    act(() => probe.render(createElement(() => { seen.push(useActivityFocus("bot")); return null; })));
    act(() => [...host.querySelectorAll<HTMLButtonElement>("[data-now-card] button")].find((button) => button.textContent === "Open activity")!.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleActivity", open: true });
    expect(seen.at(-1)).toEqual({ botId: "bot", threadId: THREAD, turnId: "t1" });
    act(() => probe.unmount());
  });

  it("shows running command output in the opened card", () => {
    engine({ type: "turn.started" });
    engine({ type: "item.started", itemType: "tool", itemId: "b1", title: "Bash" } as Partial<RuntimeEvent>);
    engine({ type: "turn.progress", activity: "command", itemId: "b1", target: "scrape.py", quiet: { kind: "output", at: started + 72_000 - 125_000 },
      tail: ["page 39 of 40", "page 40 of 40"] } as Partial<RuntimeEvent>);
    render(busyBot([ask, bash]));
    expect(statusLine()).toBe("1m 12s · Running a command");
    act(() => toggle()!.click());
    expect(host.querySelector("[data-now-output]")?.textContent).toBe("page 39 of 40\npage 40 of 40");
  });

  it("is the same calm line in Simple mode, where the card unfolds too", () => {
    mode.advanced = false;
    engine({ type: "turn.started" });
    engine({ type: "item.started", itemType: "tool", itemId: "b1", title: "Bash" } as Partial<RuntimeEvent>);
    engine({ type: "turn.progress", activity: "command", itemId: "b1", target: "scrape.py", quiet: { kind: "idle" } } as Partial<RuntimeEvent>);
    render(busyBot([ask, search, bash]));
    expect(statusLine()).toBe("Running a command");
    act(() => toggle()!.click());
    expect(steps()).toEqual(["done: Searched the web for “Acme construction leads”", "now: Running scrape.py"]);
  });
});

describe("verified automation updates in the accepted turn language", () => {
  it("uses the app language for a routine-generated user-role row", async () => {
    await loadLocalePack("zh");
    setLocale("zh");
    mode.advanced = false;
    const routine = { ...ask, automated: true, text: "Update the daily automation schedule tomorrow." };
    engine({ type: "turn.started", requestMessageId: routine.id });
    render(busyBot([routine]));
    engine({ type: "turn.progress", activity: "tool", itemId: "update", automation: { action: "update", phase: "started" } });
    expect(statusLine()).toBe("正在更新自动化");
    expect(host.querySelector("[data-turn-status]")?.getAttribute("lang")).toBe("zh");
  });

  it("uses the current operation and ignores a different finish or a retired turn", () => {
    mode.advanced = false;
    engine({ type: "turn.started", requestMessageId: ask.id });
    render(busyBot([ask]));
    for (const [action, label] of [
      ["view", "Checking automations"], ["create", "Creating automation"],
      ["update", "Updating automation"], ["pause", "Pausing automation"],
    ] as const) {
      engine({ type: "turn.progress", activity: "tool", itemId: action, automation: { action, phase: "started" } });
      expect(statusLine()).toBe(label);
      engine({ type: "turn.progress", activity: "tool", itemId: "other", automation: { action, phase: "finished" } });
      expect(statusLine()).toBe(label);
      act(() => vi.advanceTimersByTime(600));
      engine({ type: "turn.progress", activity: "tool", itemId: action, automation: { action, phase: "finished" } });
      expect(statusLine()).toBe("");
    }
    engine({ type: "turn.started", turnId: "t2" });
    engine({ type: "turn.progress", activity: "tool", itemId: "late", automation: { action: "update", phase: "started" } });
    expect(statusLine()).toBe("");
    engine({ type: "content.delta", streamKind: "assistant_text", turnId: "t2", delta: "Replying" });
    expect(statusLine()).toBe("Writing a reply");
  });

  it("renders a verified operation when start and finish are batched before paint", () => {
    mode.advanced = false;
    engine({ type: "turn.started", requestMessageId: ask.id });
    render(busyBot([ask]));
    const fast = (id: string, action: "view" | "update" | "pause") => act(() => {
      engine({ type: "turn.progress", activity: "tool", itemId: id, automation: { action, phase: "started" } });
      engine({ type: "turn.progress", activity: "tool", itemId: id, automation: { action, phase: "finished" } });
    });
    fast("update", "update");
    expect(statusLine()).toBe("Updating automation");
    act(() => vi.advanceTimersByTime(400));
    expect(statusLine()).toBe("Updating automation");
    act(() => vi.advanceTimersByTime(101));
    expect(statusLine()).toBe("");

    fast("view", "view");
    expect(statusLine()).toBe("Checking automations");
    fast("pause", "pause");
    expect(statusLine()).toBe("Pausing automation");
    engine({ type: "item.started", itemType: "tool", itemId: "read", step: { activity: "read", target: "private-path" } });
    expect(statusLine()).toBe("Reading a file");
    expect(mascot()?.outerHTML).not.toContain("private-path");

    fast("last-update", "update");
    expect(statusLine()).toBe("Updating automation");
    engine({ type: "turn.completed", ok: false });
    expect(statusLine() ?? "").not.toContain("Updating automation");
    engine({ type: "turn.started", turnId: "t2" });
    expect(statusLine()).toBe("");
  });

  it.each([
    { app: "en", language: "zh", text: "请更新这条自动化的运行时间。", status: "正在更新自动化" },
    { app: "zh", language: "en", text: "Please update when this automation runs.", status: "Updating automation" },
    { app: "zh", language: "en", text: "Update the daily automation schedule tomorrow.", status: "Updating automation" },
    { app: "zh", language: "en", text: "Update automation.", status: "Updating automation" },
    { app: "zh", language: "en", text: "Rename this automation.", status: "Updating automation" },
    { app: "en", language: "ja", text: "この自動化を更新してください。", status: "自動化を更新中" },
    { app: "en", language: "ko", text: "이 자동화를 업데이트해 주세요.", status: "자동화 업데이트 중" },
    { app: "zh", language: "zh", text: "OK", status: "正在更新自动化" },
    { app: "en", language: "en", text: "好", status: "Updating automation" },
    { app: "fr", language: "fr", text: "Modifier cette automatisation.", status: "Mise à jour de l’automatisation" },
  ])("localizes the checked update from $language in the $app app", async ({ app, language, text, status }) => {
    await Promise.all([loadLocalePack(app), loadLocalePack(language)]);
    setLocale(app);
    mode.advanced = false;
    const person = { ...ask, text };
    const peer: Message = { ...ask, id: "peer", text: app === "zh" ? "另一个请求" : "Another request", peerAsk: { botId: "other", name: "Other" } };
    engine({ type: "turn.started", requestMessageId: person.id });
    render(busyBot([person, peer]));
    engine({ type: "item.started", itemType: "tool", itemId: "bare", title: "trigger", input: '{"action":"update","private":"raw-secret"}' });
    expect(statusLine()).not.toContain(status);
    engine({ type: "turn.progress", activity: "tool", itemId: "old", turnId: "old", automation: { action: "update", phase: "started" } });
    expect(statusLine()).not.toContain(status);
    engine({ type: "turn.progress", activity: "tool", itemId: "authorized", automation: { action: "update", phase: "started" },
      target: "private-target", detail: "private-tool-input" });
    expect(statusLine()).toBe(status);
    expect(host.querySelector("[data-turn-status]")?.getAttribute("lang")).toBe(language);
    expect(mascot()?.outerHTML).not.toMatch(/raw-secret|private-target|private-tool-input/);
    expect(activeLocale()).toBe(app);
    act(() => void vi.advanceTimersByTime(15_000));
    expect(statusLine()).toBe(status);
    engine({ type: "turn.progress", activity: "tool", itemId: "authorized", automation: { action: "update", phase: "finished" } });
    expect(statusLine()).not.toContain(status);
    engine({ type: "item.completed", itemType: "tool", itemId: "bare", ok: true });
    expect(statusLine()).toBe("");
  });
});
