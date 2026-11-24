// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMAGE_MAX_BYTES } from "@/lib/composer-attachments";
import { restoreComposerDraft } from "@/lib/drafts";
import { t } from "@/lib/i18n";
import { makePwaOwnerKey } from "@/lib/pwa-config";
import { resetPwaCacheForTests } from "@/lib/pwa-cache";
import { setActivePwaAuth } from "@/lib/pwa-transport";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  connected: false,
  cachedHydrated: true,
  instances: [{ instanceId: "inst-1", driverKind: "claudeAgent", displayName: "Claude", capabilities: { images: true } }] as Array<{
    instanceId: string;
    driverKind: string;
    displayName: string;
    capabilities?: { images?: boolean };
  }>,
}));

const bot: Bot = {
  id: "accounting",
  threadId: "t-accounting",
  name: "Accounting",
  title: "",
  description: "",
  color: "blue",
  notifications: false,
  unread: false,
  busy: false,
  awaitingThreadSnapshot: true,
  modelSelection: { instanceId: "inst-1", model: "gpt-6" },
  messages: [],
};

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: {
        ...original.initialState,
        connected: fixture.connected,
        hydrated: true,
        cachedHydrated: fixture.cachedHydrated,
        bots: [bot],
        selectedId: bot.id,
        instances: fixture.instances,
      },
      dispatch: fixture.dispatch,
    }),
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./CallView", () => ({ CallButton: () => null }));

import { Composer } from "./Composer";
import { PwaPinBotButton } from "./PwaPinBotButton";
import { ComputerTab } from "./bot-panel/ComputerTab";

const draftId = `bot:${bot.id}:${bot.threadId}`;

describe("Stage 5-7 Composer offline drafting, receipt images, and PwaPinBotButton", () => {
  let root: Root;
  let container: HTMLDivElement;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fixture.connected = false;
    fixture.cachedHydrated = true;
    fixture.instances = [{ instanceId: "inst-1", driverKind: "claudeAgent", displayName: "Claude", capabilities: { images: true } }];
    fixture.dispatch.mockClear();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
    const ownerKey = makePwaOwnerKey("https://relay.mxhan.com", "env-1", "ses-pwa");
    setActivePwaAuth({
      relayUrl: "https://relay.mxhan.com",
      sessionId: "ses-pwa",
      deviceId: "dev-1",
      token: "tok",
      environmentId: "env-1",
      ownerKey,
      serverName: "Mac mini",
      scopes: ["admin"],
      pairedAt: 100,
    });
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    setActivePwaAuth(null);
    resetPwaCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("queues plain-text sends while offline/cached on Enter and Send button click", () => {
    flushSync(() => root.render(createElement(Composer, { bot })));
    const textarea = container.querySelector("textarea")!;
    expect(textarea).not.toBeNull();
    expect(textarea.disabled).toBe(false);

    const draft = "Reconcile Q4 invoices";
    flushSync(() => restoreComposerDraft(draftId, { text: draft, attachments: [] }));
    expect(textarea.value).toBe(draft);

    // 1. Submit via Enter key
    fetchSpy.mockClear();
    flushSync(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(textarea.value).toBe("");
    expect(fixture.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "send", botId: "accounting", text: draft }),
    );
    expect(
      fetchSpy.mock.calls.filter(([url, init]) => String(url).includes("/messages") || init?.method === "POST"),
    ).toEqual([]);

    // 2. Submit via Send button click
    fixture.dispatch.mockClear();
    const secondDraft = "Check ledger totals";
    flushSync(() => restoreComposerDraft(draftId, { text: secondDraft, attachments: [] }));
    const sendButton = container.querySelector(`button[aria-label="${t("composer.send.message")}"]`) as HTMLButtonElement | null;
    expect(sendButton).not.toBeNull();
    flushSync(() => sendButton!.click());
    expect(textarea.value).toBe("");
    expect(fixture.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "send", botId: "accounting", text: secondDraft }),
    );
  });

  it("queues compressed receipt images into outbox while offline/cached without POSTing", async () => {
    fixture.instances = [];
    const blobUrls = new Map<string, Blob | MediaSource>();
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
      const url = `blob:https://mausbot.mxhan.com/mock-${blobUrls.size + 1}`;
      blobUrls.set(url, blob);
      return url;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    flushSync(() => root.render(createElement(Composer, { bot })));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).not.toBeNull();
    const receiptFile = new File([new Uint8Array([137, 80, 78, 71])], "receipt.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [receiptFile], configurable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 25));

    const previewImg = container.querySelector('img[src^="blob:"]') as HTMLImageElement | null;
    expect(previewImg).not.toBeNull();

    const textarea = container.querySelector("textarea")!;
    const draft = "Review attached receipt";
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, draft);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const sendButton = container.querySelector(`button[aria-label="${t("composer.send.message")}"]`) as HTMLButtonElement | null;
    expect(sendButton).not.toBeNull();
    flushSync(() => sendButton!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "send",
        botId: "accounting",
        text: draft,
        outboxAttachments: [
          expect.objectContaining({
            uploadId: expect.any(String),
            name: "receipt.png",
            mime: "image/png",
            compressedBlob: expect.any(Blob),
          }),
        ],
      }),
    );
    expect(
      fetchSpy.mock.calls.filter(([url, init]) => String(url).includes("/api/attachments") || String(url).includes("/messages") || init?.method === "POST"),
    ).toEqual([]);
  });

  it("still blocks non-image file attachments while offline/cached", () => {
    flushSync(() => root.render(createElement(Composer, { bot })));
    const textarea = container.querySelector("textarea")!;
    const draft = "Review attached pdf";
    flushSync(() =>
      restoreComposerDraft(draftId, {
        text: draft,
        attachments: [{ kind: "file", id: "file-1", name: "statement.pdf", size: 120, path: "/tmp/statement.pdf" }],
      }),
    );

    const sendButton = container.querySelector(`button[aria-label="${t("composer.send.message")}"]`) as HTMLButtonElement | null;
    expect(sendButton).not.toBeNull();
    flushSync(() => sendButton!.click());
    expect(textarea.value).toBe(draft);
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(
      fetchSpy.mock.calls.filter(([url, init]) => String(url).includes("/messages") || init?.method === "POST"),
    ).toEqual([]);
  });

  it("still disables Composer when setupLocked is true", () => {
    flushSync(() => root.render(createElement(Composer, { bot, locked: true })));
    const textarea = container.querySelector("textarea")!;
    expect(textarea.disabled).toBe(true);
  });

  it("renders PwaPinBotButton in remote PWA mode", () => {
    flushSync(() => root.render(createElement(PwaPinBotButton, { botId: "accounting" })));
    const pinButton = container.querySelector("[data-pwa-pin-bot]") as HTMLButtonElement | null;
    expect(pinButton).not.toBeNull();
    expect(pinButton!.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the chat input pill clean and places Attach photo and Attach files inside the + menu even when connected with empty instances", () => {
    fixture.connected = true;
    fixture.instances = [];
    flushSync(() => root.render(createElement(Composer, { bot })));
    expect(container.querySelector('button[aria-label="Attach files"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Attach photo"]')).toBeNull();

    const plusBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Add"]')!;
    expect(plusBtn).not.toBeNull();
    flushSync(() => plusBtn.click());

    const photo = document.body.querySelector<HTMLButtonElement>('[role="menu"] [data-menu-key="photo"]')!;
    const attach = document.body.querySelector<HTMLButtonElement>('[role="menu"] [data-menu-key="attach"]')!;
    const goal = document.body.querySelector<HTMLButtonElement>('[role="menu"] [data-menu-key="goal"]')!;
    expect(photo).not.toBeNull();
    expect(attach).not.toBeNull();
    expect(goal).not.toBeNull();

    const clicked: HTMLInputElement[] = [];
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      clicked.push(this);
    });
    flushSync(() => photo.click());
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.accept).toBe("image/*");
  });

  it("compresses oversized online photos and HEIC images in PWA composer before uploading with Bearer auth", async () => {
    fixture.connected = true;
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:https://mausbot.mxhan.com/compressed-preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({
      width: 3000,
      height: 2000,
      close: vi.fn(),
    })));
    vi.stubGlobal("OffscreenCanvas", class {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return { drawImage: vi.fn() };
      }
      async convertToBlob(opts?: { type?: string }) {
        return new Blob([new Uint8Array(512)], { type: opts?.type || "image/webp" });
      }
    });
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      path: "/private/attachments/11111111-1111-4111-8111-111111111111.webp",
      mime: "image/webp",
      bytes: 512,
    }), { status: 201, headers: { "content-type": "application/json" } }));

    flushSync(() => root.render(createElement(Composer, { bot })));
    const imageInput = container.querySelector<HTMLInputElement>("input[data-image-input]")!;
    expect(imageInput).not.toBeNull();
    const oversized = new File([new Uint8Array(16)], "camera.heic", { type: "" });
    Object.defineProperty(oversized, "size", { value: IMAGE_MAX_BYTES + 1024 });
    Object.defineProperty(imageInput, "files", { value: [oversized], configurable: true });
    imageInput.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));

    const attachmentCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes("/api/attachments?uploadId="));
    expect(attachmentCalls).toHaveLength(1);
    const [url, init] = attachmentCalls[0] as [string, RequestInit];
    expect(url).toBe("https://relay.mxhan.com/api/attachments?uploadId=" + url.split("uploadId=")[1]);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
    expect(new Headers(init.headers).get("content-type")).toBe("image/webp");
    const previewImg = container.querySelector('img[src^="blob:"]') as HTMLImageElement | null;
    expect(previewImg).not.toBeNull();
  });

  it("loads ComputerTab screen thumbnail with Bearer auth via useRemoteMediaUrl in remote PWA mode", async () => {
    fixture.connected = true;
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:https://mausbot.mxhan.com/screen-thumb");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    fetchSpy.mockResolvedValue(new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { "content-type": "image/png" },
    }));
    const botWithScreen: Bot = {
      ...bot,
      messages: [{ id: "m-screen-1", role: "bot", kind: "screen", at: 1, text: "", hasImage: true, mime: "image/png" }],
    };
    const derived = {
      browserEnabled: false,
      patch: vi.fn(),
      approvalMode: "ask",
    } as unknown as Parameters<typeof ComputerTab>[0]["derived"];

    flushSync(() => root.render(createElement(ComputerTab, { bot: botWithScreen, derived, onOpen: vi.fn() })));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const screenCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes("/api/threads/t-accounting/messages/m-screen-1/image"));
    expect(screenCalls).toHaveLength(1);
    const [url, init] = screenCalls[0] as [string, RequestInit];
    expect(url).toBe("https://relay.mxhan.com/api/threads/t-accounting/messages/m-screen-1/image");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
    const img = container.querySelector('img[src="blob:https://mausbot.mxhan.com/screen-thumb"]');
    expect(img).not.toBeNull();
  });
});
