// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MiniAppSourceTable } from "../../../shared/mini-apps";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api }));
import { SourceTablePreview } from "./SourceTablePreview";

const table: MiniAppSourceTable = { schema: "main", name: "synthetic_entries", rowCount: 25,
  columns: [{ name: "amount", type: "VARCHAR" }, { name: "date", type: "VARCHAR" }] };
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ogb", { platform: "darwin", app: { version: "fixture", ownPage: true, blocksOpaqueFrameNavigation: true } });
  fixture.api.mockReset().mockImplementation(async (_path: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { offset: number };
    return { columns: table.columns, rows: request.offset ? [["+5.00", "2026-04-05"]] : [["-12.34", "2026-04-04"]], rowCount: 25, offset: request.offset };
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => { root.unmount(); host.remove(); vi.unstubAllGlobals(); });

it("previews an owner-selected physical table through bounded read-only pages", async () => {
  await act(async () => { root.render(createElement(SourceTablePreview, { datasetId: "dataset_demo", table })); });
  expect(fixture.api).not.toHaveBeenCalled();
  await act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); });
  await vi.waitFor(() => expect(host.textContent).toContain("-12.34"));
  expect(fixture.api).toHaveBeenCalledWith("/api/mini-apps/sources/dataset_demo/page", expect.objectContaining({
    method: "POST", body: JSON.stringify({ schema: "main", table: "synthetic_entries", offset: 0, limit: 20 }),
  }));
  expect(host.querySelectorAll("input, textarea, [contenteditable]")).toHaveLength(0);
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Next rows"]')!.click(); });
  await vi.waitFor(() => expect(host.textContent).toContain("+5.00"));
  expect(fixture.api).toHaveBeenLastCalledWith("/api/mini-apps/sources/dataset_demo/page", expect.objectContaining({
    body: JSON.stringify({ schema: "main", table: "synthetic_entries", offset: 20, limit: 20 }),
  }));
});

it("does not ask for source rows outside the guarded desktop window", async () => {
  vi.stubGlobal("ogb", undefined);
  await act(async () => { root.render(createElement(SourceTablePreview, { datasetId: "dataset_demo", table })); });
  expect(host.textContent).toContain("Open the desktop app to view or install Mini Apps.");
  expect(fixture.api).not.toHaveBeenCalled();
});
