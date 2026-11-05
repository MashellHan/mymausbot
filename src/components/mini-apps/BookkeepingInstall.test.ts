// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadLocale, setLocale } from "@/lib/i18n";
import type { MiniAppDataset } from "../../../shared/mini-apps";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api }));
import { BookkeepingInstall } from "./BookkeepingInstall";

const columns = ["category", "date", "amount", "account", "book", "currency", "note"].map((name) => ({ name, type: "VARCHAR" }));
const dataset = (id: string): MiniAppDataset => ({ datasetId: id, revision: 7,
  tables: [{ schema: "main", name: `synthetic_${id}`, rowCount: 7, columns }] });
let host: HTMLDivElement;
let root: Root;
let installed = vi.fn<(appId: string) => void>();

const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!;
const select = (label: string) => [...host.querySelectorAll<HTMLLabelElement>("label")].find((item) => item.textContent?.startsWith(label))!.querySelector("select")!;
const choose = async (label: string, value: string) => {
  await act(async () => { const control = select(label); control.value = value; control.dispatchEvent(new Event("change", { bubbles: true })); });
};
const render = async () => {
  await act(async () => { root.render(createElement(BookkeepingInstall, { onCancel: vi.fn(), onInstalled: installed })); });
  await vi.waitFor(() => expect(host.querySelectorAll("select").length).toBeGreaterThan(0));
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ogb", { platform: "darwin", app: { version: "fixture", ownPage: true, blocksOpaqueFrameNavigation: true } });
  setLocale("en");
  installed = vi.fn<(appId: string) => void>();
  fixture.api.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/mini-apps/sources" && init?.method === "POST") return { dataset: dataset("retained") };
    if (path === "/api/mini-apps/sources") return { bots: [{ id: "bot_a", name: "Assistant A" }, { id: "bot_b", name: "Assistant B" }], datasets: [dataset("retained"), dataset("other")] };
    if (path === "/api/mini-apps" && init?.method === "POST") return { app: { id: "app_fixture" }, replayed: false };
    throw new Error(`Unexpected API path: ${path}`);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => { root.unmount(); host.remove(); vi.unstubAllGlobals(); setLocale("en"); });

it("keeps retained Data owner-only until an editing assistant is chosen", async () => {
  await render();
  expect(select("Editing assistant").value).toBe("");
  await choose("Editing assistant", "bot_b");
  await choose("Data source", "dataset:other");
  expect(select("Editing assistant").value).toBe("");
  await choose("Data source", "dataset:retained");
  expect(select("Editing assistant").value).toBe("bot_b");
  await act(async () => { button("Install portal").click(); });
  const call = fixture.api.mock.calls.find(([path, init]) => path === "/api/mini-apps" && init?.method === "POST");
  expect(call).toBeTruthy();
  const publish = JSON.parse(String(call![1].body));
  expect(publish.publisherBotIds).toEqual(["bot_b"]);
  expect(publish.bindings[0].source).toEqual({ schema: "main", table: "synthetic_retained" });
  expect(publish.bindings[0].fields.amount.column).toBe("amount");
  expect(publish.bindings[0].queries.category_options.measures).toEqual([{ name: "count", op: "count" }]);
  expect(publish.bindings[0].queries.category_options.filters).not.toContainEqual({ field: "amount", op: "lt", literal: "0" });
  expect(publish.bindings[0].queries.categories.filters).toContainEqual({ field: "amount", op: "lt", literal: "0" });
  expect(installed).toHaveBeenCalledWith("app_fixture");
});

it("preselects a connected source bot and localizes the published app metadata", async () => {
  await loadLocale("zh");
  await render();
  await choose("Data 数据源", "bot:bot_a");
  await act(async () => { button("连接 Data").click(); });
  await vi.waitFor(() => expect(select("可编辑助手").value).toBe("bot_a"));
  await act(async () => { button("安装视图").click(); });
  const call = fixture.api.mock.calls.find(([path, init]) => path === "/api/mini-apps" && init?.method === "POST");
  expect(call).toBeTruthy();
  const publish = JSON.parse(String(call![1].body));
  expect(publish.publisherBotIds).toEqual(["bot_a"]);
  expect(publish.title).toBe("记账");
  expect(publish.description).toContain("各货币单独呈现");
});
