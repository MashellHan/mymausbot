// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MiniAppSuggestion, MiniAppSuggestionsResult } from "../../shared/mini-apps";
import type { Bot, InstanceInfo } from "@/state/store";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ api: vi.fn(), owner: true, visible: true, instances: [] as InstanceInfo[] }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: { instances: fixture.instances } }) }));
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
const response = (selected: Bot, suggestions: MiniAppSuggestion[] = [], status: MiniAppSuggestionsResult["status"] = "ready"): MiniAppSuggestionsResult => ({
  botId: selected.id, threadId: selected.threadId, suggestions, refreshPending: status === "pending", status,
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
  fixture.instances = [];
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

it("shows the configured reasoning or provider default on the collapsed Model row", async () => {
  const model = "raven::gpt-6.2-sol";
  fixture.instances = [{
    instanceId: "codex", displayName: "Codex", driverKind: "codex", access: "subscription",
    snapshot: { state: "available", version: "0.169.0" }, capabilities: { effortLevels: ["high", "xhigh"] },
    models: { default: model, options: [{ id: model, label: "GPT 6.2 Sol", custom: true,
      providerRoute: { id: "configured:fixture", label: "Raven", provenance: "configured" } }] },
  }];
  const selected: Bot = { ...bot(), modelSelection: { instanceId: "codex", model, effort: "xhigh" } };
  fixture.api.mockResolvedValue(response(selected));
  await render(selected);
  const modelRow = host.querySelector('[data-panel-card="model"] button')!;
  expect(modelRow.getAttribute("aria-expanded")).toBe("false");
  expect(modelRow.textContent).toContain("Reasoning · X-High");
  await render({ ...selected, modelSelection: { instanceId: "codex", model } });
  expect(modelRow.textContent).toContain("Reasoning · Provider default");
  await render({ ...selected, modelSelection: { instanceId: "codex", model, effort: "none" } });
  expect(modelRow.textContent).toContain("Reasoning · None (unavailable)");
});

describe("Bot overview suggestions", () => {
  it("uses the Mojo mark only for the existing Mojo app", async () => {
    const mojo = suggestion("01d8d54b-5b1c-4e8d-be21-e60aa6e42fc7");
    mojo.app.slug = "mojo";
    mojo.app.title = "Mojo";
    fixture.api.mockResolvedValue(response(bot(), [mojo, { ...suggestion("other"), app: { ...suggestion("other").app, slug: "mojo", title: "Other" } }]));
    await render();
    expect(card("Mojo")?.querySelector('[data-mini-app-icon="mojo"]')).not.toBeNull();
    expect(card("Other")?.querySelector('[data-mini-app-icon="custom"]')).not.toBeNull();
  });

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

  it("describes a publisher grant as permission rather than completed development", async () => {
    fixture.api.mockResolvedValue(response(bot(), [suggestion("Publisher app", { kind: "publisher-grant" })]));
    await render();
    expect(card("Publisher app")?.textContent).toContain("This Bot can publish this app");
    expect(card("Publisher app")?.textContent).not.toContain("Developed");
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
    fixture.api.mockResolvedValueOnce(response(bot(), [], "pending"))
      .mockResolvedValue(response(bot(), [suggestion("Relevant app")], "pending"));
    await render();
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(card("Relevant app")).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fixture.api).toHaveBeenCalledTimes(2);
  });

  it("honors legacy refreshPending and shows a completed legacy empty result", async () => {
    vi.useFakeTimers();
    const selected = bot();
    const legacy = { botId: selected.id, threadId: selected.threadId, suggestions: [] };
    fixture.api.mockResolvedValueOnce({ ...legacy, refreshPending: true })
      .mockResolvedValue({ ...legacy, refreshPending: false });
    await render(selected);
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(8_999); });
    expect(fixture.api).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(host.textContent).toContain("No related Mini Apps.");
    expect(host.querySelector('[role="status"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
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

  it("ends loading when the sole follow-up is still pending without usable suggestions", async () => {
    vi.useFakeTimers();
    fixture.api.mockResolvedValue(response(bot(), [], "pending"));
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Mini Apps could not be loaded.");
    expect(more()).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fixture.api).toHaveBeenCalledTimes(2);
  });

  it("removes suggestions and cancels pending refresh when owner access ends", async () => {
    vi.useFakeTimers();
    fixture.api.mockResolvedValue(response(bot(), [suggestion("Private app")], "pending"));
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

  it("shows Activities from its trusted task reason and opens its existing app", async () => {
    fixture.api.mockResolvedValue(response(bot(), [suggestion("Activities", { kind: "activities-task" })], "unavailable"));
    await render();
    expect(card("Activities")?.textContent).toContain("Contribution and token usage reports");
    await act(async () => { card("Activities")!.click(); });
    expect(onOpenApps).toHaveBeenCalledWith("Activities");
  });

  it("keeps unavailable distinct from empty and retries only once after backoff", async () => {
    vi.useFakeTimers();
    fixture.api.mockResolvedValue({ ...response(bot(), [], "unavailable"), retryAfterMs: 60_000 });
    await render();
    expect(host.textContent).toContain("Suggestions are temporarily unavailable.");
    expect(host.textContent).not.toContain("No related Mini Apps.");
    expect(more()).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
    expect(fixture.api).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fixture.api).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(fixture.api).toHaveBeenCalledTimes(2);
  });
});
