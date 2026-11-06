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
function fixture(kind: ReportKind, initial?: { current: Row; editions: Array<{ header: Row; items: Row[] }> }) {
  const view = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  const data = { current: null as Row | null, editions: new Map<string, { header: Row; items: Row[] }>(), revision: 3, fail: false,
    historyCursor: false, deferredHistory: null as Promise<ReturnType<typeof page>> | null };
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
    if (id === "edition") return page(data.editions.get(parameters.editionKey)?.header ? [data.editions.get(parameters.editionKey)!.header] : [], data.revision);
    if (id === "items") return page(data.editions.get(parameters.editionKey)?.items ?? [], data.revision);
    throw new Error(`Unknown query ${id}`);
  });
  (view as unknown as { mausApp: unknown }).mausApp = { query, onDataChanged: (listener: () => void) => { changed = listener; return () => { changed = undefined; }; } };
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
  app.data.editions.set("2026-11-03", { header: older, items: [item({ title: "<img src=x>", sourceUrl: "https://example.org/older" })] });
  app.data.editions.set("2026-11-04", { header: latest, items: [item()] });
  app.changed();
  await app.view.happyDOM.whenAsyncComplete();
  const select = app.view.document.getElementById("edition") as unknown as HTMLSelectElement;
  select.value = "2026-11-03";
  select.dispatchEvent(new app.view.Event("change") as unknown as Event);
  await app.view.happyDOM.whenAsyncComplete();
  expect(app.text()).toContain("<img src=x>");
  expect(app.view.document.querySelector("#report img")).toBeNull();
  expect(app.text()).toContain("Source date unavailable");
  expect(app.text()).toContain("Issue date · China time");
  expect(app.text()).toContain("Report published at");
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
