// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => { container.remove(); window.document.body.innerHTML = ""; vi.unstubAllGlobals(); });

describe("persistent Mini App frame", () => {
  it("starts with an opaque document and no generic app capability", () => {
    const doc = miniAppFrameDocument(document);
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
