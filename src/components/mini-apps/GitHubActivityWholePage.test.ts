// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { MiniAppDocument, MiniAppState, MiniAppSummary } from "../../../shared/mini-apps";
import type { GithubActivitySelection } from "./github-activity-host";
import { GITHUB_ACTIVITY_APP_ID, GITHUB_ACTIVITY_FRAME_NAME, GITHUB_ACTIVITY_URL } from "./github-activity-host";

const mockState = vi.hoisted(() => ({
  lastSelection: null as GithubActivitySelection | null,
  triggerSelection: null as ((selection: GithubActivitySelection) => void) | null,
}));

vi.mock("./MiniAppFrame", () => ({
  MiniAppFrame: ({ state, onRevoked, githubSelection, onGithubSelectionChange }: {
    state: MiniAppState;
    onRevoked(): void;
    githubSelection?: GithubActivitySelection | null;
    onGithubSelectionChange?(selection: GithubActivitySelection): void;
  }) => {
    mockState.lastSelection = githubSelection ?? null;
    mockState.triggerSelection = onGithubSelectionChange ?? null;
    return createElement("button", {
      "data-testid": "saved-report",
      "data-revision": state.revision,
      "data-edition": githubSelection?.editionKey ?? "",
      "data-repo": githubSelection?.repo ?? "",
      onClick: onRevoked,
    }, "Saved report");
  },
}));

import { GitHubActivityWholePage } from "./GitHubActivityWholePage";

const app: MiniAppSummary = {
  id: GITHUB_ACTIVITY_APP_ID,
  slug: "github-activity",
  title: "Github Rending",
  description: "",
  status: "active",
  revision: 6,
  templateVersion: 6,
  shippedTemplateKind: "github_activity",
  publisherBotIds: [],
  createdAt: 1,
  updatedAt: 1,
};
const document: MiniAppDocument = { app, html: "<p>Synthetic saved report</p>", bindings: [], versions: [] };
const state: MiniAppState = { appId: GITHUB_ACTIVITY_APP_ID, revision: 6, templateVersion: 6, status: "active", data: [] };
let root: Root;
let host: HTMLDivElement;
let revoked: () => void;
const frame = () => host.querySelector<HTMLIFrameElement>("[data-github-activity-frame]");
const tab = (view: "web" | "saved") => host.querySelector<HTMLButtonElement>(`[data-github-activity-tab="${view}"]`)!;
const panel = (view: "web" | "saved") => window.document.getElementById(tab(view).getAttribute("aria-controls")!)!;
const press = (view: "web" | "saved", key: string) =>
  act(() => tab(view).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
const render = () => act(() => root.render(createElement(GitHubActivityWholePage, { document, state, onRevoked: revoked })));
const watchPosts = (site: HTMLIFrameElement) => {
  Object.defineProperty(site, "contentWindow", { configurable: true, value: window });
  return vi.spyOn(window, "postMessage").mockImplementation(() => {});
};
const message = (type: string, path: string, extra: Record<string, unknown> = {}, origin = "https://mxhan.com",
  source: MessageEventSource | null = frame()?.contentWindow ?? null) =>
  act(() => window.dispatchEvent(new MessageEvent("message", {
    origin,
    source,
    data: { githubDeepDive: 1, type, path, ...extra },
  })));
const load = (site: HTMLIFrameElement, post: ReturnType<typeof vi.spyOn>) => {
  act(() => site.dispatchEvent(new Event("load")));
  const [challenge, target] = post.mock.calls.at(-1)! as [{ githubDeepDive: number; type: string; nonce: string }, string];
  expect(challenge).toMatchObject({ githubDeepDive: 1, type: "challenge" });
  expect(target).toBe("https://mxhan.com");
  return challenge.nonce;
};

beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mockState.lastSelection = null;
  mockState.triggerSelection = null;
  host = window.document.createElement("div");
  window.document.body.append(host);
  root = createRoot(host);
  revoked = vi.fn<() => void>();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("enforces githubDeepDive handshake and route validation", () => {
  render();
  const site = frame()!;
  expect(site.getAttribute("src")).toBe(GITHUB_ACTIVITY_URL);
  expect(site.getAttribute("name")).toBe(GITHUB_ACTIVITY_FRAME_NAME);
  expect(site.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-popups");
  expect(site.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(site.getAttribute("allow")).toContain("camera 'none'");

  const post = watchPosts(site);
  message("ready", "/github/20261120/", { nonce: "stale" });
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  const nonce = load(site, post);
  message("ready", "/github/20261120/", { nonce }, "https://other.example");
  message("ready", "/github/20261120/", { nonce }, "https://mxhan.com", null);
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  message("ready", "/github/20261120/dream-num/univer/", { nonce, editionKey: "2026-11-20", repo: "dream-num/univer" });
  expect(host.querySelector('[role="status"]')).toBeNull();

  message("leaving", "/github/20261120/dream-num/univer/");
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  const next = load(site, post);
  message("ready", "/github/demo/univer-orders/", { nonce: next });
  expect(host.querySelector('[role="status"]')).toBeNull();

  message("leaving", "/github/demo/univer-orders/");
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  const panderaNonce = load(site, post);
  message("ready", "/github/demo/pandera-orders/", { nonce: panderaNonce, editionKey: "2026-11-21", repo: "unionai-oss/pandera" });
  expect(host.querySelector('[role="status"]')).toBeNull();
  press("web", "ArrowRight");
  expect(mockState.lastSelection).toEqual({ editionKey: "2026-11-21", repo: "unionai-oss/pandera" });

  press("saved", "Home");
  const sqlglotSite = frame()!;
  const sqlglotPost = watchPosts(sqlglotSite);
  const sqlglotNonce = load(sqlglotSite, sqlglotPost);
  message("ready", "/github/demo/sqlglot-query-lab/", { nonce: "stale", editionKey: "2026-11-22", repo: "tobymao/sqlglot" });
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  message("ready", "/github/demo/sqlglot-query-lab/", { nonce: sqlglotNonce, editionKey: "2026-11-22", repo: "tobymao/sqlglot" });
  expect(host.querySelector('[role="status"]')).toBeNull();
  press("web", "ArrowRight");
  expect(mockState.lastSelection).toEqual({ editionKey: "2026-11-22", repo: "tobymao/sqlglot" });

  press("saved", "Home");
  const shownSite = frame()!;
  const shownPost = watchPosts(shownSite);
  message("shown", "/github/demo/sqlglot-query-lab/");
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  const shownNonce = shownPost.mock.calls.at(-1)![0].nonce as string;
  message("ready", "/github/demo/sqlglot-query-lab/", { nonce: shownNonce, editionKey: "2026-11-22", repo: "tobymao/sqlglot" });
  expect(host.querySelector('[role="status"]')).toBeNull();

  message("leaving", "/github/demo/sqlglot-query-lab/");
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  const badNonce = load(shownSite, shownPost);
  message("ready", "/github/demo/sqlglot-query-lab/", { nonce: badNonce, editionKey: "2026-11-21", repo: "tobymao/sqlglot" });
  expect(host.querySelector('[data-testid="github-activity-failed"]')).not.toBeNull();

  act(() => host.querySelector<HTMLButtonElement>('[data-testid="github-activity-failed"] button')!.click());
  const retriedSite = frame()!;
  const retriedPost = watchPosts(retriedSite);
  const missingContextNonce = load(retriedSite, retriedPost);
  message("ready", "/github/demo/sqlglot-query-lab/", { nonce: missingContextNonce }, "https://mxhan.com", retriedSite.contentWindow);
  expect(host.querySelector('[data-testid="github-activity-failed"]')).not.toBeNull();

  act(() => host.querySelector<HTMLButtonElement>('[data-testid="github-activity-failed"] button')!.click());
  const hypothesisSite = frame()!;
  const hypothesisPost = watchPosts(hypothesisSite);
  const hypothesisNonce = load(hypothesisSite, hypothesisPost);
  message("ready", "/github/demo/hypothesis-orders/", { nonce: "stale", editionKey: "2026-11-23", repo: "hypothesisworks/hypothesis" });
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  message("ready", "/github/demo/hypothesis-orders/", { nonce: hypothesisNonce, editionKey: "2026-11-23", repo: "hypothesisworks/hypothesis" });
  expect(host.querySelector('[role="status"]')).toBeNull();
  press("web", "ArrowRight");
  expect(mockState.lastSelection).toEqual({ editionKey: "2026-11-23", repo: "hypothesisworks/hypothesis" });

  press("saved", "Home");
  const hypothesisShownSite = frame()!;
  const hypothesisShownPost = watchPosts(hypothesisShownSite);
  message("shown", "/github/demo/hypothesis-orders/");
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  const hypothesisShownNonce = hypothesisShownPost.mock.calls.at(-1)![0].nonce as string;
  message("ready", "/github/demo/hypothesis-orders/", { nonce: hypothesisShownNonce, editionKey: "2026-11-23", repo: "hypothesisworks/hypothesis" });
  expect(host.querySelector('[role="status"]')).toBeNull();

  message("leaving", "/github/demo/hypothesis-orders/");
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  const badCaseNonce = load(hypothesisShownSite, hypothesisShownPost);
  message("ready", "/github/demo/hypothesis-orders/", { nonce: badCaseNonce, editionKey: "2026-11-23", repo: "HypothesisWorks/hypothesis" });
  expect(host.querySelector('[data-testid="github-activity-failed"]')).not.toBeNull();

  act(() => host.querySelector<HTMLButtonElement>('[data-testid="github-activity-failed"] button')!.click());
  const supersededPathSite = frame()!;
  const supersededPathPost = watchPosts(supersededPathSite);
  const supersededPathNonce = load(supersededPathSite, supersededPathPost);
  message("ready", "/github/demo/hypothesis-orders-lab/", { nonce: supersededPathNonce, editionKey: "2026-11-23", repo: "hypothesisworks/hypothesis" });
  expect(host.querySelector('[data-testid="github-activity-failed"]')).not.toBeNull();
});

it("syncs reading selection across Web and Saved editions tabs", () => {
  render();
  const site = frame()!;
  const post = watchPosts(site);
  const nonce = load(site, post);
  message("ready", "/github/20261120/dream-num/univer/", { nonce, editionKey: "2026-11-20", repo: "dream-num/univer" });

  press("web", "ArrowRight");
  expect(panel("saved").hidden).toBe(false);
  expect(mockState.lastSelection).toEqual({ editionKey: "2026-11-20", repo: "dream-num/univer" });

  act(() => mockState.triggerSelection?.({ editionKey: "2026-11-21", repo: "vuejs/core" }));
  press("saved", "Home");
  expect(frame()?.getAttribute("src")).toBe("https://mxhan.com/github/20261121/vuejs/core/");
});

it("times out silently, retries on request, and retains Saved editions fallback", () => {
  vi.useFakeTimers();
  render();
  const first = frame();
  act(() => vi.advanceTimersByTime(10_000));
  expect(host.querySelector('[data-testid="github-activity-failed"]')).not.toBeNull();
  expect(frame()).toBeNull();

  act(() => host.querySelector<HTMLButtonElement>('[data-testid="github-activity-failed"] button')!.click());
  expect(frame()).not.toBe(first);
  message("ready", "/github/media/bad.png");
  expect(host.querySelector('[data-testid="github-activity-failed"]')).not.toBeNull();

  const fallbackButton = host.querySelectorAll<HTMLButtonElement>('[data-testid="github-activity-failed"] button')[1]!;
  expect(fallbackButton.textContent).toBe("Open Native");
  act(() => fallbackButton.click());
  expect(host.querySelector('[data-testid="saved-report"]')?.getAttribute("data-revision")).toBe("6");
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="saved-report"]')!.click());
  expect(revoked).toHaveBeenCalledOnce();
});

it("uses explicit Web/网页版 and Native tab, tabpanel aria, and failure fallback labels with keyboard roving focus", () => {
  vi.useFakeTimers();
  render();
  expect(tab("web").textContent).toBe("Web");
  expect(tab("saved").textContent).toBe("Native");
  expect(panel("web").getAttribute("aria-labelledby")).toBe(tab("web").id);
  expect(panel("saved").getAttribute("aria-labelledby")).toBe(tab("saved").id);
  expect(tab("web").getAttribute("aria-selected")).toBe("true");
  expect(tab("saved").getAttribute("aria-selected")).toBe("false");
  expect(tab("web").tabIndex).toBe(0);
  expect(tab("saved").tabIndex).toBe(-1);
  expect(panel("web").hidden).toBe(false);
  expect(panel("saved").hidden).toBe(true);

  // Modified key should be ignored
  act(() => tab("web").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true, cancelable: true })));
  expect(tab("web").getAttribute("aria-selected")).toBe("true");

  // Roving focus via ArrowRight / ArrowLeft / End / Home
  press("web", "ArrowRight");
  expect(window.document.activeElement).toBe(tab("saved"));
  expect(tab("saved").getAttribute("aria-selected")).toBe("true");
  expect(tab("saved").tabIndex).toBe(0);
  expect(tab("web").tabIndex).toBe(-1);
  expect(panel("saved").hidden).toBe(false);
  expect(panel("web").hidden).toBe(true);

  press("saved", "ArrowLeft");
  expect(window.document.activeElement).toBe(tab("web"));
  expect(panel("web").hidden).toBe(false);

  press("web", "End");
  expect(window.document.activeElement).toBe(tab("saved"));
  press("saved", "Home");
  expect(window.document.activeElement).toBe(tab("web"));

  // Chinese locale uses explicit 网页版 / Native / 打开 Native (not Daily X labels)
  act(() => setLocale("zh"));
  render();
  expect(tab("web").textContent).toBe("网页版");
  expect(tab("saved").textContent).toBe("Native");
  expect(tab("saved").textContent).not.toContain("已保存的报告");

  act(() => vi.advanceTimersByTime(10_000));
  const buttons = host.querySelectorAll<HTMLButtonElement>('[data-testid="github-activity-failed"] button');
  expect(buttons[1]!.textContent).toBe("打开 Native");
  expect(buttons[1]!.textContent).not.toContain("打开报告");
});
