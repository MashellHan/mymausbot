// @vitest-environment happy-dom
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Window as HappyWindow } from "happy-dom";
import type { MiniAppDocument, MiniAppQueryResult, MiniAppState } from "../../../shared/mini-apps";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  ApiError: class ApiError extends Error { constructor(message: string, readonly status: number, readonly body?: Record<string, unknown>) { super(message); } },
}));

import { ApiError } from "@/state/store";
import { AgentRoleEditor } from "./AgentRoleEditor";
import { MiniAppFrame, mountMiniAppFrame } from "./MiniAppFrame";
import { miniAppFrameDocument, MINI_APP_CSP } from "./mini-app-document";
import { AppDocs } from "../../../server/app-docs";
import { MiniApps } from "../../../server/mini-apps/registry";
import { removeTempDir } from "../../../server/testing/cleanup";
import type { LocalAgentTeamsResponse } from "../../../shared/local-dashboard";

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
const managedTeamDocument: MiniAppDocument = { ...teamDocument, app: { ...teamDocument.app, release: {
  packageId: "mashellhan.agent-team", appVersion: "0.1.4", sourceCommit: "a".repeat(40),
  tag: "mini-app/agent-team/v0.1.4", requires: ["agent-team-v1"], htmlSha256: "b".repeat(64),
  htmlBytes: 16, queriesSha256: "c".repeat(64), queriesBytes: 8,
} } };
const usageDocument: MiniAppDocument = { ...document, app: { ...app, title: "Activities", dashboardIdentity: "usage",
  dashboard: { kind: "usage", renderer: "html", htmlRole: "primary", editableFields: ["title", "description"], resources: ["usage"] } }, bindings: [] };
const usageState: MiniAppState = { ...state, data: [] };
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
  it("opens the native Agent MD editor from the current managed frame and accepts only its exact member target", () => {
    Object.defineProperties(container, { clientWidth: { value: 500 }, clientHeight: { value: 500 } });
    vi.spyOn(window.document, "visibilityState", "get").mockReturnValue("visible");
    const onAgentRoleEdit = vi.fn();
    const mount = mountMiniAppFrame({ container, document: managedTeamDocument, state: { ...state, data: [] }, onRevoked: vi.fn(), onAgentRoleEdit });
    const view = mount.iframe.contentWindow!;
    const dispatch = (data: unknown, origin = "null") => window.dispatchEvent(new MessageEvent("message", {
      source: view as unknown as MessageEventSource, data, origin,
    }));
    const selection = { agentId: "w6:p1", occupantId: "o1234567890abcdef" };
    const request = { mausMiniApp: 1, type: "agent-md-edit", id: "mini:2", selection };
    expect(mount.iframe.srcdoc).toContain("openAgentEditor");
    try {
      dispatch(request);
      dispatch({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
      dispatch(request, "https://synthetic.invalid");
      dispatch({ ...request, selection: { ...selection, text: "# Unexpected" } });
      dispatch({ ...request, selection: { ...selection, path: "/tmp/private.md" } });
      expect(onAgentRoleEdit).not.toHaveBeenCalled();
      dispatch(request);
      expect(onAgentRoleEdit).toHaveBeenCalledExactlyOnceWith({ ...selection, appId: app.id, revision: 3 });
      mount.update({ ...state, revision: 4, data: [] });
      dispatch(request);
      expect(onAgentRoleEdit).toHaveBeenCalledTimes(1);
      expect(fixture.api).not.toHaveBeenCalled();
    } finally { mount.retire(); }
  });

  it("previews the unsaved Agent MD draft and keeps it when switching back to edit", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    fixture.api.mockResolvedValue({
      text: "# Original", hash: "original", documentId: "fixture", agentName: "Fixture agent",
      file: "roles/dev.md", sourcePath: "/fixture/roles/dev.md", memberNames: ["Fixture agent"], runtime: "codex",
    });
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(AgentRoleEditor, {
        selection: { agentId: "w6:p1", occupantId: "o1234567890abcdef", appId: app.id, revision: 3 },
        onClose: vi.fn(), onSaved: vi.fn(),
      })));
      const dialog = window.document.querySelector<HTMLDialogElement>("dialog[data-agent-role-editor]")!;
      const field = dialog.querySelector("textarea")!;
      const action = (label: string) => [...dialog.querySelectorAll("button")].find((button) => button.textContent === label)!;
      expect(field.hidden).toBe(false);
      expect(action("Preview").nextElementSibling?.textContent).toBe("Close");
      const draft = "# Unsaved heading\n\n- Item\n\n![Image](https://example.invalid/image.png)";
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, draft);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });

      act(() => action("Preview").click());
      expect(field.hidden).toBe(true);
      const preview = dialog.querySelector('[aria-label="Preview"]')!;
      expect(preview.querySelector("h1")?.textContent).toBe("Unsaved heading");
      expect(preview.querySelector("li")?.textContent).toBe("Item");
      expect(preview.querySelector("img")).toBeNull();

      act(() => action("Edit").click());
      expect(field.hidden).toBe(false);
      expect(field.value).toBe(draft);
      expect(action("Save").disabled).toBe(false);
      expect(fixture.api).toHaveBeenCalledTimes(1);

      act(() => action("Preview").click());
      fixture.api.mockRejectedValueOnce(new ApiError("Role changed", 409, {
        code: "conflict", current: "# Current role", currentHash: "current",
      }));
      await act(async () => action("Save").click());
      act(() => {
        action("Reload").focus();
        action("Reload").click();
      });
      const currentPreview = dialog.querySelector('[aria-label="Preview"]')!;
      expect(window.document.activeElement).toBe(currentPreview);
      expect(currentPreview.querySelector("h1")?.textContent).toBe("Current role");

      act(() => {
        action("Dismiss draft").focus();
        action("Dismiss draft").click();
      });
      expect(window.document.activeElement).toBe(currentPreview);
    } finally { act(() => root.unmount()); }
  });

  it("reopens Agent MD after the managed document advances within the same template version", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(window.document, "visibilityState", "get").mockReturnValue("visible");
    fixture.api.mockImplementation(() => new Promise(() => {}));
    const root = createRoot(container);
    const render = (document: MiniAppDocument, revision: number) => act(() => root.render(createElement(MiniAppFrame, {
      document, state: { ...state, revision, data: [] }, onRevoked: vi.fn(),
    })));
    const selection = { agentId: "w6:p1", occupantId: "o1234567890abcdef" };
    const dispatch = (source: Window, data: unknown) => window.dispatchEvent(new MessageEvent("message", { source, data, origin: "null" }));
    const openEditor = (source: Window) => act(() => {
      dispatch(source, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
      dispatch(source, { mausMiniApp: 1, type: "agent-md-edit", id: "mini:2", selection });
    });
    const dialog = () => window.document.querySelector("dialog[data-agent-role-editor]");
    try {
      render(managedTeamDocument, 3);
      const oldFrame = container.querySelector("iframe")!;
      Object.defineProperties(oldFrame.parentElement!, { clientWidth: { value: 500 }, clientHeight: { value: 500 } });
      const oldView = oldFrame.contentWindow!;
      openEditor(oldView);
      expect(dialog()).not.toBeNull();
      expect(fixture.api).toHaveBeenLastCalledWith(`/api/mini-apps/${app.id}/agent-md`, expect.objectContaining({
        method: "POST", body: JSON.stringify({ ...selection, expectedRevision: 3 }),
      }));

      render({ ...managedTeamDocument, app: { ...managedTeamDocument.app, title: "Renamed team", revision: 4 } }, 4);
      expect(oldFrame.isConnected).toBe(false);
      expect(dialog()).toBeNull();
      openEditor(oldView);
      expect(fixture.api).toHaveBeenCalledTimes(1);

      openEditor(container.querySelector("iframe")!.contentWindow!);
      expect(dialog()).not.toBeNull();
      expect(fixture.api).toHaveBeenLastCalledWith(`/api/mini-apps/${app.id}/agent-md`, expect.objectContaining({
        method: "POST", body: JSON.stringify({ ...selection, expectedRevision: 4 }),
      }));
    } finally { act(() => root.unmount()); }
  });

  it("carries an HTML SDK history selection through the existing frame and registry guards", async () => {
    const root = await mkdtemp(join(tmpdir(), "omb-mini-trace-"));
    const db = new DatabaseSync(":memory:");
    const owner = { writeAllowed: true, assertActive: () => undefined, canBind: () => true };
    const occupantId = "o1234567890abcdef";
    const agentId = "w6:p1";
    const streamId = "a".repeat(32);
    const before = `${streamId}.e42`;
    const selected = { resource: "activity", agentId, occupantId, history: 1, before };
    const snapshot = { agentId, status: "ready" as const, updatedAt: 1, truncated: false, events: [],
      history: { version: 1 as const, streamId, nextBefore: null } };
    const member = { id: agentId, occupantId, name: "Synthetic agent", kind: "codex", role: null, model: null,
      reasoningEffort: null, contextUsed: null, contextWindow: null, state: "working" as const, taskHint: null };
    const teams: LocalAgentTeamsResponse = { status: "ready", updatedAt: 1, teamCount: 1, teams: [{
      id: "w6", name: "Synthetic team", agentCount: 1, activeAgentCount: 1, agents: [member],
    }] };
    const readTeams = vi.fn(async () => teams);
    const readActivity = vi.fn(async () => snapshot);
    const unexpected = async () => { throw new Error("unexpected resource"); };
    const apps = new MiniApps({ docs: new AppDocs(root), data: {
      validateBinding: unexpected, readNamed: unexpected, listDatasets: async () => [],
    }, validPublisher: () => false, access: { database: () => db, write: (work) => work(db) }, dashboardProviders: {
      agents: { get: readTeams }, activity: { get: readActivity },
      configuration: { getAgent: unexpected, getTeamRules: unexpected, getSkill: unexpected }, usage: { get: unexpected },
    } });
    const child = new HappyWindow({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
    try {
      const html = await readFile("examples/mini-apps/agent-team/index.html", "utf8");
      const published = await apps.publish(owner, { requestKey: "trace-fixture", expectedRevision: 0,
        slug: "trace-fixture", title: "Synthetic trace", description: "Synthetic activity fixture",
        bindings: [], dashboardKind: "agent-team", html }, undefined, true);
      const document = apps.document(owner, published.app.id);
      const state = await apps.state(owner, published.app.id);
      await expect(apps.dashboardRead(owner, published.app.id, {
        resource: "activity", agentId, occupantId, before, expectedRevision: state.revision,
      })).rejects.toMatchObject({ status: 400 });
      fixture.api.mockImplementation(async (_path, request) => apps.dashboardRead(owner, published.app.id, JSON.parse(request.body)));
      const mount = mountMiniAppFrame({ container, document, state, onRevoked: vi.fn() });
      try {
        const view = mount.iframe.contentWindow!;
        const posted = vi.spyOn(view, "postMessage");
        const sent: Array<Record<string, unknown>> = [];
        const parent = { postMessage: (message: Record<string, unknown>) => sent.push(message) };
        Object.defineProperty(child, "parent", { value: parent });
        child.eval(/<script>([\s\S]*?)<\/script>/.exec(miniAppFrameDocument(document, false).srcdoc)![1]!);
        const initialized = sent.find((message) => message.method === "ui/initialize")!;
        const reply = (data: unknown) => child.dispatchEvent(new child.MessageEvent("message", { source: parent as unknown as HappyWindow, data }));
        reply({ jsonrpc: "2.0", id: initialized.id, result: { hostCapabilities: {} } });
        const sdk = (child as unknown as { mausApp: { dashboard: { read(request: object): Promise<unknown> } } }).mausApp;
        const pending = sdk.dashboard.read(selected);
        await vi.waitFor(() => expect(sent.some((message) => message.type === "dashboard-read")).toBe(true));
        const emitted = sent.find((message) => message.type === "dashboard-read")!;
        send(view, { ...emitted, id: "invalid", selection: { resource: "activity", agentId, occupantId, before } });
        send(view, { ...emitted, id: "redirect", selection: { ...selected, expectedRevision: 999 } });
        expect(fixture.api).not.toHaveBeenCalled();
        send(view, emitted);
        await vi.waitFor(() => {
          const response = posted.mock.calls.find(([value]) => (value as { id?: string }).id === emitted.id)?.[0];
          expect(response).toMatchObject({ result: { resource: "activity", snapshot } });
          reply(response);
        });
        await expect(pending).resolves.toMatchObject({ snapshot });
        expect(fixture.api).toHaveBeenCalledWith(`/api/mini-apps/${published.app.id}/dashboard`,
          expect.objectContaining({ body: JSON.stringify({ ...selected, expectedRevision: state.revision }) }));
        expect(readActivity).toHaveBeenCalledWith(agentId, { occupantId, before });
        expect(readTeams).toHaveBeenCalledTimes(2);
        readTeams.mockResolvedValueOnce(teams).mockResolvedValueOnce({ ...teams,
          teams: [{ ...teams.teams[0]!, agents: [{ ...member, occupantId: "o0000000000000000" }] }] });
        send(view, { ...emitted, id: "changed" });
        await vi.waitFor(() => expect(posted.mock.calls.find(([value]) => (value as { id?: string }).id === "changed")?.[0])
          .toMatchObject({ error: "The Agent Team session changed while its details were being read." }));
      } finally { mount.retire(); }
    } finally {
      await child.happyDOM.abort();
      db.close();
      await removeTempDir(root);
    }
  });

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
  it("uses only the current owner Activities frame to read the existing usage resource", async () => {
    vi.spyOn(container, "clientWidth", "get").mockReturnValue(400);
    vi.spyOn(container, "clientHeight", "get").mockReturnValue(720);
    vi.spyOn(container.ownerDocument, "visibilityState", "get").mockReturnValue("visible");
    const revoked = vi.fn(), changed = vi.fn();
    const snapshot = { status: "unavailable", asOf: null, timeZone: "Asia/Shanghai", sourceCoverage: null,
      prSourceCoverage: null, prCoverage: null, windows: null, trend: [] };
    const result = { appId: app.id, revision: 3, resource: "usage", snapshot };
    fixture.api.mockResolvedValue(result);
    const mount = mountMiniAppFrame({ container, document: usageDocument, state: usageState, onRevoked: revoked, onChanged: changed });
    const view = mount.iframe.contentWindow!;
    const posted = vi.spyOn(view, "postMessage");
    const request = { mausMiniApp: 1, type: "dashboard-read", id: "fixture-usage", selection: { resource: "usage" } };
    const initialize = (view: Window) => send(view, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
    try {
      send(view, request);
      expect(fixture.api).not.toHaveBeenCalled();
      initialize(view);
      send(window, request);
      send(view, { ...request, selection: { resource: "usage", expectedRevision: 3 } });
      send(view, { ...request, selection: { resource: "usage", appId: app.id } });
      send(view, { ...request, selection: { resource: "teams" } });
      expect(fixture.api).not.toHaveBeenCalled();
      send(view, request);
      await vi.waitFor(() => expect(posted).toHaveBeenCalledWith(
        { mausMiniApp: 1, type: "dashboard-result", id: request.id, result }, "*"));
      expect(fixture.api).toHaveBeenCalledWith("/api/mini-apps/app_demo/dashboard",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ resource: "usage", expectedRevision: 3 }) }));
      fixture.api.mockRejectedValueOnce(new ApiError("Outdated", 409));
      send(view, request);
      await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
      fixture.api.mockRejectedValueOnce(new ApiError("Denied", 403));
      send(view, request);
      await vi.waitFor(() => expect(revoked).toHaveBeenCalledOnce());

      mount.update({ ...usageState, appId: "another" });
      send(view, request);
      mount.update({ ...usageState, revision: 4 });
      send(view, request);
      mount.update({ ...usageState, templateVersion: 2 });
      send(view, request);
      expect(fixture.api).toHaveBeenCalledTimes(3);
    } finally { mount.retire(); }

    for (const denied of [document, teamDocument, { ...usageDocument, app: { ...usageDocument.app, dashboard: null } },
      { ...usageDocument, bindings: document.bindings }]) {
      const wrong = mountMiniAppFrame({ container, document: denied, state: usageState, onRevoked: vi.fn() });
      initialize(wrong.iframe.contentWindow!);
      send(wrong.iframe.contentWindow!, request);
      wrong.retire();
    }
    expect(fixture.api).toHaveBeenCalledTimes(3);
  });

  it("cancels a pending Activities read when the owner window hides and never replies with that snapshot", async () => {
    vi.spyOn(container, "clientWidth", "get").mockReturnValue(400);
    vi.spyOn(container, "clientHeight", "get").mockReturnValue(720);
    const visibility = vi.spyOn(container.ownerDocument, "visibilityState", "get").mockReturnValue("visible");
    let resolve!: (value: unknown) => void;
    fixture.api.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const mount = mountMiniAppFrame({ container, document: usageDocument, state: usageState, onRevoked: vi.fn() });
    const view = mount.iframe.contentWindow!;
    const posted = vi.spyOn(view, "postMessage");
    try {
      send(view, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
      send(view, { mausMiniApp: 1, type: "dashboard-read", id: "pending", selection: { resource: "usage" } });
      const signal = fixture.api.mock.calls[0]?.[1].signal as AbortSignal;
      visibility.mockReturnValue("hidden");
      container.ownerDocument.dispatchEvent(new Event("visibilitychange"));
      expect(signal.aborted).toBe(true);
      resolve({ appId: app.id, revision: 3, resource: "usage", snapshot: { status: "ready" } });
      await Promise.resolve();
      expect(posted).toHaveBeenCalledWith(
        { mausMiniApp: 1, type: "dashboard-result", id: "pending", error: "This Activities frame is hidden." }, "*");
      expect(posted.mock.calls.some(([message]) => (message as { id?: string; result?: unknown }).id === "pending"
        && (message as { result?: unknown }).result)).toBe(false);
      send(view, { mausMiniApp: 1, type: "dashboard-read", id: "hidden", selection: { resource: "usage" } });
      expect(fixture.api).toHaveBeenCalledTimes(1);
    } finally { mount.retire(); }
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
    expect(miniAppFrameDocument(teamDocument, true).can.openLinks).toBe(true);
    expect(miniAppFrameDocument(teamDocument, false).can.openLinks).toBe(false);
    expect(miniAppFrameDocument({ ...teamDocument, app: { ...teamDocument.app, status: "archived" } }, true).can.openLinks).toBe(false);
    expect(miniAppFrameDocument({ ...teamDocument, app: { ...teamDocument.app, dashboardIdentity: null } }, true).can.openLinks).toBe(false);
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

  it("exposes selection sync and readMedia only on the eligible github-activity app and revokes blob URLs on teardown", async () => {
    const githubApp = {
      ...app,
      id: "0643df6c-24ea-4076-87b6-572d3637a4d9",
      slug: "github-activity",
      shippedTemplateKind: "github_activity" as const,
    };
    const githubDoc: MiniAppDocument = { ...document, app: githubApp };

    // 1. Non-github-activity app does NOT receive setSelection / onSelectionChanged / readMedia.
    const plainChild = new HappyWindow({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
    const plainSent: Array<Record<string, unknown>> = [];
    Object.defineProperty(plainChild, "parent", { value: { postMessage: (m: Record<string, unknown>) => plainSent.push(m) } });
    plainChild.eval(/<script>([\s\S]*?)<\/script>/.exec(miniAppFrameDocument(document, false).srcdoc)![1]!);
    const plainSdk = (plainChild as unknown as { mausApp: Record<string, unknown> }).mausApp;
    expect(plainSdk.setSelection).toBeUndefined();
    expect(plainSdk.onSelectionChanged).toBeUndefined();
    expect(plainSdk.readMedia).toBeUndefined();
    await plainChild.happyDOM.abort();

    // 2. Eligible github-activity app receives SDK methods, handles host-selection, and creates/revokes blob URLs.
    const ghChild = new HappyWindow({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
    const ghSent: Array<Record<string, unknown>> = [];
    const ghParent = { postMessage: (m: Record<string, unknown>) => ghSent.push(m) };
    Object.defineProperty(ghChild, "parent", { value: ghParent });
    const createObjUrl = vi.spyOn(ghChild.URL, "createObjectURL").mockReturnValue("blob:null/gh-media-1");
    const revokeObjUrl = vi.spyOn(ghChild.URL, "revokeObjectURL").mockImplementation(() => {});
    ghChild.eval(/<script>([\s\S]*?)<\/script>/.exec(miniAppFrameDocument(githubDoc, true).srcdoc)![1]!);
    const init = ghSent.find((m) => m.method === "ui/initialize")!;
    ghChild.dispatchEvent(new ghChild.MessageEvent("message", { source: ghParent as unknown as HappyWindow,
      data: { jsonrpc: "2.0", id: init.id, result: { hostCapabilities: { openLinks: {} } } } }));
    await Promise.resolve();
    const ghSdk = (ghChild as unknown as {
      mausApp: {
        setSelection(s: { editionKey: string | null; repo: string | null }): Promise<void>;
        onSelectionChanged(fn: (s: { editionKey: string | null; repo: string | null }) => void): () => void;
        readMedia(input: { url: string; sha256: string }): Promise<{ blobUrl: string; mimeType: string; sha256: string }>;
      };
    }).mausApp;
    const seenSelections: Array<{ editionKey: string | null; repo: string | null }> = [];
    ghSdk.onSelectionChanged((sel) => seenSelections.push(sel));
    ghChild.dispatchEvent(new ghChild.MessageEvent("message", { source: ghParent as unknown as HappyWindow,
      data: { mausMiniApp: 1, type: "host-selection", editionKey: "2026-11-20", repo: "dream-num/univer" } }));
    expect(seenSelections).toEqual([{ editionKey: "2026-11-20", repo: "dream-num/univer" }]);
    await ghSdk.setSelection({ editionKey: "2026-11-21", repo: "vuejs/core" });
    expect(ghSent.some((m) => m.type === "selection" && m.editionKey === "2026-11-21" && m.repo === "vuejs/core")).toBe(true);

    const mediaPromise = ghSdk.readMedia({ url: "https://mxhan.com/github/media/20261120/demo.png", sha256: "b".repeat(64) });
    await vi.waitFor(() => expect(ghSent.some((m) => m.type === "media-read")).toBe(true));
    const mediaReq = ghSent.find((m) => m.type === "media-read")!;
    const mediaBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    ghChild.dispatchEvent(new ghChild.MessageEvent("message", { source: ghParent as unknown as HappyWindow,
      data: { mausMiniApp: 1, type: "media-result", id: mediaReq.id, mimeType: "image/png", bytes: mediaBytes, sha256: "b".repeat(64) } }));
    await expect(mediaPromise).resolves.toEqual({ blobUrl: "blob:null/gh-media-1", mimeType: "image/png", sha256: "b".repeat(64) });
    expect(createObjUrl).toHaveBeenCalledTimes(1);
    ghChild.dispatchEvent(new ghChild.Event("pagehide"));
    expect(revokeObjUrl).toHaveBeenCalledWith("blob:null/gh-media-1");
    await ghChild.happyDOM.abort();

    // 3. Host mount relays media-read through /github-activity/media and syncs selection bidirectionally.
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(pngBytes, {
      status: 200,
      headers: { "content-type": "image/png" },
    }));
    const onSelectionChange = vi.fn();
    const mount = mountMiniAppFrame({
      container,
      document: githubDoc,
      state: { ...state, appId: githubApp.id },
      onRevoked: vi.fn(),
      githubSelection: { editionKey: "2026-11-20", repo: "dream-num/univer" },
      onGithubSelectionChange: onSelectionChange,
    });
    const view = mount.iframe.contentWindow!;
    const posted = vi.spyOn(view, "postMessage");
    send(view, { jsonrpc: "2.0", id: "init-gh", method: "ui/initialize", params: {} });
    send(view, { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    expect(posted.mock.calls.some(([msg]) => (msg as { type?: string }).type === "host-selection"
      && (msg as { repo?: string }).repo === "dream-num/univer")).toBe(true);
    send(view, { mausMiniApp: 1, type: "selection", editionKey: "2026-11-20", repo: "anomalyco/opencode" });
    expect(onSelectionChange).toHaveBeenCalledWith({ editionKey: "2026-11-20", repo: "anomalyco/opencode" });
    send(view, { mausMiniApp: 1, type: "media-read", id: "m1", url: "https://mxhan.com/github/media/20261120/demo.png", sha256: "c".repeat(64) });
    await vi.waitFor(() => expect(posted.mock.calls.some(([msg]) => (msg as { id?: string }).id === "m1")).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/mini-apps/${githubApp.id}/github-activity/media?expectedRevision=3&url=https%3A%2F%2Fmxhan.com%2Fgithub%2Fmedia%2F20261120%2Fdemo.png&sha256=${"c".repeat(64)}`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(posted.mock.calls.find(([msg]) => (msg as { id?: string }).id === "m1")?.[0]).toMatchObject({
      mausMiniApp: 1, type: "media-result", id: "m1", mimeType: "image/png", sha256: "c".repeat(64),
    });
    mount.retire();
  });

  it("fails only the individual media-read on media policy 403 while still invoking onRevoked for real revocation 401/403", async () => {
    const githubDoc: MiniAppDocument = {
      ...document,
      app: {
        ...app,
        id: "0643df6c-24ea-4076-87b6-572d3637a4d9",
        slug: "github-activity",
        shippedTemplateKind: "github_activity" as const,
      },
    };
    const ghState: MiniAppState = { ...state, appId: githubDoc.app.id };
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    const onRevoked = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "Redirected GitHub Activity media address is not allowed.",
        code: "github_media_policy_denied",
      }), { status: 403, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(pngBytes, { status: 200, headers: { "content-type": "image/png" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "This Mini App has no GitHub Activity media grant.",
      }), { status: 403, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      }));

    const mount = mountMiniAppFrame({ container, document: githubDoc, state: ghState, onRevoked });
    const view = mount.iframe.contentWindow!;
    const posted = vi.spyOn(view, "postMessage");

    // 1. Media/DNS/redirect policy 403 fails only that single media-read and preserves frame + retry.
    send(view, { mausMiniApp: 1, type: "media-read", id: "policy-403", url: "https://mxhan.com/github/media/20261120/blocked.png", sha256: "a".repeat(64) });
    await vi.waitFor(() => expect(posted.mock.calls.some(([msg]) => (msg as { id?: string }).id === "policy-403")).toBe(true));
    expect(onRevoked).not.toHaveBeenCalled();
    expect(posted.mock.calls.find(([msg]) => (msg as { id?: string }).id === "policy-403")?.[0]).toMatchObject({
      mausMiniApp: 1, type: "media-result", id: "policy-403", error: "Redirected GitHub Activity media address is not allowed.",
    });

    // Per-item retry and subsequent reads still succeed.
    send(view, { mausMiniApp: 1, type: "media-read", id: "retry-ok", url: "https://mxhan.com/github/media/20261120/ok.png", sha256: "b".repeat(64) });
    await vi.waitFor(() => expect(posted.mock.calls.some(([msg]) => (msg as { id?: string }).id === "retry-ok")).toBe(true));
    expect(onRevoked).not.toHaveBeenCalled();
    expect(posted.mock.calls.find(([msg]) => (msg as { id?: string }).id === "retry-ok")?.[0]).toMatchObject({
      mausMiniApp: 1, type: "media-result", id: "retry-ok", mimeType: "image/png", sha256: "b".repeat(64),
    });

    // 2. Owner/App revocation 403 (no policy code) triggers onRevoked().
    send(view, { mausMiniApp: 1, type: "media-read", id: "revoked-403", url: "https://mxhan.com/github/media/20261120/revoked.png", sha256: "c".repeat(64) });
    await vi.waitFor(() => expect(posted.mock.calls.some(([msg]) => (msg as { id?: string }).id === "revoked-403")).toBe(true));
    expect(onRevoked).toHaveBeenCalledTimes(1);

    // 3. Auth 401 triggers onRevoked().
    send(view, { mausMiniApp: 1, type: "media-read", id: "auth-401", url: "https://mxhan.com/github/media/20261120/auth.png", sha256: "d".repeat(64) });
    await vi.waitFor(() => expect(posted.mock.calls.some(([msg]) => (msg as { id?: string }).id === "auth-401")).toBe(true));
    expect(onRevoked).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    mount.retire();
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

  it("binds a packaged Mojo site to the current opaque frame and retires it on revision loss", () => {
    const release = { packageId: "mashellhan.mojo", requires: ["mojo-poetry-v1"], appVersion: "1.0.0",
      sourceCommit: "a".repeat(40), tag: "mini-app/mojo/v1.0.0", htmlSha256: "b".repeat(64), htmlBytes: 12,
      queriesSha256: "c".repeat(64), queriesBytes: 2 };
    const packaged: MiniAppDocument = { ...document, app: { ...app, shippedTemplateKind: "mojo", release }, bindings: [] };
    const current = { ...state, data: [] };
    const onSiteView = vi.fn();
    const mount = mountMiniAppFrame({ container, document: packaged, state: current, onRevoked: vi.fn(), site: "mojo-poetry", onSiteView });
    try {
      Object.defineProperties(mount.iframe, { clientWidth: { value: 360 }, clientHeight: { value: 500 } });
      const source = mount.iframe.contentWindow!;
      const post = (data: unknown, origin = "null") => window.dispatchEvent(new MessageEvent("message", { source, origin, data }));
      const viewport = { x: 0, y: 30, width: 360, height: 440 };
      const show = { mausMiniApp: 1, type: "site-show", id: "mini:2", site: "mojo-poetry", viewport };
      post(show);
      post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
      post(show, "https://example.test");
      expect(onSiteView).not.toHaveBeenCalled();
      post(show);
      expect(onSiteView).toHaveBeenLastCalledWith({ site: "mojo-poetry", viewport });
      mount.update({ ...current, revision: current.revision + 1 });
      expect(onSiteView).toHaveBeenLastCalledWith(undefined);
      post(show);
      expect(onSiteView).toHaveBeenCalledTimes(2);
    } finally { mount.retire(); }
  });

  it("exposes window.mausApp.markReady only for active managed releases and validates runtime-ready messages", async () => {
    const release = {
      packageId: "mashellhan.demo",
      appVersion: "1.2.0",
      sourceCommit: "a".repeat(40),
      tag: "mini-app/demo/v1.2.0",
      requires: [],
      htmlSha256: "b".repeat(64),
      htmlBytes: 12,
      queriesSha256: "c".repeat(64),
      queriesBytes: 2,
    };
    const managedDoc = { ...document, app: { ...app, release } } as MiniAppDocument;

    // Unmanaged and archived docs do not expose markReady.
    for (const candidateDoc of [document, { ...managedDoc, app: { ...managedDoc.app, status: "archived" as const } }]) {
      const child = new HappyWindow({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
      Object.defineProperty(child, "parent", { value: { postMessage: () => {} } });
      child.eval(/<script>([\s\S]*?)<\/script>/.exec(miniAppFrameDocument(candidateDoc, false).srcdoc)![1]!);
      const sdk = (child as unknown as { mausApp: { markReady?: () => Promise<void> } }).mausApp;
      expect(sdk.markReady).toBeUndefined();
      await child.happyDOM.abort();
    }

    // Active managed doc exposes markReady, waits for initialized, and posts exact { mausMiniApp: 1, type: "runtime-ready" } once.
    const child = new HappyWindow({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
    const sent: Array<Record<string, unknown>> = [];
    const parent = { postMessage: (message: Record<string, unknown>) => sent.push(message) };
    Object.defineProperty(child, "parent", { value: parent });
    child.eval(/<script>([\s\S]*?)<\/script>/.exec(miniAppFrameDocument(managedDoc, false).srcdoc)![1]!);
    const sdk = (child as unknown as { mausApp: { markReady?: () => Promise<void> } }).mausApp;
    expect(typeof sdk.markReady).toBe("function");
    const firstMark = sdk.markReady!();
    const secondMark = sdk.markReady!();
    expect(sent.some((m) => m.type === "runtime-ready")).toBe(false);
    const init = sent.find((m) => m.method === "ui/initialize")!;
    child.dispatchEvent(new child.MessageEvent("message", { source: parent as unknown as HappyWindow,
      data: { jsonrpc: "2.0", id: init.id, result: { hostCapabilities: {} } } }));
    await Promise.all([firstMark, secondMark]);
    const readyIdx = sent.findIndex((m) => m.type === "runtime-ready");
    const initializedIdx = sent.findIndex((m) => m.method === "ui/notifications/initialized");
    expect(initializedIdx).toBeGreaterThanOrEqual(0);
    expect(readyIdx).toBeGreaterThan(initializedIdx);
    expect(sent.filter((m) => m.type === "runtime-ready")).toEqual([{ mausMiniApp: 1, type: "runtime-ready" }]);
    await child.happyDOM.abort();

    // Receiver binds to current frame WindowProxy, opaque origin "null", exact shape, initialized, and matching appId/revision/templateVersion.
    const onRuntimeReady = vi.fn();
    const unmanagedReady = vi.fn();
    const unmanagedMount = mountMiniAppFrame({ container, document, state, onRevoked: vi.fn(), onRuntimeReady: unmanagedReady });
    window.dispatchEvent(new MessageEvent("message", {
      source: unmanagedMount.iframe.contentWindow!,
      origin: "null",
      data: { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} },
    }));
    window.dispatchEvent(new MessageEvent("message", {
      source: unmanagedMount.iframe.contentWindow!,
      origin: "null",
      data: { mausMiniApp: 1, type: "runtime-ready" },
    }));
    expect(unmanagedReady).not.toHaveBeenCalled();
    unmanagedMount.retire();

    const mount = mountMiniAppFrame({ container, document: managedDoc, state, onRevoked: vi.fn(), onRuntimeReady });
    const view = mount.iframe.contentWindow!;
    // Reject before initialized, wrong source, non-opaque origin, and extra keys.
    window.dispatchEvent(new MessageEvent("message", { source: view, origin: "null", data: { mausMiniApp: 1, type: "runtime-ready" } }));
    window.dispatchEvent(new MessageEvent("message", { source: view, origin: "null", data: { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} } }));
    window.dispatchEvent(new MessageEvent("message", { source: window, origin: "null", data: { mausMiniApp: 1, type: "runtime-ready" } }));
    window.dispatchEvent(new MessageEvent("message", { source: view, origin: "https://example.com", data: { mausMiniApp: 1, type: "runtime-ready" } }));
    window.dispatchEvent(new MessageEvent("message", { source: view, origin: "null", data: { mausMiniApp: 1, type: "runtime-ready", extra: true } }));
    expect(onRuntimeReady).not.toHaveBeenCalled();

    // Reject if state revision diverged before readiness arrived.
    mount.update({ ...state, revision: 99 });
    window.dispatchEvent(new MessageEvent("message", { source: view, origin: "null", data: { mausMiniApp: 1, type: "runtime-ready" } }));
    expect(onRuntimeReady).not.toHaveBeenCalled();
    mount.retire();

    // Valid runtime-ready fires once with exact appId, revision, templateVersion, even after data-only or synchronized revision bumps.
    const validMount = mountMiniAppFrame({ container, document: managedDoc, state, onRevoked: vi.fn(), onRuntimeReady });
    const validView = validMount.iframe.contentWindow!;
    validMount.update({ ...state, data: [{ datasetId: "dataset_demo", revision: 8 }] });
    validMount.update(
      { ...state, revision: 4, data: [{ datasetId: "dataset_demo", revision: 8 }] },
      { ...managedDoc, app: { ...managedDoc.app, revision: 4 } },
    );
    window.dispatchEvent(new MessageEvent("message", { source: validView, origin: "null", data: { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} } }));
    window.dispatchEvent(new MessageEvent("message", { source: validView, origin: "null", data: { mausMiniApp: 1, type: "runtime-ready" } }));
    window.dispatchEvent(new MessageEvent("message", { source: validView, origin: "null", data: { mausMiniApp: 1, type: "runtime-ready" } }));
    expect(onRuntimeReady).toHaveBeenCalledTimes(1);
    expect(onRuntimeReady).toHaveBeenCalledWith({ appId: app.id, revision: 4, templateVersion: state.templateVersion });
    validMount.retire();
  });
});
