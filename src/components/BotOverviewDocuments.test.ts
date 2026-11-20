// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { ApiError, type Bot } from "@/state/store";
import { BotOverviewDocuments } from "./BotOverviewDocuments";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  fetch: vi.fn(),
  flush: vi.fn(),
  team: false,
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: { team: fixture.team } }, flushBotPatches: fixture.flush }),
  ApiError: class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly body?: Record<string, unknown>) { super(message); }
  },
}));

function bot(id = "atlas", patch: Partial<Bot> = {}): Bot {
  return {
    id, threadId: `${id}-thread`, name: id, title: "", description: "", color: "green", notifications: true,
    unread: false, messages: [], modelSelection: { instanceId: "fixture", model: "model" }, ...patch,
  };
}

const file = (text: string, hash = "hash-initial") => ({ text, hash });
const memory = (text: string, hash = "empty-hash") => ({ path: "MEMORY.md", text, hash, exists: text !== "" });
const response = (data: object, status = 200) => new Response(JSON.stringify(data), { status });
let host: HTMLDivElement;
let root: Root;

const render = (selected = bot()) => act(async () => root.render(createElement(BotOverviewDocuments, {
  key: selected.id, bot: selected, intro: createElement("section", { "data-suggested": "" }, "Suggested"),
  children: createElement("section", { "data-computer": "" }, "Computer"),
})));
const entry = (kind: string) => host.querySelector<HTMLButtonElement>(`[data-panel-page="${kind}"]`)!;
const page = () => host.querySelector<HTMLElement>("[data-bot-document]");
const editor = () => page()?.querySelector<HTMLTextAreaElement>("textarea");
const button = (label: string) => [...page()!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!;
const click = (item: HTMLElement) => act(async () => item.click());
const type = (text: string) => act(async () => {
  const field = editor()!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fixture.fetch);
  fixture.team = false;
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Bot overview documents", () => {
  it("places the file entries between Suggested and Computer and saves Soul only on Save", async () => {
    const saved = file("# Instructions", "hash-saved");
    fixture.api.mockResolvedValueOnce(file("")).mockResolvedValueOnce(saved).mockResolvedValueOnce(saved);
    await render();
    expect([...host.firstElementChild!.children].map((node) => node.textContent)).toEqual(["Suggested", "SoulMemoryAgent MD", "Computer"]);
    await click(entry("soul"));
    expect(document.activeElement).toBe(button("Back"));
    expect(fixture.api).toHaveBeenNthCalledWith(1, "/api/bots/atlas/documents/soul", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(editor()?.getAttribute("aria-label")).toBe("SOUL.md");
    expect(editor()?.value).toBe("");
    expect(button("Save").disabled).toBe(true);
    await type(saved.text);
    expect(fixture.api).toHaveBeenCalledTimes(1);
    await click(button("Save"));
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/bots/atlas/documents/soul", {
      method: "PUT", body: JSON.stringify({ text: saved.text, expectedHash: "hash-initial" }),
    });
    expect(page()).toBeNull();
    expect(document.activeElement).toBe(entry("soul"));
    await click(entry("soul"));
    expect(editor()?.value).toBe(saved.text);
  });

  it("keeps a Soul draft through a save error and stale basis, then saves on the reloaded basis", async () => {
    const saved = file("Merged", "hash-saved");
    const reason = "The document changed since you opened it.";
    fixture.api.mockResolvedValueOnce(file("Before"))
      .mockRejectedValueOnce(new Error("Cannot save this bot"))
      .mockRejectedValueOnce(new ApiError(reason, 409, {
        code: "conflict", current: "Other edit", currentHash: "hash-new", error: reason,
      }))
      .mockResolvedValueOnce(saved);
    await render();
    await click(entry("soul"));
    await type("Draft");
    await click(button("Save"));
    expect(page()?.querySelector('[role="alert"]')?.textContent).toBe("Cannot save this bot");
    expect(editor()?.value).toBe("Draft");
    await click(button("Save"));
    expect(editor()?.value).toBe("Draft");
    expect(button("Save").disabled).toBe(true);
    expect(page()?.querySelector('[role="alert"]')?.textContent).toBe(reason);
    expect(button("Overwrite with mine")).toBeDefined();
    expect(fixture.api).toHaveBeenCalledTimes(3);
    await click(button("Reload"));
    expect(editor()?.value).toBe("Other edit");
    expect(document.activeElement).toBe(editor());
    expect(page()?.querySelector("[data-memory-draft]")?.textContent).toContain("Draft");
    await type(saved.text);
    await click(button("Save"));
    expect(fixture.api).toHaveBeenNthCalledWith(4, "/api/bots/atlas/documents/soul", {
      method: "PUT", body: JSON.stringify({ text: saved.text, expectedHash: "hash-new" }),
    });
    expect(fixture.api.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(false);
    expect(page()).toBeNull();
  });

  it("shows the competing Agent MD mirror bytes and uses their basis for an explicit overwrite", async () => {
    const saved = file("# Standing instructions", "agent-saved");
    const mirror = "# External edit\n\n  This came from disk.\n";
    const reason = "The document changed since you opened it.";
    fixture.api.mockResolvedValueOnce(file("# Approved instructions", "agent-initial"))
      .mockRejectedValueOnce(new ApiError(reason, 409, {
        code: "conflict", current: mirror, currentHash: "agent-new", error: reason,
      }))
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce(saved);
    await render();
    await click(entry("agents"));
    expect(editor()?.getAttribute("aria-label")).toBe("AGENTS.md");
    expect(editor()?.value).toBe("# Approved instructions");
    expect(fixture.api).toHaveBeenNthCalledWith(1, "/api/bots/atlas/documents/agents", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await type(saved.text);
    await click(button("Save"));
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/bots/atlas/documents/agents", {
      method: "PUT", body: JSON.stringify({ text: saved.text, expectedHash: "agent-initial" }),
    });
    expect(editor()?.value).toBe(saved.text);
    expect(page()?.querySelector('[role="alert"]')?.textContent).toBe(reason);
    expect(page()?.querySelector('pre[aria-label="Current file"]')?.textContent).toBe(mirror);
    expect(button("Save").disabled).toBe(true);
    await click(button("Overwrite with mine"));
    expect(fixture.api).toHaveBeenNthCalledWith(3, "/api/bots/atlas/documents/agents", {
      method: "PUT", body: JSON.stringify({ text: saved.text, expectedHash: "agent-new" }),
    });
    expect(document.activeElement).toBe(entry("agents"));
    await click(entry("agents"));
    expect(editor()?.value).toBe(saved.text);
  });

  it("retains a Soul draft when the server directs the user to resolve external edits in settings", async () => {
    const message = "SOUL.md has external edits. Resolve them in Bot settings before saving.";
    fixture.api.mockResolvedValueOnce(file("Before"))
      .mockRejectedValueOnce(new ApiError(message, 409, {
        code: "conflict", current: "Before", currentHash: "hash-drifted", mirrorDrift: true, error: message,
      }));
    await render();
    await click(entry("soul"));
    await type("Keep this draft");
    await click(button("Save"));
    expect(page()?.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(editor()?.value).toBe("Keep this draft");
    expect(button("Save").disabled).toBe(true);
    expect(button("Overwrite with mine")).toBeUndefined();
    expect(button("Reload")).toBeUndefined();
  });

  it("reuses personal Memory permissions and hash conflicts for a missing file", async () => {
    fixture.team = true;
    fixture.api.mockResolvedValue(memory(""));
    fixture.fetch
      .mockResolvedValueOnce(response({ current: "Bot note", currentHash: "bot-hash" }, 409))
      .mockResolvedValueOnce(response({ error: "Write denied" }, 403))
      .mockResolvedValueOnce(response(memory("My edited note", "saved-hash")));
    await render();
    await click(entry("memory"));
    expect(editor()?.getAttribute("aria-label")).toBe("MEMORY.md");
    expect(editor()?.value).toBe("");
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/atlas/memory/mine/file?path=MEMORY.md");
    await type("My draft");
    await click(button("Save"));
    expect(fixture.fetch).toHaveBeenNthCalledWith(1, "/api/bots/atlas/memory/mine/file", expect.objectContaining({
      method: "PUT", body: JSON.stringify({ path: "MEMORY.md", text: "My draft", expectedHash: "empty-hash" }),
    }));
    await click(button("Reload"));
    expect(editor()?.value).toBe("Bot note");
    expect(page()?.querySelector("[data-memory-draft]")?.textContent).toContain("My draft");
    await type("My edited note");
    await click(button("Save"));
    expect(page()?.querySelector('[role="alert"]')?.textContent).toBe("Write denied");
    expect(editor()?.value).toBe("My edited note");
    await click(button("Save"));
    expect(fixture.fetch).toHaveBeenNthCalledWith(3, "/api/bots/atlas/memory/mine/file", expect.objectContaining({
      body: JSON.stringify({ path: "MEMORY.md", text: "My edited note", expectedHash: "bot-hash" }),
    }));
    expect(page()).toBeNull();
    expect(document.activeElement).toBe(entry("memory"));
  });

  it("opens a new bot's document independently during an older read", async () => {
    let finish!: (value: ReturnType<typeof file>) => void;
    fixture.api.mockImplementationOnce(() => new Promise<ReturnType<typeof file>>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(file("New bot"));
    await render();
    await click(entry("soul"));
    expect(page()?.querySelector('[role="status"]')?.textContent).toContain("Loading");
    await render(bot("scout"));
    expect(page()).toBeNull();
    await click(entry("soul"));
    expect(editor()?.value).toBe("New bot");
    await act(async () => finish(file("Old bot")));
    expect(editor()?.value).toBe("New bot");
    expect(fixture.api.mock.calls[0]![1].signal.aborted).toBe(true);
  });

  it("keeps the active editor open when a Save for a previous bot finishes", async () => {
    const saved = file("Atlas changes", "atlas-saved");
    let finish!: (value: ReturnType<typeof file>) => void;
    fixture.api.mockResolvedValueOnce(file(""))
      .mockImplementationOnce(() => new Promise<ReturnType<typeof file>>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(file("Scout's file"));
    await render();
    await click(entry("soul"));
    await type(saved.text);
    await click(button("Save"));
    expect(button("Saving…").disabled).toBe(true);
    await render(bot("scout"));
    await click(entry("soul"));
    await act(async () => finish(saved));
    expect(editor()?.value).toBe("Scout's file");
    expect(fixture.api.mock.calls.map(([path]) => path)).toEqual([
      "/api/bots/atlas/documents/soul", "/api/bots/atlas/documents/soul", "/api/bots/scout/documents/soul",
    ]);
  });

  it("shows a retryable load error and respects the existing disabled Memory state", async () => {
    fixture.api.mockRejectedValueOnce(new Error("Cannot read this bot")).mockResolvedValueOnce(file(""));
    await render(bot("atlas", { memoryEnabled: false }));
    await click(entry("memory"));
    expect(editor()).toBeNull();
    expect(fixture.api).not.toHaveBeenCalled();
    await click(button("Back"));
    await click(entry("soul"));
    expect(page()?.querySelector('[role="alert"]')?.textContent).toBe("Cannot read this bot");
    expect(editor()).toBeNull();
    await click(button("Try again"));
    expect(editor()?.value).toBe("");
  });
});
