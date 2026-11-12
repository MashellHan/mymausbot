// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MiniAppSuggestion, MiniAppSuggestionsResult } from "../../shared/mini-apps";
import type { Bot } from "@/state/store";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ api: vi.fn(), owner: true, visible: true }));
vi.mock("@/state/store", () => ({ api: fixture.api }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.owner }));
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => fixture.visible }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("./bot-settings/RoutinesSection", () => ({ RoutinesSection: () => null }));
vi.mock("./bot-panel/rows", () => ({ RowIcon: () => null, RowText: () => null, rowCls: "" }));

import { BotOverviewIntro } from "./BotOverviewIntro";

const bot = (id = "scout"): Bot => ({
  id, threadId: `${id}-task`, name: id, title: "", description: "Synthetic role", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "fixture", model: "model" },
});
const suggestion = (id: string, reason: MiniAppSuggestion["reason"] = { kind: "responsible" }): MiniAppSuggestion => ({
  app: { id, slug: id, title: id, description: "Synthetic application", status: "active", revision: 1,
    templateVersion: 1, publisherBotIds: [], createdAt: 1, updatedAt: 1 },
  reason,
});
const response = (selected: Bot, suggestions: MiniAppSuggestion[] = [], refreshPending = false): MiniAppSuggestionsResult => ({
  botId: selected.id, threadId: selected.threadId, suggestions, refreshPending,
});

let root: Root;
let host: HTMLDivElement;
const onOpenApps = vi.fn();
const render = async (selected = bot()) => {
  await act(async () => { root.render(createElement(BotOverviewIntro, {
    bot: selected, routines: [], runs: [], defaultRunOn: "maus", onOpenApps,
  })); });
};
const card = (name: string) => host.querySelector<HTMLButtonElement>(`button[title="${name}"]`);
const more = () => host.querySelector<HTMLButtonElement>('button[aria-label="All Mini Apps"]');

beforeEach(() => {
  setLocale("en");
  fixture.api.mockReset();
  fixture.owner = true;
  fixture.visible = true;
  onOpenApps.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ogb", { app: { blocksOpaqueFrameNavigation: true } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Bot overview suggestions", () => {
  it("shows at most three active suggestions with their reasons and opens the app or full list", async () => {
    const selected = bot();
    fixture.api.mockResolvedValue(response(selected, [
      suggestion("Budget"), suggestion("Report", { kind: "developed" }),
      suggestion("Expenses", { kind: "task", capability: "Summarize expenses", taskPhrase: "monthly budget" }),
      suggestion("Fourth"),
    ]));
    await render(selected);
    expect(fixture.api).toHaveBeenCalledWith("/api/mini-apps/suggestions", expect.objectContaining({
      method: "POST", body: JSON.stringify({ botId: selected.id, threadId: selected.threadId }),
    }));
    expect(card("Fourth")).toBeNull();
    expect(card("Budget")?.textContent).toContain("Responsible");
    expect(card("Report")?.textContent).toContain("Developed");
    expect(card("Expenses")?.textContent).toContain("Summarize expenses");
    await act(async () => { card("Budget")!.click(); more()!.click(); });
    expect(onOpenApps).toHaveBeenNthCalledWith(1, "Budget");
    expect(onOpenApps).toHaveBeenNthCalledWith(2);
  });

  it("cancels the old Bot request and never shows its late response in the newly selected Bot", async () => {
    const first = bot("first");
    const second = bot("second");
    let finishFirst!: (result: MiniAppSuggestionsResult) => void;
    fixture.api.mockImplementationOnce(() => new Promise<MiniAppSuggestionsResult>((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce(response(second, [suggestion("Current app")]));
    await render(first);
    const signal: AbortSignal = fixture.api.mock.calls[0]![1].signal;
    await render({ ...second, awaitingThreadSnapshot: true });
    expect(fixture.api).toHaveBeenCalledTimes(1);
    await render(second);
    expect(signal.aborted).toBe(true);
    await act(async () => finishFirst(response(first, [suggestion("Old app")])));
    expect(card("Old app")).toBeNull();
    expect(card("Current app")).not.toBeNull();
  });

  it("makes only one delayed follow-up while a semantic refresh is pending", async () => {
    vi.useFakeTimers();
    fixture.api.mockResolvedValueOnce(response(bot(), [], true))
      .mockResolvedValue(response(bot(), [suggestion("Relevant app")], true));
    await render();
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(card("Relevant app")).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fixture.api).toHaveBeenCalledTimes(2);
  });

  it.each(["empty", "error"])("keeps More available for an %s result without substituting catalog apps", async (state) => {
    if (state === "empty") fixture.api.mockResolvedValue(response(bot()));
    else fixture.api.mockRejectedValue(new Error("Fixture unavailable"));
    await render();
    expect(host.querySelectorAll("button[title]")).toHaveLength(0);
    expect(more()).not.toBeNull();
    expect(host.textContent).toContain(state === "empty" ? "No related Mini Apps." : "Mini Apps could not be loaded.");
    expect(fixture.api).toHaveBeenCalledTimes(1);
  });

  it("removes suggestions and cancels pending refresh when owner access ends", async () => {
    vi.useFakeTimers();
    fixture.api.mockResolvedValue(response(bot(), [suggestion("Private app")], true));
    await render();
    expect(card("Private app")).not.toBeNull();
    fixture.owner = false;
    await render();
    expect(card("Private app")).toBeNull();
    expect(more()).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fixture.api).toHaveBeenCalledTimes(1);
  });

  it("does not request suggestions or expose More outside the native guard", async () => {
    vi.stubGlobal("ogb", undefined);
    await render();
    expect(fixture.api).not.toHaveBeenCalled();
    expect(more()).toBeNull();
  });
});
