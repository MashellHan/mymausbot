// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Window as HappyWindow } from "happy-dom";
import type { MiniAppDocument, MiniAppQueryResult, MiniAppState } from "../../../shared/mini-apps";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  ApiError: class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } },
}));

import { mountMiniAppFrame } from "./MiniAppFrame";
import { miniAppFrameDocument, MINI_APP_CSP } from "./mini-app-document";

const app = {
  id: "app_demo", slug: "demo", title: "Sample report", description: "Synthetic data only", status: "active" as const,
  revision: 3, templateVersion: 1, publisherBotIds: [], createdAt: 1, updatedAt: 2,
};
const document: MiniAppDocument = {
  app, html: "<!DOCTYPE html><html><body><p>Fixture page</p></body></html>", versions: [{ version: 1, createdAt: 1, title: "Sample report" }],
  bindings: [{ id: "ledger", datasetId: "dataset_demo", source: { schema: "main", table: "entries" },
    fields: { amount: { column: "amount", sourceType: "VARCHAR", as: "decimal", scale: 2 } },
    queries: { summary: { kind: "aggregate", groupBy: ["currency"], measures: [{ name: "amount", op: "sum", field: "amount" }], parameters: { currency: { type: "text", optional: true } }, filters: [], orderBy: [], pageSize: 100 } },
  }],
};
const state: MiniAppState = { appId: app.id, revision: 3, templateVersion: 1, status: "active", data: [{ datasetId: "dataset_demo", revision: 7 }] };
const page: MiniAppQueryResult = { columns: [{ name: "amount", type: "decimal" }], rows: [["-12.34"]], revision: 7 };
const teamDocument: MiniAppDocument = { ...document, app: { ...app, dashboardIdentity: "agent-team",
  dashboard: { kind: "agent-team", renderer: "html", htmlRole: "primary", editableFields: ["title", "description"],
    resources: ["teams", "activity", "configuration", "team-rules", "skill"] } }, bindings: [] };
let container: HTMLDivElement;

function send(view: Window, data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { source: view as unknown as MessageEventSource, data }));
}

beforeEach(() => {
  vi.stubGlobal("ogb", { platform: "darwin", app: { version: "fixture", ownPage: true, blocksOpaqueFrameNavigation: true } });
  fixture.api.mockReset().mockResolvedValue(page);
  container = window.document.createElement("div");
  window.document.body.append(container);
});

afterEach(() => { container.remove(); window.document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("persistent Mini App frame", () => {
  it("exposes only the selected dashboard resource to the HTML SDK and binds the installed app revision in the host", async () => {
    const doc = miniAppFrameDocument(teamDocument, false);
    const child = new HappyWindow({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
    const sent: Array<Record<string, unknown>> = [];
    const parent = { postMessage: (message: Record<string, unknown>) => sent.push(message) };
    Object.defineProperty(child, "parent", { value: parent });
    child.eval(/<script>([\s\S]*?)<\/script>/.exec(doc.srcdoc)![1]!);
    const initialized = sent.find((message) => message.method === "ui/initialize")!;
    child.dispatchEvent(new child.MessageEvent("message", { source: parent as unknown as HappyWindow,
      data: { jsonrpc: "2.0", id: initialized.id, result: { hostCapabilities: {} } } }));
    const sdk = (child as unknown as { mausApp: { dashboard: { read(request: object): Promise<unknown> } } }).mausApp;
    const pending = sdk.dashboard.read({ resource: "configuration", agentId: "w6:p1", occupantId: "o1234567890abcdef" });
    await vi.waitFor(() => expect(sent.some((message) => message.type === "dashboard-read")).toBe(true));
    const emitted = sent.find((message) => message.type === "dashboard-read")!;
    expect(emitted).toMatchObject({ selection: { resource: "configuration", agentId: "w6:p1", occupantId: "o1234567890abcdef" } });
    expect(JSON.stringify(emitted)).not.toContain("expectedRevision");
    child.dispatchEvent(new child.MessageEvent("message", { source: parent as unknown as HappyWindow,
      data: { mausMiniApp: 1, type: "dashboard-result", id: emitted.id,
        result: { appId: app.id, revision: 3, resource: "configuration", snapshot: { status: "ready" } } } }));
    await expect(pending).resolves.toMatchObject({ resource: "configuration" });
    await child.happyDOM.abort();

    const selected = { resource: "configuration", agentId: "w6:p1", occupantId: "o1234567890abcdef" };
    const answer = { appId: app.id, revision: 3, resource: "configuration", snapshot: { agentId: "w6:p1", occupantId: selected.occupantId } };
    fixture.api.mockResolvedValue(answer);
    const mount = mountMiniAppFrame({ container, document: teamDocument, state: { ...state, data: [] }, onRevoked: vi.fn() });
    const view = mount.iframe.contentWindow!;
    const posted = vi.spyOn(view, "postMessage");
    send(window, { mausMiniApp: 1, type: "dashboard-read", id: "foreign", selection: selected });
    send(view, { mausMiniApp: 1, type: "dashboard-read", id: "spoof", selection: { ...selected, expectedRevision: 999 } });
    expect(fixture.api).not.toHaveBeenCalled();
    send(view, { mausMiniApp: 1, type: "dashboard-read", id: "good", selection: selected });
    await vi.waitFor(() => expect(posted.mock.calls.find(([value]) => (value as { id?: string }).id === "good")?.[0])
      .toMatchObject({ result: answer }));
    expect(fixture.api).toHaveBeenCalledWith(`/api/mini-apps/${app.id}/dashboard`, expect.objectContaining({
      method: "POST", body: JSON.stringify({ ...selected, expectedRevision: 3 }),
    }));
    mount.retire();
    const old = { ...teamDocument, app: { ...teamDocument.app, dashboard: { ...teamDocument.app.dashboard!,
      renderer: "native" as const, htmlRole: "fallback-only" as const, resources: ["teams", "activity"] as const } } } as MiniAppDocument;
    const fallback = mountMiniAppFrame({ container, document: old, state: { ...state, data: [] }, onRevoked: vi.fn() });
    send(fallback.iframe.contentWindow!, { mausMiniApp: 1, type: "dashboard-read", id: "blocked", selection: selected });
    expect(fixture.api).toHaveBeenCalledTimes(1);
    fallback.retire();
  });
  it("starts with an opaque document and no generic app capability", () => {
    const doc = miniAppFrameDocument(document, false);
    expect(doc.srcdoc).toMatch(/^<!DOCTYPE html><meta http-equiv="Content-Security-Policy"/);
    expect(doc.srcdoc).toContain("window, \"mausApp\"");
    expect(doc.srcdoc).not.toContain("window.mausbot");
    expect(doc.csp).toBe(MINI_APP_CSP);
    expect(doc.csp).toContain("connect-src 'none'");
    expect(doc.can).toEqual({ serverTools: false, serverResources: false, message: false, openLinks: false, modelContext: false });
    expect(doc.network).toEqual({ connect: [], resources: [] });
    const mount = mountMiniAppFrame({ container, document, state, onRevoked: vi.fn() });
    expect(mount.iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(mount.iframe.hasAttribute("allow")).toBe(false);
    mount.retire();
  });

  it("offers openSource only after a built-in report receives its link capability", async () => {
    const report = { ...document, app: { ...app, shippedTemplateKind: "x_ai_digest" as const } };
    const reportDoc = miniAppFrameDocument(report, true);
    expect(reportDoc.can.openLinks).toBe(true);
    expect(miniAppFrameDocument(report, false).can.openLinks).toBe(false);
    expect(miniAppFrameDocument({ ...report, app: { ...report.app, status: "archived" } }, true).can.openLinks).toBe(false);
    expect(miniAppFrameDocument({ ...report, app: { ...report.app, shippedTemplateKind: "bookkeeping" } }, true).can.openLinks).toBe(false);
    for (const [doc, allowed] of [[reportDoc, true], [miniAppFrameDocument(document, false), false]] as const) {
      const view = new HappyWindow({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
      const sent: Array<Record<string, unknown>> = [];
      const parent = { postMessage: (message: Record<string, unknown>) => sent.push(message) };
      Object.defineProperty(view, "parent", { value: parent });
      const script = /<script>([\s\S]*?)<\/script>/.exec(doc.srcdoc)?.[1];
      expect(script).toBeTruthy();
      view.eval(script!);
      const sdk = (view as unknown as { mausApp: { openSource?: (url: string) => Promise<void> } }).mausApp;
      expect(typeof sdk.openSource).toBe("undefined");
      const initialize = sent.find((message) => message.method === "ui/initialize")!;
      view.dispatchEvent(new view.MessageEvent("message", { source: parent as unknown as HappyWindow,
        data: { jsonrpc: "2.0", id: initialize.id, result: { hostCapabilities: allowed ? { openLinks: {} } : {} } } }));
      await Promise.resolve();
      expect(typeof sdk.openSource).toBe(allowed ? "function" : "undefined");
      if (allowed) {
        const opening = sdk.openSource!("https://example.com/report");
        await vi.waitFor(() => expect(sent.some((message) => message.method === "ui/open-link")).toBe(true));
        const request = sent.find((message) => message.method === "ui/open-link")!;
        expect(request.params).toEqual({ url: "https://example.com/report" });
        view.dispatchEvent(new view.MessageEvent("message", { source: parent as unknown as HappyWindow,
          data: { jsonrpc: "2.0", id: request.id, result: {} } }));
        await expect(opening).resolves.toBeUndefined();
      }
      await view.happyDOM.abort();
    }
    const fallback = mountMiniAppFrame({ container, document: report, state, onRevoked: vi.fn() });
    const frame = fallback.iframe.contentWindow!;
    const posted = vi.spyOn(frame, "postMessage");
    send(frame, { jsonrpc: "2.0", id: "init", method: "ui/initialize", params: {} });
    const answer = posted.mock.calls.find(([message]) => (message as { id?: string }).id === "init")?.[0] as
      { result: { hostCapabilities: { openLinks?: object } } };
    expect(answer.result.hostCapabilities.openLinks).toBeUndefined();
    fallback.retire();
  });

  it("sends only declared named reads with the host's app and Data revisions", async () => {
    const mount = mountMiniAppFrame({ container, document, state, onRevoked: vi.fn() });
    const view = mount.iframe.contentWindow!;
    const posted = vi.spyOn(view, "postMessage");
    send(window, { mausMiniApp: 1, type: "query", id: "foreign", queryId: "summary", parameters: {} });
    send(view, { mausMiniApp: 1, type: "query", id: "bad", queryId: "tools/call", parameters: {} });
    send(view, { mausMiniApp: 1, type: "query", id: "extra", queryId: "summary", parameters: { path: "/private" } });
    expect(fixture.api).not.toHaveBeenCalled();
    send(view, { mausMiniApp: 1, type: "query", id: "good", queryId: "summary", parameters: { currency: "CNY" } });
    await vi.waitFor(() => expect(posted.mock.calls.some(([answer]) => (answer as { id?: string }).id === "good")).toBe(true));
    expect(fixture.api).toHaveBeenCalledWith("/api/mini-apps/app_demo/query", expect.objectContaining({
      method: "POST", body: JSON.stringify({ queryId: "summary", parameters: { currency: "CNY" }, expectedRevision: 3, expectedDataRevision: 7 }),
    }));
    expect(posted.mock.calls.find(([answer]) => (answer as { id?: string }).id === "good")?.[0]).toMatchObject({ result: page });
    mount.retire();
  });

  it("opens a report source only through an engaged guarded desktop frame", async () => {
    const openExternal = vi.fn(async () => true);
    vi.stubGlobal("ogb", { platform: "darwin", app: { version: "fixture", ownPage: true, blocksOpaqueFrameNavigation: true }, openExternal });
    const focused = vi.spyOn(window.document, "hasFocus").mockReturnValue(true);
    const report = { ...document, app: { ...app, shippedTemplateKind: "github_activity" as const } };
    const mount = mountMiniAppFrame({ container, document: report, state, onRevoked: vi.fn() });
    const view = mount.iframe.contentWindow!;
    const posted = vi.spyOn(view, "postMessage");
    send(view, { jsonrpc: "2.0", id: "init", method: "ui/initialize", params: {} });
    expect(posted.mock.calls.find(([message]) => (message as { id?: string }).id === "init")?.[0])
      .toMatchObject({ result: { hostCapabilities: { openLinks: {} } } });
    send(view, { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    send(view, { jsonrpc: "2.0", id: "early", method: "ui/open-link", params: { url: "https://example.com/report" } });
    await vi.waitFor(() => expect(posted.mock.calls.some(([message]) => (message as { id?: string }).id === "early")).toBe(true));
    expect(openExternal).not.toHaveBeenCalled();
    mount.iframe.dispatchEvent(new Event("pointerenter"));
    mount.iframe.focus();
    await new Promise((resolve) => setTimeout(resolve, 0));
    send(view, { jsonrpc: "2.0", id: "invalid", method: "ui/open-link", params: { url: "https://user:pass@example.com/report" } });
    await vi.waitFor(() => expect(posted.mock.calls.some(([message]) => (message as { id?: string }).id === "invalid")).toBe(true));
    expect(posted.mock.calls.find(([message]) => (message as { id?: string }).id === "invalid")?.[0])
      .toMatchObject({ error: { message: expect.stringContaining("Only http and https") } });
    expect(openExternal).not.toHaveBeenCalled();
    send(view, { jsonrpc: "2.0", id: "good", method: "ui/open-link", params: { url: "https://example.com/report" } });
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://example.com/report"));
    await vi.waitFor(() => expect(posted.mock.calls.find(([message]) => (message as { id?: string }).id === "good")?.[0]).toMatchObject({ result: {} }));
    send(view, { jsonrpc: "2.0", id: "rate", method: "ui/open-link", params: { url: "https://example.com/again" } });
    await vi.waitFor(() => expect(posted.mock.calls.some(([message]) => (message as { id?: string }).id === "rate")).toBe(true));
    expect(posted.mock.calls.find(([message]) => (message as { id?: string }).id === "rate")?.[0])
      .toMatchObject({ error: { message: expect.stringContaining("Too many links") } });
    expect(openExternal).toHaveBeenCalledTimes(1);
    mount.retire();
    focused.mockRestore();
  });

  it("keeps an archived report from opening a source even after frame engagement", async () => {
    const openExternal = vi.fn(async () => true);
    vi.stubGlobal("ogb", { platform: "darwin", app: { version: "fixture", ownPage: true, blocksOpaqueFrameNavigation: true }, openExternal });
    vi.spyOn(window.document, "hasFocus").mockReturnValue(true);
    const report = { ...document, app: { ...app, shippedTemplateKind: "x_ai_digest" as const } };
    const mount = mountMiniAppFrame({ container, document: report, state: { ...state, status: "archived" }, onRevoked: vi.fn() });
    const view = mount.iframe.contentWindow!;
    const posted = vi.spyOn(view, "postMessage");
    send(view, { jsonrpc: "2.0", id: "init", method: "ui/initialize", params: {} });
    send(view, { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    mount.iframe.dispatchEvent(new Event("pointerenter"));
    mount.iframe.focus();
    await new Promise((resolve) => setTimeout(resolve, 0));
    send(view, { jsonrpc: "2.0", id: "archived", method: "ui/open-link", params: { url: "https://example.com/report" } });
    await vi.waitFor(() => expect(posted.mock.calls.find(([message]) => (message as { id?: string }).id === "archived")?.[0])
      .toMatchObject({ error: { message: expect.stringContaining("unavailable") } }));
    expect(openExternal).not.toHaveBeenCalled();
    mount.retire();
  });

  it("invalidates an old read and rejects an old Data revision after a state change", async () => {
    let resolve!: (value: MiniAppQueryResult) => void;
    fixture.api.mockImplementationOnce(() => new Promise<MiniAppQueryResult>((done) => { resolve = done; })).mockResolvedValue(page);
    const mount = mountMiniAppFrame({ container, document, state, onRevoked: vi.fn() });
    const view = mount.iframe.contentWindow!;
    const posted = vi.spyOn(view, "postMessage");
    send(view, { mausMiniApp: 1, type: "query", id: "old", queryId: "summary", parameters: {} });
    expect(fixture.api).toHaveBeenCalledTimes(1);
    mount.update({ ...state, revision: 4, data: [{ datasetId: "dataset_demo", revision: 8 }] });
    expect(posted.mock.calls.some(([answer]) => (answer as { type?: string }).type === "data-changed")).toBe(true);
    expect(posted.mock.calls.find(([answer]) => (answer as { id?: string }).id === "old")?.[0]).toMatchObject({ error: expect.stringContaining("Data changed") });
    send(view, { mausMiniApp: 1, type: "query", id: "stale", queryId: "summary", parameters: {}, options: { expectedDataRevision: 7 } });
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(posted.mock.calls.find(([answer]) => (answer as { id?: string }).id === "stale")?.[0]).toMatchObject({ error: expect.stringContaining("Data changed") });
    resolve(page);
    await Promise.resolve();
    expect(posted.mock.calls.filter(([answer]) => (answer as { id?: string }).id === "old" && (answer as { result?: unknown }).result)).toHaveLength(0);
    mount.retire();
  });

  it("settles pending reads on teardown and refuses data from an archived mount", async () => {
    let resolve!: (value: MiniAppQueryResult) => void;
    fixture.api.mockImplementationOnce(() => new Promise<MiniAppQueryResult>((done) => { resolve = done; }));
    const mount = mountMiniAppFrame({ container, document, state, onRevoked: vi.fn() });
    const view = mount.iframe.contentWindow!;
    const posted = vi.spyOn(view, "postMessage");
    send(view, { mausMiniApp: 1, type: "query", id: "pending", queryId: "summary", parameters: {} });
    mount.retire();
    expect(posted.mock.calls.find(([answer]) => (answer as { id?: string }).id === "pending")?.[0]).toMatchObject({ error: "This app was closed." });
    resolve(page);
    await Promise.resolve();
    expect(posted.mock.calls.filter(([answer]) => (answer as { id?: string }).id === "pending" && (answer as { result?: unknown }).result)).toHaveLength(0);

    const archived = mountMiniAppFrame({ container, document, state: { ...state, status: "archived" }, onRevoked: vi.fn() });
    const archivedView = archived.iframe.contentWindow!;
    const reads = fixture.api.mock.calls.length;
    send(archivedView, { mausMiniApp: 1, type: "query", id: "archived", queryId: "summary", parameters: {} });
    expect(fixture.api).toHaveBeenCalledTimes(reads);
    archived.retire();
  });

  it("refuses an unguarded browser before creating a frame or sending a query", () => {
    vi.stubGlobal("ogb", undefined);
    expect(() => mountMiniAppFrame({ container, document, state, onRevoked: vi.fn() })).toThrow(/guarded desktop window/);
    expect(container.querySelector("iframe")).toBeNull();
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("does not deliver a successful read if the native guard disappears before the response", async () => {
    let resolve!: (value: MiniAppQueryResult) => void;
    fixture.api.mockImplementationOnce(() => new Promise<MiniAppQueryResult>((done) => { resolve = done; }));
    const mount = mountMiniAppFrame({ container, document, state, onRevoked: vi.fn() });
    const view = mount.iframe.contentWindow!;
    const posted = vi.spyOn(view, "postMessage");
    send(view, { mausMiniApp: 1, type: "query", id: "guarded", queryId: "summary", parameters: {} });
    vi.stubGlobal("ogb", undefined);
    resolve(page);
    await vi.waitFor(() => expect(posted.mock.calls.some(([answer]) => (answer as { id?: string }).id === "guarded")).toBe(true));
    expect(posted.mock.calls.find(([answer]) => (answer as { id?: string }).id === "guarded")?.[0]).toMatchObject({ error: expect.stringContaining("guarded desktop window") });
    mount.retire();
  });
});
