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
    expect(f.read()).toEqual({ botId: "bot", threadId: "thread", suggestions: [], refreshPending: false });
    f.setApps([app("a", { responsibleBotId: "bot" }), app("b"), app("c")]);
    f.setDeveloped(["a", "c"]);
    expect(f.read().suggestions.map(({ app, reason }) => [app.id, reason.kind])).toEqual([["a", "responsible"], ["c", "developed"]]);
    expect(f.read().suggestions.some(({ app }) => app.id === "b")).toBe(false);
    f.task.title = "";
    expect(f.read().suggestions).toHaveLength(2);
    expect(() => f.read()).not.toThrow();
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
      expect(f.read()).toMatchObject({ refreshPending: false, suggestions: [{ app: { id: "a" }, reason: { kind: "responsible" } }] });
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
