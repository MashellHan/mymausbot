// @vitest-environment happy-dom
import { StrictMode, createElement, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotEditorStore, initialState, type Bot, type Message } from "@/state/store";
import { parseTableFile, type TextTable } from "@/lib/table-data";
import { rememberComputerPanelOpen } from "@/lib/computer-panel-focus";
import { useFilePreviewScope } from "@/lib/file-preview";
import { setLocale } from "@/lib/i18n";
import { MEMORY_INDEX } from "@/lib/memory";
import { AttachedFileChip } from "./AttachmentPreview";
import { ChatMarkdown } from "./ChatMarkdown";
import { ComputerPanel } from "./ComputerPanel";
import { MARKDOWN_PREVIEW_MAX_BYTES, MessageFilePreview } from "./MessageFilePreview";

vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: async (path: string) => path.includes("/memory/file?")
    ? { path: MEMORY_INDEX, text: "", hash: "", exists: false }
    : { held: false, helpReason: null },
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, setAdvancedMode: () => {} }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./AndroidDevicePanel", () => ({ AndroidDevicePanel: () => null, useAndroidUsbDevices: () => ({ devices: [] }) }));
vi.mock("./mini-apps/MiniAppsPanel", () => ({ MiniAppsPanel: () => createElement("div", null, "Mini Apps fixture") }));

const markdown = "# Weekly review\n\nA **complete** report.\n\n| Project | Changes |\n| --- | --- |\n| Alpha | 12 |\n\n```text\nhello\n```\n\n<script>globalThis.leaked = true</script>\n\n[secret](file:///private/secret.md)\n\n[unsafe](javascript:alert(1))\n\n![remote](https://example.test/track.png)";
const csv = 'Code,Name,Notes\n001,"Alpha, Inc","Line one\nLine two"\n9007199254740993,Beta,Ready\n';
const message = { threadId: "thread / 1", messageId: "reply / 1" };
const reply = { id: message.messageId, role: "bot", kind: "text", at: 1,
  text: "[Report](file:///workspace/report%20%231.md)\n\n[Data](/workspace/data.csv)",
} as Message;
const makeBot = (patch: Partial<Bot> = {}) => ({
  id: "scout", threadId: message.threadId, name: "Scout", cwd: "/workspace", computer: "off",
  modelSelection: { instanceId: "claude", model: "m" },
  messages: [reply, { id: "digest", role: "bot", kind: "digest", at: 2,
    digest: { files: { added: ["report #1.md", "data.csv", "unshared.md"], changed: [], deleted: [] } } }],
  ...patch,
}) as Bot;

class ParserWorker {
  onmessage: ((event: { data: { table: TextTable } | { error: string } }) => void) | null = null;
  onerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage({ text, delimiter }: { text: string; delimiter: "," | "\t" }) {
    queueMicrotask(() => {
      if (this.terminate.mock.calls.length) return;
      try { this.onmessage?.({ data: { table: parseTableFile(text, delimiter) } }); }
      catch (error) { this.onmessage?.({ data: { error: (error as Error).message } }); }
    });
  }
}

function ChatFixture({ bot, initiallyOpen = false, panelReady = true }: { bot: Bot; initiallyOpen?: boolean; panelReady?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  useFilePreviewScope(bot.id, bot.threadId, open);
  const value: Parameters<typeof BotEditorStore>[0]["value"] = {
    state: { ...initialState, bots: [bot], selectedId: bot.id, computerOpen: open },
    dispatch: (action) => { if (action.type === "toggleComputer") setOpen(action.open ?? !open); },
    flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {},
  };
  return createElement(BotEditorStore, { value, children: [
    createElement("section", { key: "chat", "data-preview-chat": true },
      createElement(ChatMarkdown, { text: reply.text!, message: { ...message, threadId: bot.threadId } }),
      createElement(AttachedFileChip, { file: { path: "/workspace/attached.md", name: "attached.md", private: true }, message: { ...message, threadId: bot.threadId } }),
      createElement("button", { onClick: (event) => {
        if (open) { setOpen(false); return; }
        rememberComputerPanelOpen({ botId: bot.id, opener: event.currentTarget, tabs: false }); setOpen(true);
      } }, open ? "Close panel" : "Open panel")),
    open && panelReady && createElement(ComputerPanel, { key: bot.id, bot }),
  ] });
}

let root: Root;
let host: HTMLDivElement;
const renderChat = (bot = makeBot(), initiallyOpen = false, strict = false, panelReady = true) => {
  const chat = createElement(ChatFixture, { bot, initiallyOpen, panelReady });
  flushSync(() => root.render(strict ? createElement(StrictMode, null, chat) : chat));
};
const button = (label: string, scope: ParentNode = host) => [...scope.querySelectorAll<HTMLButtonElement>("button")]
  .find((node) => node.getAttribute("aria-label") === label || node.textContent === label || node.title === label)!;
const click = (node: HTMLElement) => flushSync(() => node.click());
const preview = () => host.querySelector<HTMLElement>('section[aria-label^="Preview file:"]');
const openReport = () => click(button("Report", host.querySelector("[data-preview-chat]")!));

beforeEach(() => {
  setLocale("en");
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); },
    removeItem: (key: string) => { saved.delete(key); },
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.stubGlobal("Worker", ParserWorker);
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) =>
    new Response(JSON.parse(String(init?.body)).path.endsWith(".csv") ? csv : markdown)));
});
afterEach(() => {
  flushSync(() => root.unmount()); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("generated files in the right panel", () => {
  it("opens a Markdown link in Files under StrictMode, preserving its exact message grant", async () => {
    renderChat(makeBot(), false, true);
    expect(fetch).not.toHaveBeenCalled();
    openReport();
    await vi.waitFor(() => expect(preview()?.textContent).toContain("Weekly review"));
    expect(host.querySelector('[data-computer-panel] [role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe("Files");
    expect(document.querySelector("dialog")).toBeNull();
    expect(fetch).toHaveBeenCalledWith("/api/threads/thread%20%2F%201/messages/reply%20%2F%201/file", expect.objectContaining({
      method: "POST", body: JSON.stringify({ path: "file:///workspace/report%20%231.md" }),
    }));
    expect(preview()?.querySelector("article strong")?.textContent).toBe("complete");
    expect(preview()?.querySelector("article table")).not.toBeNull();
    expect(preview()?.querySelector("article pre")?.textContent).toContain("hello");
    expect(preview()?.querySelector('script, a[href^="file:"], a[href^="javascript:"], img[src^="https:"]')).toBeNull();
    expect(button("secret", preview()!)).toBeUndefined();
    expect(document.activeElement).toBe(button("Back to files"));
  });

  it("opens attachments and recent shared files, restores the list, and never grants an unshared digest", async () => {
    localStorage.setItem("omb-computer-panel-view:scout", "files");
    renderChat(makeBot(), true);
    const list = host.querySelector<HTMLElement>('[data-testid="computer-files"]')!;
    list.scrollTop = 90;
    expect(fetch).not.toHaveBeenCalled();
    expect(list.textContent).toContain("Not shared");
    expect(button("Preview: unshared.md")).toBeUndefined();
    const trigger = button("Preview: report #1.md", list);
    click(trigger);
    await vi.waitFor(() => expect(preview()?.textContent).toContain("Weekly review"));
    expect(list.hidden).toBe(true);
    click(button("Back to files"));
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(list.hidden).toBe(false); expect(list.scrollTop).toBe(90);
    click(button("Preview: attached.md"));
    await vi.waitFor(() => expect(preview()?.querySelector("h2")?.textContent).toBe("attached.md"));
  });

  it("keeps Back and Escape focus in Files when the original link is in chat", async () => {
    renderChat(); openReport();
    await vi.waitFor(() => expect(preview()?.textContent).toContain("Weekly review"));
    click(button("Back to files"));
    const list = host.querySelector('[data-testid="computer-files"]');
    await vi.waitFor(() => expect(document.activeElement).toBe(list));
    openReport();
    await vi.waitFor(() => expect(preview()?.textContent).toContain("Weekly review"));
    flushSync(() => button("Back to files").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await vi.waitFor(() => expect(document.activeElement).toBe(list));
  });

  it("discards a cancelled request before the lazy panel mounts, retaining the saved Files choice on reopen", async () => {
    renderChat(makeBot(), false, true, false); openReport();
    expect(fetch).not.toHaveBeenCalled();
    click(button("Close panel"));
    click(button("Open panel"));
    renderChat(makeBot(), false, true, true);
    await vi.waitFor(() => expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe("Files"));
    expect(preview()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["bot", "thread"])("discards a pending request when leaving the %s before the lazy panel mounts", async (scope) => {
    renderChat(makeBot(), false, false, false); openReport();
    renderChat(makeBot(scope === "bot" ? { id: "other" } : { threadId: "other-thread" }), false, false, false);
    renderChat();
    await vi.waitFor(() => expect(host.querySelector("[data-computer-panel]")).not.toBeNull());
    expect(preview()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains an uncancelled request until the lazy panel mounts under StrictMode", async () => {
    renderChat(makeBot(), false, true, false); openReport();
    expect(fetch).not.toHaveBeenCalled();
    renderChat(makeBot(), false, true, true);
    await vi.waitFor(() => expect(preview()?.textContent).toContain("Weekly review"));
  });

  it("parses CSV with quoting, multiline cells and string IDs, and keeps downloading separate", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderChat();
    click(button("Data", host.querySelector("[data-preview-chat]")!));
    await vi.waitFor(() => expect(preview()?.querySelector("table")?.textContent).toContain("9007199254740993"));
    expect(preview()?.textContent).toContain("001");
    expect(preview()?.textContent).toContain("Alpha, Inc");
    expect(preview()?.textContent).toContain("Line one\nLine two");
    expect(download).not.toHaveBeenCalled();
    click(button("Save a copy of data.csv", preview()!));
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining("/messages/reply%20%2F%201/file"), expect.objectContaining({
      body: JSON.stringify({ path: "/workspace/data.csv", listFolder: true }),
    }));
  });

  it("aborts an old read when another file opens and ignores its late response", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    renderChat(); openReport();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
    click(button("Data", host.querySelector("[data-preview-chat]")!));
    await vi.waitFor(() => expect(preview()?.textContent).toContain("Alpha, Inc"));
    expect(signal.aborted).toBe(true);
    finish(new Response("# Stale secret"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(preview()?.textContent).not.toContain("Stale secret");
  });

  it("clears preview on tab changes and panel close, retaining the saved Files choice", async () => {
    renderChat(); openReport();
    await vi.waitFor(() => expect(preview()?.textContent).toContain("Weekly review"));
    click(button("Mini Apps"));
    click(button("Files"));
    expect(preview()).toBeNull();
    openReport();
    await vi.waitFor(() => expect(preview()?.textContent).toContain("Weekly review"));
    click(host.querySelector<HTMLButtonElement>("[data-computer-panel-close]")!);
    expect(host.querySelector("[data-computer-panel]")).toBeNull();
    expect(document.activeElement?.textContent).toBe("Report");
    click(button("Open panel"));
    await vi.waitFor(() => expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe("Files"));
    expect(preview()).toBeNull();
  });

  it.each(["thread", "bot", "branch"])("removes content immediately when the %s changes", async (scope) => {
    renderChat(); openReport();
    await vi.waitFor(() => expect(preview()?.textContent).toContain("Weekly review"));
    const patch = scope === "thread" ? { threadId: "another-thread" }
      : scope === "bot" ? { id: "other" } : { messages: [{ ...reply, id: "other-reply", text: "Another branch" }] };
    renderChat(makeBot(patch));
    expect(preview()).toBeNull();
    renderChat();
    expect(preview()).toBeNull();
  });
});

describe("bounded Markdown content", () => {
  const render = () => flushSync(() => root.render(createElement(MessageFilePreview, {
    file: { name: "report.md", path: "/workspace/report.md", message },
  })));
  it.each([
    ["empty", () => new Response("\n "), "This document is empty."],
    ["oversize", () => new Response(new Uint8Array(MARKDOWN_PREVIEW_MAX_BYTES + 1)), "too large to preview"],
    ["invalid UTF-8", () => new Response(new Uint8Array([0xff, 0xfe])), "could not be read as Markdown"],
    ["binary", () => new Response("a\0b"), "could not be read as Markdown"],
    ["outside workspace", () => new Response(JSON.stringify({ code: "outside_workspace" }), { status: 403 }), "outside this chat's working folder"],
  ])("handles %s without losing download or offering an ineffective retry", async (_label, response, text) => {
    vi.mocked(fetch).mockImplementation(async () => response());
    render();
    await vi.waitFor(() => expect(preview()?.textContent).toContain(text));
    expect(button("Save a copy of report.md")).toBeDefined();
    expect(button("Retry")).toBeUndefined();
  });

  it("offers retry for a failed read and renders the successful response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 404 }));
    render();
    await vi.waitFor(() => expect(preview()?.querySelector('[role="alert"]')?.textContent).toContain("Could not load"));
    click(button("Retry"));
    await vi.waitFor(() => expect(preview()?.textContent).toContain("Weekly review"));
    expect(preview()?.querySelector('[role="alert"]')).toBeNull();
  });
});
