import { describe, expect, it, vi } from "vitest";
import type { MiniAppSummary } from "../../shared/mini-apps.ts";
import type { SideJobText } from "../side-jobs.ts";
import type { Store } from "../store.ts";
import type { MiniApps, MiniAppActor } from "./registry.ts";
import { MiniAppSuggestions } from "./suggestions.ts";

const owner: MiniAppActor = { writeAllowed: true, assertActive: () => undefined, canBind: () => true };
const app = (id: string, extra: Partial<MiniAppSummary> = {}): MiniAppSummary => ({
  id, slug: id, title: id, description: "Analyze inventory and prepare stock reports", status: "active",
  revision: 1, templateVersion: 1, publisherBotIds: [], responsibleBotId: null, capabilities: [],
  createdAt: 1, updatedAt: 1, ...extra,
});
const usage = (extra: Partial<MiniAppSummary> = {}) => app("usage", {
  title: "Activities", description: "", dashboardIdentity: "usage",
  dashboard: { kind: "usage", renderer: "native", htmlRole: "fallback-only",
    editableFields: ["title", "description"], resources: ["usage"] }, ...extra,
});

function fixture(writer: (botId: string) => SideJobText | null = () => null) {
  let apps = [app("a"), app("b"), app("c"), app("d")];
  let developed = new Set<string>();
  const bot = { id: "bot", threadId: "thread", title: "Inventory assistant", description: "Handles stock reports",
    soulHash: "role-v1", assignedSkills: ["stock review"], modelSelection: { instanceId: "fixture", model: "local" } };
  const task = { threadId: "thread", title: "Prepare the weekly stock report", updatedAt: 1 };
  const store = { bot: (id: string) => id === bot.id ? bot : undefined,
    taskByThread: (id: string, threadId: string) => id === bot.id && threadId === task.threadId ? task : undefined } as unknown as Pick<Store, "bot" | "taskByThread">;
  const registry = { list: () => apps, developedBy: () => developed } as unknown as MiniApps;
  const suggestions = new MiniAppSuggestions({ apps: registry, store, writer });
  const read = () => suggestions.read(owner, { botId: "bot", threadId: "thread" });
  return { read, bot, task, setApps: (next: MiniAppSummary[]) => { apps = next; }, setDeveloped: (next: string[]) => { developed = new Set(next); } };
}

describe("Mini App suggestions", () => {
  it("abstains on unsupported relevance and never pads the catalog", () => {
    const f = fixture();
    expect(f.read()).toMatchObject({ botId: "bot", threadId: "thread", suggestions: [], refreshPending: false, status: "unavailable" });
    f.setApps([app("a", { responsibleBotId: "bot" }), app("b"), app("c")]);
    f.setDeveloped(["a", "c"]);
    expect(f.read().suggestions.map(({ app, reason }) => [app.id, reason.kind])).toEqual([["a", "responsible"], ["c", "developed"]]);
    expect(f.read().suggestions.some(({ app }) => app.id === "b")).toBe(false);
    f.task.title = "";
    expect(f.read().suggestions).toHaveLength(2);
    expect(f.read().status).toBe("ready");
    expect(() => f.read()).not.toThrow();
  });

  it.each([
    "请汇总示例 PR、提交和模型 Token 用量，并区分不同用途",
    "按工作和个人分别统计 PR 数、commit 数和模型消耗的 token 数",
    "统计 PR数、commit数和模型消耗token数",
    "Track PRs, commits and model token usage each week",
  ])("suggests the granted Activities dashboard for explicit reporting without a writer", (title) => {
    const writer = vi.fn(() => null);
    const f = fixture(writer);
    f.task.title = title;
    f.setApps([usage()]);
    expect(f.read()).toMatchObject({ status: "ready", refreshPending: false,
      suggestions: [{ app: { id: "usage", publisherBotIds: [] }, reason: { kind: "activities-task" } }] });
    expect(writer).not.toHaveBeenCalled();
    f.setApps([usage({ dashboard: null })]);
    expect(f.read()).toMatchObject({ status: "ready", suggestions: [] });
  });

  it("abstains on ambiguous reporting and does not trust a copied name or slug", () => {
    const f = fixture();
    f.setApps([usage()]);
    for (const title of ["Review PRs and commits", "Count PRs, commits and access token usage",
      "Create a PR for commit hooks and token usage support",
      "Fix the model token usage report that links a PR to its commit",
      "Fix the job to track PRs, commits and model token usage",
      "Count PRs, commits and model token usage errors",
      "Do not count PRs, commits and model token usage",
      "Count PRs and commits, but do not report model tokens",
      "不要统计 PR 数、commit 数和模型消耗 token 数",
      "统计 PR 数、commit 数和访问 token 数"]) {
      f.task.title = title;
      expect(f.read().suggestions).toEqual([]);
    }
    f.task.title = "Count PRs, commits and model token usage";
    f.setApps([app("usage", { title: "Activities", description: "" }), usage({ id: "archived-usage", status: "archived" })]);
    expect(f.read().suggestions).toEqual([]);
  });

  it("reserves Usage task matching after grant revocation while retaining independent relationship cards", async () => {
    const description = "Summarize contributions and model token usage";
    const generateText = vi.fn(async (_prompt: string) => JSON.stringify({ matches: [
      { appId: "usage", capability: description, taskPhrase: "model token usage" },
      { appId: "other", capability: description, taskPhrase: "model token usage" },
    ] }));
    const f = fixture(() => ({ via: "engine", generateText }));
    f.task.title = "Count PRs, commits and model token usage";
    const granted = usage({ description, publisherBotIds: ["bot"] });
    const other = app("other", { description });
    f.setApps([granted, other]);
    expect(f.read().suggestions[0]?.reason.kind).toBe("activities-task");
    await new Promise(setImmediate);
    f.setApps([{ ...granted, dashboard: null }, other]);
    expect(f.read().status).toBe("pending");
    await new Promise(setImmediate);
    expect(f.read().suggestions.map(({ app, reason }) => [app.id, reason.kind])).toEqual([
      ["other", "task"], ["usage", "publisher-grant"],
    ]);
    expect(JSON.parse(generateText.mock.calls[1]![0]).apps).toEqual([{ id: "other", capabilities: [description] }]);
  });

  it("puts the Activities match in the task tier with current grant and development ordering", () => {
    const f = fixture();
    f.task.title = "Count PRs, commits and model token usage";
    f.setDeveloped(["developed"]);
    f.setApps([usage({ publisherBotIds: ["bot"] }), app("publisher", { publisherBotIds: ["bot"] }),
      app("developed"), app("responsible", { responsibleBotId: "bot" })]);
    expect(f.read().suggestions.map(({ app, reason }) => [app.id, reason.kind])).toEqual([
      ["responsible", "responsible"], ["developed", "developed"], ["usage", "activities-task"],
    ]);
  });

  it.each([["empty", '{"matches":[]}', "ready"], ["malformed", '{"wrong":[]}', "unavailable"]] as const)(
    "distinguishes a valid %s model answer from unavailable output",
    async (_name, text, status) => {
      const f = fixture(() => ({ via: "engine", generateText: async () => text }));
      expect(f.read().status).toBe("pending");
      await new Promise(setImmediate);
      expect(f.read()).toMatchObject({ status, suggestions: [] });
    },
  );

  it("uses current publisher permission without claiming publication or development", () => {
    const f = fixture();
    f.setApps([
      app("owner-only"), app("other-bot", { publisherBotIds: ["other"] }),
      app("later", { publisherBotIds: ["bot"], createdAt: 2 }),
      app("earlier", { publisherBotIds: ["bot"] }),
      app("archived", { publisherBotIds: ["bot"], status: "archived" }),
    ]);
    expect(f.read()).toMatchObject({ refreshPending: false, suggestions: [
      { app: { id: "earlier" }, reason: { kind: "publisher-grant" } },
      { app: { id: "later" }, reason: { kind: "publisher-grant" } },
    ] });
    f.setApps([app("later", { publisherBotIds: [] }), app("earlier", { publisherBotIds: ["bot"], responsibleBotId: "bot" })]);
    expect(f.read().suggestions.map(({ app, reason }) => [app.id, reason.kind])).toEqual([["earlier", "responsible"]]);
    f.setDeveloped(["later"]);
    expect(f.read().suggestions.map(({ app, reason }) => [app.id, reason.kind])).toEqual([
      ["earlier", "responsible"], ["later", "developed"],
    ]);
    f.setApps([app("owner-only"), ...["d", "b", "a", "c"].map((id) => app(id, { publisherBotIds: ["bot"] }))]);
    f.setDeveloped([]);
    expect(f.read().suggestions.map(({ app, reason }) => [app.id, reason.kind])).toEqual([
      ["a", "publisher-grant"], ["b", "publisher-grant"], ["c", "publisher-grant"],
    ]);
  });

  it("invalidates a warm ranking for a new app and a changed Bot role", async () => {
    const generateText = vi.fn(async (prompt: string) => {
      const input = JSON.parse(prompt) as { apps: Array<{ id: string; capabilities: string[] }> };
      return JSON.stringify({ matches: [{ appId: input.apps[0]!.id, capability: input.apps[0]!.capabilities[0],
        taskPhrase: "stock report" }] });
    });
    const f = fixture(() => ({ via: "engine", generateText }));
    f.setApps([app("older")]);
    expect(f.read().refreshPending).toBe(true);
    await new Promise(setImmediate);
    expect(f.read().suggestions.map(({ app }) => app.id)).toEqual(["older"]);
    f.setApps([app("older"), app("new", { createdAt: 2, updatedAt: 2 })]);
    expect(f.read().refreshPending).toBe(true);
    await new Promise(setImmediate);
    expect(f.read().suggestions.map(({ app }) => app.id)).toEqual(["new"]);
    f.bot.description = "Now handles weekly stock audits";
    expect(f.read().refreshPending).toBe(true);
    await new Promise(setImmediate);
    expect(generateText).toHaveBeenCalledTimes(3);
    f.setApps([app("older"), app("new", { createdAt: 2, updatedAt: 2, publisherBotIds: ["bot"] })]);
    expect(f.read().refreshPending).toBe(true);
    await new Promise(setImmediate);
    expect(generateText).toHaveBeenCalledTimes(4);
  });

  it("warms asynchronously, validates exact task and capability evidence, deduplicates and caps at three", async () => {
    let finish!: (value: string) => void;
    const generateText = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const f = fixture(() => ({ via: "engine", generateText }));
    f.setApps([app("a", { responsibleBotId: "bot" }), app("b"), app("c"), app("d"), app("e", { status: "archived" })]);
    f.setDeveloped(["a"]);
    const first = f.read();
    expect(first.refreshPending).toBe(true);
    expect(first.suggestions.map(({ app }) => app.id)).toEqual(["a"]);
    await new Promise(setImmediate);
    expect(generateText).toHaveBeenCalledTimes(1);
    finish(JSON.stringify({ matches: [
      { appId: "b", capability: "Analyze inventory and prepare stock reports", taskPhrase: "stock report" },
      { appId: "c", capability: "Analyze inventory and prepare stock reports", taskPhrase: "stock report" },
      { appId: "d", capability: "invented capability", taskPhrase: "stock report" },
    ] }));
    await new Promise(setImmediate);
    expect(f.read().refreshPending).toBe(false);
    expect(f.read().suggestions.map(({ app, reason }) => [app.id, reason.kind])).toEqual([
      ["a", "responsible"], ["b", "task"], ["c", "task"],
    ]);
    expect(generateText).toHaveBeenCalledTimes(1);
    f.setApps([app("a", { responsibleBotId: "bot" }), app("b", { status: "archived", revision: 2 }), app("c")]);
    expect(f.read().suggestions.map(({ app }) => app.id)).toEqual(["a"]);
  });

  it("aborts a stalled writer at the full deadline and ignores its late answer", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: string) => void;
      let signal: AbortSignal | undefined;
      const generateText = vi.fn((_prompt: string, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return new Promise<string>((resolve) => { finish = resolve; });
      });
      const f = fixture(() => ({ via: "engine", generateText }));
      f.setApps([app("a", { responsibleBotId: "bot" }), app("b")]);
      expect(f.read().refreshPending).toBe(true);
      await Promise.resolve();
      expect(generateText).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(signal?.aborted).toBe(true);
      expect(f.read()).toMatchObject({ status: "unavailable", refreshPending: false,
        suggestions: [{ app: { id: "a" }, reason: { kind: "responsible" } }] });
      finish(JSON.stringify({ matches: [{ appId: "b", capability: "Analyze inventory and prepare stock reports", taskPhrase: "stock report" }] }));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.read().suggestions.map(({ app }) => app.id)).toEqual(["a"]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.read().refreshPending).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses stale Bot tasks and rejects model IDs or reasons absent from current metadata", async () => {
    const f = fixture(() => ({ via: "engine", generateText: async () => JSON.stringify({ matches: [
      { appId: "missing", capability: "Analyze inventory and prepare stock reports", taskPhrase: "stock report" },
      { appId: "a", capability: "Analyze inventory and prepare stock reports", taskPhrase: "not in task" },
      { appId: "b", capability: "Analyze inventory and prepare stock reports", taskPhrase: "stock report" },
    ] }) }));
    f.setApps([app("a"), app("b", { status: "archived" })]);
    expect(f.read().suggestions).toEqual([]);
    await new Promise(setImmediate);
    expect(f.read().suggestions).toEqual([]);
    expect(() => new MiniAppSuggestions({ apps: { list: () => [], developedBy: () => new Set() } as unknown as MiniApps,
      store: { bot: () => ({ id: "bot", threadId: "other" }), taskByThread: () => ({ threadId: "thread" }) } as unknown as Store,
      writer: () => null }).read(owner, { botId: "bot", threadId: "thread" })).toThrow("unavailable");
    expect(() => f.read()).not.toThrow();
    expect(() => new MiniAppSuggestions({ apps: { list: () => [], developedBy: () => new Set() } as unknown as MiniApps,
      store: { bot: () => undefined, taskByThread: () => undefined } as unknown as Store,
      writer: () => null }).read(owner, { botId: "unknown", threadId: "thread" })).toThrow("unavailable");
  });
});
