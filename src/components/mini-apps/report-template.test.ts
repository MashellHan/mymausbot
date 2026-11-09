import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createReportTemplate } from "../../../shared/report-mini-app-template";
import type { ReportKind } from "../../../shared/report-mini-app";

type Row = Record<string, string | number | null>;
const header = (key: string, extras: Partial<Row> = {}): Row => ({
  editionKey: key, editionDay: key, windowStartAt: "2026-11-04T00:00:00Z", windowEndAt: "2026-11-05T00:00:00Z",
  sourceAsOfAt: null, coverageStatus: "partial", coverageNote: "Some sources were not checked.", reportSummary: null,
  itemCount: 1, contentHash: "synthetic", publishedAt: "2026-11-05T02:00:00Z", ...extras,
});
const item = (extras: Partial<Row> = {}): Row => ({
  itemIndex: 1, category: "AI", title: "Synthetic headline", summary: "Selected report summary", whyItMatters: null,
  verificationNote: null, sourceLabel: "Synthetic source", sourceUrl: "https://example.org/item",
  sourcePublishedAt: null, attribution: "vendor", repoFullName: null, repoStars: null, repoForks: null,
  repoPushedAt: null, weeklyStarIncrease: null, signalSourceUrl: null, publicAdvisoryCount: null,
  publicAdvisoryAsOfAt: null, selectionBasis: null, ...extras,
});
function page(rows: Row[], revision: number) {
  return { columns: Object.keys(rows[0] ?? {}).map((name) => ({ name, type: "text" })), rows: rows.map(Object.values), revision };
}
function fixture(kind: ReportKind, initial?: { current: Row; editions: Array<{ header: Row; items: Row[] }> }, openSource?: (url: string) => Promise<void>) {
  const view = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  const data = { current: null as Row | null, editions: new Map<string, { header: Row; items: Row[] }>(), revision: 3, fail: false,
    historyCursor: false, deferredHistory: null as Promise<ReturnType<typeof page>> | null,
    deferredEdition: null as Promise<ReturnType<typeof page>> | null };
  if (initial) {
    data.current = initial.current;
    for (const edition of initial.editions) data.editions.set(String(edition.header.editionKey), edition);
  }
  let changed: (() => void) | undefined;
  const query = vi.fn(async (id: string, parameters: Record<string, string>, options?: { expectedDataRevision?: number; cursor?: string }) => {
    if (data.fail) throw new Error("Synthetic read failure");
    if (options?.expectedDataRevision !== undefined && options.expectedDataRevision !== data.revision) throw new Error("Data changed while this report was being read.");
    if (id === "current") return page(data.current ? [data.current] : [], data.revision);
    if (id === "history") {
      if (options?.cursor && data.deferredHistory) return data.deferredHistory;
      return { ...page([...data.editions.values()].map((entry) => entry.header).sort((a, b) => String(b.editionKey).localeCompare(String(a.editionKey))), data.revision),
        ...(data.historyCursor ? { nextCursor: "older" } : {}) };
    }
    if (id === "edition") return data.deferredEdition ?? page(data.editions.get(parameters.editionKey)?.header ? [data.editions.get(parameters.editionKey)!.header] : [], data.revision);
    if (id === "items") return page(data.editions.get(parameters.editionKey)?.items ?? [], data.revision);
    throw new Error(`Unknown query ${id}`);
  });
  (view as unknown as { mausApp: unknown }).mausApp = { query, onDataChanged: (listener: () => void) => { changed = listener; return () => { changed = undefined; }; },
    ...(openSource ? { openSource } : {}) };
  view.document.write(createReportTemplate(kind));
  return { view, data, query, changed: () => changed?.(), text: () => view.document.querySelector("main")?.textContent ?? "" };
}

const opened: Window[] = [];
afterEach(async () => { for (const view of opened.splice(0)) await view.happyDOM.abort(); });

it("creates a Node-safe bound template and shows an empty install without a fabricated edition", async () => {
  const app = fixture("x_ai_digest"); opened.push(app.view);
  await app.view.happyDOM.whenAsyncComplete();
  expect(app.text()).toContain("No report published yet");
  expect(app.query.mock.calls.map(([id]) => id)).toEqual(["current", "history"]);
  expect(app.view.document.querySelectorAll("a, iframe, form")).toHaveLength(0);
  const sourceStyle = createReportTemplate("x_ai_digest").match(/\.source-url\s*\{([^}]+)\}/)?.[1];
  expect(sourceStyle).toContain("--color-text-primary");
  expect(sourceStyle).toContain("user-select: text");
  expect(sourceStyle).not.toContain("--color-text-link");
});

it("opens Github Rending at its latest edition with dated history and no producer turn", async () => {
  const latest = header("2026-11-06");
  const older = header("2026-11-04");
  const app = fixture("github_activity", { current: latest, editions: [
    { header: latest, items: [item({ title: "Latest project" })] },
    { header: older, items: [item({ title: "Earlier project" })] },
  ] }); opened.push(app.view);
  await app.view.happyDOM.whenAsyncComplete();
  expect(app.view.document.getElementById("title")?.textContent).toBe("Github Rending");
  expect(app.text()).toContain("Latest project");
  expect(app.text()).not.toContain("Earlier project");
  const select = app.view.document.getElementById("edition") as unknown as HTMLSelectElement;
  expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([["current", "Current"], ["2026-11-04", "2026-11-04"]]);
  expect(app.query.mock.calls.map(([id]) => id)).toEqual(["current", "history", "items"]);
  select.value = "2026-11-04";
  select.dispatchEvent(new app.view.Event("change") as unknown as Event);
  await app.view.happyDOM.whenAsyncComplete();
  expect(app.text()).toContain("Earlier project");
  expect(app.query.mock.calls.map(([id]) => id)).toEqual(["current", "history", "items", "current", "history", "edition", "items"]);
});

it("keeps an earlier X edition selected across Data refresh and separates all date claims", async () => {
  const app = fixture("x_ai_digest"); opened.push(app.view);
  const older = header("2026-11-03", { reportSummary: null });
  const latest = header("2026-11-04", { sourceAsOfAt: "2026-11-05T00:00:00Z", reportSummary: "Only selected items." });
  app.data.current = latest;
  app.data.editions.set("2026-11-03", { header: older, items: [item({ title: "<img src=x>", sourceUrl: "https://example.org/older", selectionBasis: "Earlier X selection basis" })] });
  app.data.editions.set("2026-11-04", { header: latest, items: [item({ selectionBasis: "Latest X selection basis" })] });
  app.changed();
  await app.view.happyDOM.whenAsyncComplete();
  expect(app.view.document.getElementById("selected-detail")?.textContent).toContain("Latest X selection basis");
  const select = app.view.document.getElementById("edition") as unknown as HTMLSelectElement;
  select.value = "2026-11-03";
  select.dispatchEvent(new app.view.Event("change") as unknown as Event);
  await app.view.happyDOM.whenAsyncComplete();
  expect(app.text()).toContain("<img src=x>");
  expect(app.view.document.getElementById("selected-detail")?.textContent).toContain("Earlier X selection basis");
  expect(app.view.document.getElementById("selected-detail")?.textContent).not.toContain("Latest X selection basis");
  expect(app.view.document.querySelector("#report img")).toBeNull();
  expect(app.text()).toContain("Source date unavailable");
  expect(app.text()).toContain("Issue date");
  expect(app.text()).toContain("Report published");
  expect(app.text()).not.toContain("Only selected items.");
  expect(app.view.document.querySelectorAll("#report a")).toHaveLength(0);
  expect(app.view.document.querySelector(".source-url")?.textContent).toBe("https://example.org/older");
  app.data.current = header("2026-11-05");
  app.data.editions.set("2026-11-05", { header: app.data.current, items: [] });
  app.data.revision++;
  app.changed();
  await app.view.happyDOM.whenAsyncComplete();
  expect(select.value).toBe("2026-11-03");
  expect(app.text()).toContain("<img src=x>");
  expect(app.query).toHaveBeenCalledWith("edition", { editionKey: "2026-11-03" }, { expectedDataRevision: 4 });
});

it("keeps keyboard focus on the same report control after refresh and moves it to a valid fallback when removed", async () => {
  const current = header("2026-11-05");
  const first = item({ itemIndex: 1, title: "First story" });
  const second = item({ itemIndex: 2, title: "Second story" });
  const app = fixture("x_ai_digest", { current, editions: [{ header: current, items: [first, second] }] }, async () => {}); opened.push(app.view);
  await app.view.happyDOM.whenAsyncComplete();
  const originalIndex = app.view.document.querySelector('[data-report-index="2"]') as unknown as HTMLButtonElement;
  originalIndex.click();
  originalIndex.focus();
  expect(app.view.document.activeElement).toBe(originalIndex);
  app.data.revision++;
  app.changed();
  await app.view.happyDOM.whenAsyncComplete();
  const retainedIndex = app.view.document.querySelector('[data-report-index="2"]');
  expect(retainedIndex).not.toBe(originalIndex);
  expect(app.view.document.activeElement).toBe(retainedIndex);

  const originalAction = app.view.document.querySelector('[data-report-action="original"]') as unknown as HTMLButtonElement;
  originalAction.focus();
  app.data.revision++;
  app.changed();
  await app.view.happyDOM.whenAsyncComplete();
  expect(app.view.document.activeElement).not.toBe(originalAction);
  expect(app.view.document.activeElement?.getAttribute("data-report-action")).toBe("original");

  app.data.editions.set("2026-11-05", { header: current, items: [first] });
  app.data.revision++;
  app.changed();
  await app.view.happyDOM.whenAsyncComplete();
  expect(app.view.document.activeElement?.getAttribute("data-report-index")).toBe("1");
  app.data.current = null;
  app.data.editions.clear();
  app.data.revision++;
  app.changed();
  await app.view.happyDOM.whenAsyncComplete();
  expect(app.view.document.activeElement?.id).toBe("report");
});

it("keeps a recorded overview separate from the indexed selected story and its exact source date", async () => {
  const latest = header("2026-11-05", { reportSummary: "Two selected synthetic updates." });
  const app = fixture("x_ai_digest", { current: latest, editions: [{ header: latest, items: [
    item({ itemIndex: 1, title: "First update", summary: "First recorded summary", sourcePublishedAt: "2026-11-02",
      whyItMatters: "Recorded reason" }),
    item({ itemIndex: 2, title: "Second update", summary: "Second recorded summary", sourceUrl: "https://example.org/second",
      verificationNote: "Recorded verification" }),
  ] }] }); opened.push(app.view);
  await app.view.happyDOM.whenAsyncComplete();
  expect(app.view.document.querySelector(".overview-summary")?.textContent).toBe("Two selected synthetic updates.");
  const index = [...app.view.document.querySelectorAll("[data-report-index]")] as unknown as HTMLButtonElement[];
  expect(index).toHaveLength(2);
  expect(index[0]?.getAttribute("aria-pressed")).toBe("true");
  expect(app.view.document.getElementById("selected-detail")?.textContent).toContain("First recorded summary");
  expect(app.view.document.getElementById("selected-detail")?.textContent).toContain("Why it matters");
  expect(app.view.document.getElementById("selected-detail")?.textContent).toContain("2026-11-02");
  expect(app.view.document.getElementById("selected-detail")?.textContent).not.toContain("08:00");
  index[1]!.click();
  expect(index[1]?.getAttribute("aria-pressed")).toBe("true");
  expect(app.view.document.getElementById("selected-detail")?.textContent).toContain("Second recorded summary");
  expect(app.view.document.getElementById("selected-detail")?.textContent).not.toContain("First recorded summary");
  app.data.revision++;
  app.changed();
  await app.view.happyDOM.whenAsyncComplete();
  expect(app.view.document.querySelector('[data-report-index="2"]')?.getAttribute("aria-pressed")).toBe("true");
});

it("offers a real source action only with the guarded host method and never navigates an invalid URL", async () => {
  const latest = header("2026-11-05");
  const edition = { current: latest, editions: [{ header: latest, items: [item({ sourceUrl: "https://example.org/source" })] }] };
  const fallback = fixture("x_ai_digest", edition); opened.push(fallback.view);
  await fallback.view.happyDOM.whenAsyncComplete();
  expect(fallback.view.document.querySelector(".source-url")?.textContent).toBe("https://example.org/source");
  expect(fallback.view.document.querySelector(".source-action")).toBeNull();
  expect(fallback.view.document.querySelector("#report a")).toBeNull();

  const openSource = vi.fn(async (_url: string) => {});
  const active = fixture("x_ai_digest", edition, openSource); opened.push(active.view);
  await active.view.happyDOM.whenAsyncComplete();
  const action = active.view.document.querySelector(".source-action") as unknown as HTMLButtonElement | null;
  expect(action?.textContent).toBe("Open original source");
  action!.click();
  await active.view.happyDOM.whenAsyncComplete();
  expect(openSource).toHaveBeenCalledExactlyOnceWith("https://example.org/source");
  openSource.mockRejectedValueOnce(new Error("Synthetic host refusal"));
  action!.click();
  await active.view.happyDOM.whenAsyncComplete();
  expect(active.view.document.getElementById("notice")?.textContent).toContain("Source could not be opened");
  expect(active.view.document.querySelector(".source-url")?.textContent).toBe("https://example.org/source");

  active.data.editions.set("2026-11-05", { header: latest, items: [item({ sourceUrl: "javascript:alert(1)" })] });
  active.data.revision++;
  active.changed();
  await active.view.happyDOM.whenAsyncComplete();
  expect(active.view.document.querySelector(".source-action, .source-url")).toBeNull();
  expect(openSource).toHaveBeenCalledTimes(2);
});

it.each(["x_ai_digest", "github_activity"] as const)("keeps %s publication identity truthful while a historical read fails or disappears", async (kind) => {
  const app = fixture(kind); opened.push(app.view);
  const current = header("2026-11-05");
  const older = header("2026-11-04");
  app.data.current = current;
  app.data.editions.set("2026-11-05", { header: current, items: [item({ title: "Current publication" })] });
  app.data.editions.set("2026-11-04", { header: older, items: [item({ title: "Earlier publication" })] });
  app.changed();
  await app.view.happyDOM.whenAsyncComplete();

  let rejectEdition!: (error: Error) => void;
  app.data.deferredEdition = new Promise((_, reject) => { rejectEdition = reject; });
  const select = app.view.document.getElementById("edition") as unknown as HTMLSelectElement;
  select.value = "2026-11-04";
  select.dispatchEvent(new app.view.Event("change") as unknown as Event);
  expect(app.text()).toContain("Loading report");
  expect(app.text()).not.toContain("Current publication");
  rejectEdition(new Error("Synthetic read failure"));
  await app.view.happyDOM.whenAsyncComplete();
  expect(select.value).toBe("current");
  expect(app.text()).toContain("Current publication");
  expect(app.text()).toContain("Showing the last loaded edition");

  app.data.deferredEdition = null;
  app.data.editions.delete("2026-11-04");
  select.value = "2026-11-04";
  select.dispatchEvent(new app.view.Event("change") as unknown as Event);
  await app.view.happyDOM.whenAsyncComplete();
  expect(select.value).toBe("2026-11-04");
  expect(app.text()).toContain("This edition is unavailable");
  expect(app.text()).not.toContain("No report published yet");
  (app.view.document.getElementById("return-current") as unknown as HTMLButtonElement).click();
  await app.view.happyDOM.whenAsyncComplete();
  expect(select.value).toBe("current");
  expect(app.text()).toContain("Current publication");
});

it("labels GitHub signals precisely, hides absent facts and retains a stale edition", async () => {
  const app = fixture("github_activity"); opened.push(app.view);
  app.data.current = header("2026-11-04", { coverageStatus: "complete", coverageNote: null, itemCount: 1 });
  app.data.editions.set("2026-11-04", { header: app.data.current, items: [item({ category: "TypeScript", repoFullName: "sample/tool", repoStars: 12,
    repoPushedAt: "2026-11-04T13:00:00Z", weeklyStarIncrease: 5, publicAdvisoryCount: 0, publicAdvisoryAsOfAt: "2026-11-05T00:00:00Z" })] });
  app.changed();
  await app.view.happyDOM.whenAsyncComplete();
  expect(app.text()).toContain("Weekly Trending star increase");
  expect(app.text()).toContain("sample/tool");
  expect(app.text()).toContain("Last repository activity");
  expect(app.text()).toContain("This is not a safety audit.");
  expect(app.text()).not.toContain("Why it matters");
  app.data.fail = true;
  app.changed();
  await app.view.happyDOM.whenAsyncComplete();
  expect(app.text()).toContain("Showing the last loaded edition");
  expect(app.text()).toContain("Weekly Trending star increase");
});

it("discards stale history paging and drains a queued edition and Data refresh", async () => {
  const app = fixture("x_ai_digest"); opened.push(app.view);
  const latest = header("2026-11-04");
  const older = header("2026-11-03");
  app.data.current = latest;
  app.data.editions.set("2026-11-04", { header: latest, items: [item({ title: "Latest edition" })] });
  app.data.editions.set("2026-11-03", { header: older, items: [item({ title: "Earlier edition" })] });
  app.data.historyCursor = true;
  app.changed();
  await app.view.happyDOM.whenAsyncComplete();
  let release!: (value: ReturnType<typeof page>) => void;
  app.data.deferredHistory = new Promise((resolve) => { release = resolve; });
  (app.view.document.getElementById("more") as unknown as HTMLButtonElement).click();
  const select = app.view.document.getElementById("edition") as unknown as HTMLSelectElement;
  select.value = "2026-11-03";
  select.dispatchEvent(new app.view.Event("change") as unknown as Event);
  const newHead = header("2026-11-05");
  app.data.current = newHead;
  app.data.editions.set("2026-11-05", { header: newHead, items: [item({ title: "New edition" })] });
  app.data.revision = 4;
  app.changed();
  release(page([header("2026-10-01")], 3));
  await app.view.happyDOM.whenAsyncComplete();
  expect(select.value).toBe("2026-11-03");
  expect(app.text()).toContain("Earlier edition");
  expect(app.text()).not.toContain("New edition");
  expect([...select.options].map((option) => option.value)).not.toContain("2026-10-01");
  expect(app.query).toHaveBeenCalledWith("edition", { editionKey: "2026-11-03" }, { expectedDataRevision: 4 });
  expect(app.view.document.getElementById("notice")?.getAttribute("hidden")).toBe("");
});

it("keeps a known coverage bound and does not call an unknown empty edition partial", async () => {
  const app = fixture("github_activity"); opened.push(app.view);
  const edition = header("2026-11-04", { windowEndAt: null, coverageStatus: "unknown", coverageNote: "Collection was not verified.", itemCount: 0 });
  app.data.current = edition;
  app.data.editions.set("2026-11-04", { header: edition, items: [] });
  app.changed();
  await app.view.happyDOM.whenAsyncComplete();
  expect(app.text()).toContain("Nov 4, 2026");
  expect(app.text()).toContain("Date unavailable");
  expect(app.text()).toContain("No verified items are available for this edition.");
  expect(app.text()).not.toContain("this partial edition");
});
