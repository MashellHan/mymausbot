// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  api: vi.fn(), connected: false, owner: true, visible: true,
}));

vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { connected: fixture.connected } }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.owner }));
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => fixture.visible }));

import { MiniAppDefaultsBootstrap, ensureMiniAppDefaults } from "./MiniAppDefaultsBootstrap";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ogb", { app: { ownPage: true, blocksOpaqueFrameNavigation: true } });
  fixture.api.mockReset().mockResolvedValue({ apps: [], issues: [] });
  fixture.connected = false;
  fixture.owner = true;
  fixture.visible = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
});

it("initializes included apps from the connected native shell without mounting the Mini Apps tab", async () => {
  await act(async () => { root.render(createElement(MiniAppDefaultsBootstrap)); });
  expect(fixture.api).not.toHaveBeenCalled();

  fixture.connected = true;
  await act(async () => { root.render(createElement(MiniAppDefaultsBootstrap)); });
  await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledTimes(1));
  const [path, init] = fixture.api.mock.calls[0]!;
  expect(path).toBe("/api/mini-apps/defaults");
  expect(init.method).toBe("POST");
  const body = JSON.parse(init.body);
  expect(body).toEqual({ bookkeepingHtml: expect.any(String) });
  expect(body.bookkeepingHtml).toMatch(/^<!doctype html>/i);
  expect(host.querySelector('[data-testid="mini-apps-panel"]')).toBeNull();

  await act(async () => { root.render(createElement(MiniAppDefaultsBootstrap)); });
  expect(fixture.api).toHaveBeenCalledTimes(1);
});

it("keeps owner mutations behind the visible native connection guard", async () => {
  fixture.connected = true;
  fixture.owner = false;
  await act(async () => { root.render(createElement(MiniAppDefaultsBootstrap)); });
  fixture.owner = true;
  fixture.visible = false;
  await act(async () => { root.render(createElement(MiniAppDefaultsBootstrap)); });
  fixture.visible = true;
  vi.stubGlobal("ogb", { app: { ownPage: false, blocksOpaqueFrameNavigation: true } });
  await act(async () => { root.render(createElement(MiniAppDefaultsBootstrap)); });
  vi.stubGlobal("ogb", undefined);
  await act(async () => { root.render(createElement(MiniAppDefaultsBootstrap)); });
  expect(fixture.api).not.toHaveBeenCalled();
});

it("shares a pending owner request without a second publication", async () => {
  let resolve!: (value: { apps: []; issues: [] }) => void;
  fixture.api.mockReturnValue(new Promise((done) => { resolve = done; }));
  const first = ensureMiniAppDefaults();
  const second = ensureMiniAppDefaults();
  expect(second).toBe(first);
  expect(fixture.api).toHaveBeenCalledTimes(1);
  resolve({ apps: [], issues: [] });
  await first;
});
