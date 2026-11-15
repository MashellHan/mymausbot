// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { modelColor } from "@/lib/model-color";
import { setLocale } from "@/lib/i18n";
import { SettingsLook } from "./SettingsPrimitives";

const calls = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  return { ...actual, api: calls.api, useStore: () => ({ state: actual.initialState, dispatch: vi.fn() }) };
});
vi.mock("@/lib/live-events", () => ({ listenLiveFrames: () => () => {} }));
vi.mock("./PlanUsage", () => ({ PlanUsage: () => null }));
vi.mock("./UsageBudget", () => ({ UsageBudgetCards: () => null }));

const { GroupBars, UsageSection } = await import("./UsageSection");

const group = (key: string, label: string, input: number) => ({
  key, label, turns: 1, input, output: 0, cachedInput: 0, costUsd: null,
});

describe("model colours in the usage breakdown", () => {
  it("paints each model's dot and bar with the tone its provider keeps", () => {
    const models = [
      group("model:codex/gpt-6.1-sol", "gpt-6.1-sol", 1_000),
      group("model:codex/gpt-6-luna", "gpt-6-luna", 800),
      group("model:opencodeGo/opencode-go/deepseek-v4.1-flash", "deepseek-v4.1-flash", 600),
    ];
    const html = renderToStaticMarkup(createElement(GroupBars, { groupBy: "model", groups: models }));
    const painted = [...html.matchAll(/data-model-color="(#[0-9a-f]{6})"/gi)].map((match) => match[1]!);
    expect(painted).toHaveLength(6);
    const unique = [...new Set(painted)];
    expect(unique).toHaveLength(3);
    for (const model of models) expect(unique).toContain(modelColor(model.key));
  });

  it("leaves the other groupings on the app's accent colour", () => {
    const html = renderToStaticMarkup(createElement(GroupBars, { groupBy: "bot", groups: [group("bot:b1", "Scout", 1_000)] }));
    expect(html).not.toContain("data-model-color");
    expect(html).toContain("bg-accent/70");
  });

  it("requests model segments for the actual Usage bars and names their legend", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    setLocale("en");
    const models = [
      group("model:codex/gpt-6.1-sol", "gpt-6.1-sol", 700),
      group("model:opencodeGo/opencode-go/deepseek-v4.1-flash", "deepseek-v4.1-flash", 300),
    ];
    calls.api.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/usage/traces?")) return { roots: [], totals: { costUsd: 0, errors: 0, durationMs: 0 } };
      const by = new URL(path, "http://localhost").searchParams.get("groupBy");
      return { groupBy: by, groups: by === "bot" ? [{ ...group("bot:b1", "Scout", 1_000), segments: models }] : models };
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(UsageSection)));
      expect(calls.api).toHaveBeenCalledWith(expect.stringContaining("groupBy=bot&splitBy=model"));
      expect(calls.api).toHaveBeenCalledWith(expect.stringContaining("groupBy=model"));
      expect(host.querySelector<HTMLElement>('[title*="gpt-6.1-sol"][title*="70%"]')).not.toBeNull();
      expect(host.textContent).toContain("deepseek-v4.1-flash");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      calls.api.mockReset();
      vi.unstubAllGlobals();
    }
  });

  it("colors model rows in the actual Settings Usage route while leaving bot rows neutral", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    setLocale("en");
    const models = [
      group("model:codex/gpt-6.1-sol", "gpt-6.1-sol", 1_000),
      group("model:codex/gpt-6-luna", "gpt-6-luna", 800),
    ];
    calls.api.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/usage/traces?")) return { roots: [], totals: { costUsd: 0, errors: 0, durationMs: 0 } };
      if (!path.startsWith("/api/usage?")) throw new Error(`Unexpected API request: ${path}`);
      const by = new URL(path, "http://localhost").searchParams.get("groupBy");
      return { groupBy: by, groups: by === "model" ? models : [group("bot:b1", "Scout", 500)] };
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(SettingsLook.Provider, { value: true }, createElement(UsageSection))));
      const where = host.querySelector<HTMLElement>('[data-settings-block="where"]')!;
      const rows = () => [...where.querySelectorAll<HTMLElement>("[data-setting-row]")];
      expect(rows()).toHaveLength(1);
      expect(rows()[0]!.textContent).toContain("Scout");
      expect(rows()[0]!.querySelector("[data-model-color]")).toBeNull();
      const select = where.querySelector<HTMLSelectElement>("select")!;
      await act(async () => { select.value = "model"; select.dispatchEvent(new Event("change", { bubbles: true })); });
      expect(rows()).toHaveLength(2);
      expect(calls.api).toHaveBeenCalledWith(expect.stringContaining("groupBy=model"));
      for (const [index, model] of models.entries()) {
        const row = rows()[index]!;
        expect(row.textContent).toContain(model.label);
        expect(row.querySelector("[data-settings-slot]")).toBeNull();
        const shade = row.querySelector<HTMLElement>("[data-model-color]")!;
        expect(shade.getAttribute("data-model-color")).toBe(modelColor(model.key));
        expect(shade.style.backgroundColor).toBe(modelColor(model.key));
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
      calls.api.mockReset();
      vi.unstubAllGlobals();
    }
  });
});
