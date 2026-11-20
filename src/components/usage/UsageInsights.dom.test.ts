// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { api, ApiError } from "@/state/store";
import type { InsightEntry, UsageInsights } from "../../../shared/usage-insights";
import { UsageInsightsPanel } from "./UsageInsights";

vi.mock("@/state/store", async () => ({
  api: vi.fn(),
  ApiError: (await import("@/state/api")).ApiError,
  useStore: () => ({ state: { bots: [], instances: [] } }),
}));

const range = { from: "2026-11-18", to: "2026-11-19", timeZone: "UTC" };

function insights(costUsd: number | null): UsageInsights {
  const counts = { input: 10, cachedInput: 0, output: 5, reasoning: 0, turns: 1, errors: 0, durationMs: 0, timedTurns: 0 };
  const unpriced = costUsd === null ? 1 : 0;
  const model: InsightEntry = { ...counts, costUsd, key: "model:pi/test-model", label: "Fixture model" };
  const totals = { ...counts, costUsd, unpriced, tools: 0, activeDays: 1, days: 2 };
  return {
    ...range, unit: "day", totals, previous: { ...totals, costUsd: 1, unpriced: 0 },
    buckets: [{ ...counts, start: range.to, costUsd: costUsd ?? 0, unpriced, models: { [model.key]: 15 }, modelCosts: { [model.key]: costUsd ?? 0 } }],
    hours: Array.from({ length: 7 }, () => Array<number>(24).fill(0)),
    models: [model], bots: [], engines: [], people: [], routines: [], departments: [],
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(version: number) {
  await act(async () => root.render(createElement(UsageInsightsPanel, { range, version, metric: "cost", groupLabel: (_group, entry) => entry.label, card: "" })));
}

it.each([
  { costUsd: null, display: "—", comparison: "Nothing to compare with" },
  { costUsd: 0, display: "$0", comparison: "100%" },
])("preserves $costUsd in the spend comparison and breakdown", async ({ costUsd, display, comparison }) => {
  vi.mocked(api).mockResolvedValueOnce(insights(costUsd));
  await render(0);

  const hero = host.querySelector('[data-testid="insight-hero"]');
  expect(hero?.children[1]?.textContent).toBe(display);
  expect(hero?.children[3]?.textContent).toContain(comparison);
  expect(host.querySelector('[aria-label="Providers"] li')?.firstElementChild?.lastElementChild?.textContent).toBe(display);
  const breakdown = host.querySelector('[data-testid="insight-breakdown"]');
  const amount = () => breakdown?.querySelector('[role="row"]:last-child [role="cell"]:last-child')?.textContent;
  expect(amount()).toBe(display);

  const group = host.querySelector<HTMLSelectElement>('select[aria-label="Group by"]')!;
  await act(async () => { group.value = "time"; group.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(breakdown?.textContent).toContain("Nov 19");
  expect(amount()).toBe(display);
});

it.each([401, 403])("retains insights on a transient refresh failure and clears them on HTTP %i", async (status) => {
  vi.mocked(api).mockResolvedValueOnce(insights(1))
    .mockRejectedValueOnce(new ApiError("temporarily unavailable", 503))
    .mockRejectedValueOnce(new ApiError("refused", status));
  await render(0);
  expect(host.querySelector('[data-testid="usage-insights"]')?.textContent).toContain("Fixture model");

  await render(1);
  expect(host.querySelector('[data-testid="usage-insights"]')?.textContent).toContain("Fixture model");

  await render(2);
  expect(host.querySelector('[data-testid="usage-insights"]')?.isConnected ?? false).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("refused");
});
