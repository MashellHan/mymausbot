import type { ReportKind } from "./report-mini-app.ts";

const HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Report</title>
  <style>
    :root { color-scheme: light dark; font: 13px/1.5 var(--font-sans, system-ui, sans-serif); background: var(--color-background-primary, light-dark(#fff, #1c1c1f)); color: var(--color-text-primary, light-dark(#1d1d1f, #ececee)); }
    * { box-sizing: border-box; }
    body { margin: 0; }
    button, select { font: inherit; color: inherit; }
    button { cursor: pointer; }
    button:disabled { cursor: default; opacity: .5; }
    button:focus-visible, select:focus-visible { outline: 2px solid var(--color-ring-primary, #1084fe); outline-offset: 2px; }
    ::selection { background: var(--color-background-info, #dceeff); color: var(--color-text-primary, #1d1d1f); }
    main { max-width: 860px; min-height: 100%; margin: 0 auto; padding: 18px 20px 32px; }
    h1 { margin: 0; font-size: 19px; line-height: 1.25; font-weight: 650; letter-spacing: -.02em; }
    h2 { margin: 0; font-size: 15px; line-height: 1.3; font-weight: 620; }
    h3 { margin: 0; font-size: 14px; line-height: 1.4; font-weight: 620; overflow-wrap: anywhere; }
    p { margin: 0; }
    .muted { color: var(--color-text-secondary, light-dark(#5f5f66, #a9a9b2)); }
    .head { display: flex; flex-wrap: wrap; align-items: start; justify-content: space-between; gap: 8px 16px; }
    .purpose { margin-top: 5px; }
    .button { border: 1px solid var(--color-border-primary, light-dark(#d8d8de, #3a3a40)); border-radius: 8px; background: var(--color-background-secondary, light-dark(#f4f4f6, #26262a)); padding: 5px 9px; }
    .button:hover:not(:disabled) { background: var(--color-background-tertiary, light-dark(#e9e9ee, #333338)); }
    .notice { margin-top: 12px; border-radius: 8px; padding: 9px 11px; background: var(--color-background-warning, light-dark(#fff5df, #342817)); color: var(--color-text-warning, light-dark(#704b08, #f8ce81)); }
    .notice[data-kind="error"] { background: var(--color-background-danger, light-dark(#fff0ee, #351e1e)); color: var(--color-text-danger, light-dark(#9e3232, #ffaaaa)); }
    .notice[hidden], .selector[hidden], #return-current[hidden] { display: none; }
    .selector { display: flex; flex-wrap: wrap; align-items: end; gap: 8px 12px; margin-top: 19px; }
    .selector label { min-width: 0; display: grid; gap: 4px; font-size: 12px; color: var(--color-text-secondary, light-dark(#5f5f66, #a9a9b2)); }
    .selector select { min-width: 0; max-width: 100%; border: 1px solid var(--color-border-primary, light-dark(#d8d8de, #3a3a40)); border-radius: 8px; background: var(--color-background-primary, light-dark(#fff, #1c1c1f)); padding: 6px 9px; font-size: 13px; }
    .issue { margin-top: 20px; }
    .facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px 20px; margin: 10px 0 0; padding: 12px; border-radius: 12px; background: var(--color-background-secondary, light-dark(#f4f4f6, #26262a)); }
    .facts div { min-width: 0; }
    dt { color: var(--color-text-secondary, light-dark(#5f5f66, #a9a9b2)); font-size: 12px; }
    dd { margin: 2px 0 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .summary, .coverage-note { margin-top: 12px; max-width: 72ch; }
    .coverage-note { color: var(--color-text-warning, light-dark(#704b08, #f8ce81)); }
    .items { margin-top: 24px; }
    .items ol { list-style: none; margin: 8px 0 0; padding: 0; }
    .item { padding: 15px 0; border-top: 1px solid var(--color-border-secondary, light-dark(#e4e4e8, #333338)); }
    .item-meta { margin-bottom: 4px; color: var(--color-text-secondary, light-dark(#5f5f66, #a9a9b2)); font-size: 12px; }
    .item p + p { margin-top: 7px; }
    .item .body { margin-top: 7px; max-width: 72ch; }
    .item dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px 18px; margin: 11px 0 0; }
    .source { margin-top: 10px; }
    .source-url { display: block; width: fit-content; max-width: 100%; margin-top: 3px; color: var(--color-text-link, light-dark(#07559b, #9bcfff)); overflow-wrap: anywhere; user-select: text; }
    .empty { margin-top: 12px; border-radius: 8px; padding: 13px; background: var(--color-background-secondary, light-dark(#f4f4f6, #26262a)); color: var(--color-text-secondary, light-dark(#5f5f66, #a9a9b2)); }
    @media (max-width: 530px) { main { padding: 14px 14px 24px; } .facts, .item dl { grid-template-columns: minmax(0, 1fr); } .selector { align-items: stretch; } .selector label { width: 100%; } .selector select { width: 100%; } }
  </style>
</head>
<body>
  <main>
    <header class="head"><div><h1 id="title"></h1><p id="purpose" class="purpose muted"></p></div><button id="refresh" class="button" type="button">Refresh</button></header>
    <p id="notice" class="notice" role="status" hidden></p>
    <div id="selector" class="selector" hidden><label><span id="edition-label">Edition</span><select id="edition"></select></label><button id="return-current" class="button" type="button" hidden>Return to current</button><button id="more" class="button" type="button" hidden>More editions</button></div>
    <section id="report" aria-live="polite"></section>
  </main>
  <script>
    (() => {
      "use strict";
      const kind = "__REPORT_KIND__";
      const $ = (id) => document.getElementById(id);
      const sdk = window.mausApp;
      const state = { selected: "current", current: null, edition: null, history: [], items: [], nextCursor: null, revision: null, loaded: false, busy: false, pending: false, run: 0 };
      const labels = {
        en: {
          xTitle: "Daily X AI digest", xPurpose: "Selected X AI updates with source and coverage notes.", githubTitle: "GitHub activity & discovery", githubPurpose: "Selected open-source projects and observed activity signals.",
          refresh: "Refresh", current: "Current", earlier: "Earlier editions", returnCurrent: "Return to current", more: "More editions", loading: "Loading report…", checking: "Checking for new editions…",
          noEdition: "No report published yet. The first edition will appear after this Automation publishes one.", noItems: "No noteworthy items in this verified edition.", noVerifiedItems: "No verified items in this partial edition.",
          unavailable: "Report unavailable. Try Refresh.", stale: "Showing the last loaded edition. Data could not be refreshed; try Refresh.", changed: "Data changed while this report was being read. Try Refresh.",
          issue: "Issue", issueDate: "Issue date · China time", coverage: "Coverage", coverageUnavailable: "Coverage window unavailable", sourcesAsOf: "Sources as of · report level", published: "Report published at", dateUnavailable: "Date unavailable",
          complete: "Coverage complete", partial: "Coverage incomplete", unknown: "Coverage unknown", selected: "Selected updates", projects: "Selected projects", source: "Source", sourcePublished: "Source published", sourceDateUnavailable: "Source date unavailable",
          why: "Why it matters", verification: "Verification note", selection: "Selection basis", vendor: "Vendor claim", primary: "Primary source", secondary: "Secondary source", curated: "Curated selection",
          repoStars: "Stars", repoForks: "Forks", repoPushed: "Last repository activity", weekly: "Weekly Trending star increase", signal: "Signal source", advisories: "Public advisories returned", advisoryNote: "This is not a safety audit.", advisoryAsOf: "Public advisory check as of"
        },
        zh: {
          xTitle: "每日 X AI 摘要", xPurpose: "精选 X AI 动态，并标明来源与覆盖限制。", githubTitle: "GitHub 活跃与发现", githubPurpose: "精选开源项目及已记录的活跃信号。",
          refresh: "刷新", current: "当前版本", earlier: "过往版本", returnCurrent: "返回当前版本", more: "更多版本", loading: "正在读取报告…", checking: "正在检查新版本…",
          noEdition: "尚无已发布的报告。该自动化首次发布后，版本才会出现在这里。", noItems: "此已核实版本没有值得报告的条目。", noVerifiedItems: "此部分覆盖版本没有已核实的条目。",
          unavailable: "报告暂不可用，请重试刷新。", stale: "正在显示上次读取的版本；数据刷新失败，请重试。", changed: "读取时 Data 已变化，请重试刷新。",
          issue: "期次", issueDate: "期次日期 · 中国时间", coverage: "覆盖范围", coverageUnavailable: "覆盖时间范围未知", sourcesAsOf: "来源截至 · 报告级", published: "报告发布时间", dateUnavailable: "日期未知",
          complete: "覆盖完整", partial: "覆盖不完整", unknown: "覆盖情况未知", selected: "精选动态", projects: "精选项目", source: "来源", sourcePublished: "来源发布时间", sourceDateUnavailable: "来源日期未知",
          why: "为何重要", verification: "核实说明", selection: "入选依据", vendor: "供应商说法", primary: "一手来源", secondary: "二手来源", curated: "人工精选",
          repoStars: "星标", repoForks: "复刻", repoPushed: "最近仓库活动", weekly: "每周 Trending 星标增长", signal: "信号来源", advisories: "返回的公开安全公告", advisoryNote: "这不是安全审计。", advisoryAsOf: "公开公告查询截至"
        }
      };
      function word(key) { return labels[document.documentElement.lang.toLowerCase().startsWith("zh") ? "zh" : "en"][key]; }
      function node(tag, className, value) { const result = document.createElement(tag); if (className) result.className = className; if (value !== undefined) result.textContent = String(value); return result; }
      function date(value) {
        if (!value) return word("dateUnavailable");
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return String(value);
        return new Intl.DateTimeFormat(document.documentElement.lang || "en", { timeZone: "Asia/Shanghai", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(parsed) + " (China time)";
      }
      function issueDate(value) { return value ? String(value).slice(0, 10) : word("dateUnavailable"); }
      function rowPage(answer) {
        if (!answer || !Array.isArray(answer.columns) || !Array.isArray(answer.rows) || !Number.isSafeInteger(answer.revision)) throw new Error("Invalid report data.");
        const fields = answer.columns.map((column) => column && column.name);
        if (fields.some((field) => typeof field !== "string")) throw new Error("Unnamed report field.");
        return { rows: answer.rows.map((row) => {
          if (!Array.isArray(row)) throw new Error("Invalid report row.");
          return Object.fromEntries(fields.map((field, index) => [field, row[index] ?? null]));
        }), revision: answer.revision, nextCursor: answer.nextCursor ?? null };
      }
      async function query(id, parameters, options) {
        if (!sdk || typeof sdk.query !== "function") throw new Error("Report data connection unavailable.");
        return rowPage(await sdk.query(id, parameters, options));
      }
      function fact(list, label, value) {
        const wrap = node("div"); wrap.append(node("dt", "", label), node("dd", "", value)); list.append(wrap);
      }
      function optionalFact(list, label, value) { if (value !== null && value !== undefined && String(value).trim()) fact(list, label, value); }
      function plainUrl(parent, value) {
        if (typeof value !== "string") return;
        try {
          const parsed = new URL(value);
          if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password || !parsed.hostname) return;
          parent.append(node("span", "source-url", value));
        } catch { return; }
      }
      function renderItem(item) {
        const li = node("li", "item");
        const meta = [item.category, item.attribution ? word(item.attribution) : null].filter(Boolean).join(" · ");
        if (meta) li.append(node("p", "item-meta", meta));
        li.append(node("h3", "", item.title || ""), node("p", "body", item.summary || ""));
        if (item.whyItMatters) li.append(node("p", "body", word("why") + ": " + item.whyItMatters));
        if (item.verificationNote) li.append(node("p", "body", word("verification") + ": " + item.verificationNote));
        if (kind === "github_activity") {
          const facts = node("dl");
          optionalFact(facts, word("repoStars"), item.repoStars);
          optionalFact(facts, word("repoForks"), item.repoForks);
          if (item.repoPushedAt) fact(facts, word("repoPushed"), date(item.repoPushedAt));
          optionalFact(facts, word("weekly"), item.weeklyStarIncrease);
          if (item.publicAdvisoryCount !== null && item.publicAdvisoryCount !== undefined) {
            fact(facts, word("advisories"), String(item.publicAdvisoryCount) + ". " + word("advisoryNote"));
            if (item.publicAdvisoryAsOfAt) fact(facts, word("advisoryAsOf"), date(item.publicAdvisoryAsOfAt));
          }
          if (facts.children.length) li.append(facts);
          if (item.signalSourceUrl) { const signal = node("p", "source"); signal.append(node("span", "muted", word("signal") + ": ")); plainUrl(signal, item.signalSourceUrl); li.append(signal); }
        }
        if (item.selectionBasis) li.append(node("p", "body muted", word("selection") + ": " + item.selectionBasis));
        const source = node("div", "source");
        source.append(node("span", "muted", word("source") + ": " + (item.sourceLabel || "")));
        plainUrl(source, item.sourceUrl);
        source.append(node("p", "muted", item.sourcePublishedAt ? word("sourcePublished") + ": " + date(item.sourcePublishedAt) : word("sourceDateUnavailable")));
        li.append(source);
        return li;
      }
      function render() {
        $("title").textContent = word(kind === "x_ai_digest" ? "xTitle" : "githubTitle");
        $("purpose").textContent = word(kind === "x_ai_digest" ? "xPurpose" : "githubPurpose");
        $("refresh").textContent = word("refresh");
        $("edition-label").textContent = word("earlier");
        $("return-current").textContent = word("returnCurrent");
        $("more").textContent = word("more");
        const current = state.current;
        const selected = state.edition;
        $("selector").hidden = !current;
        $("return-current").hidden = state.selected === "current";
        $("more").hidden = !state.nextCursor;
        const menu = $("edition");
        const option = (label, value) => { const result = node("option", "", label); result.value = value; return result; };
        const options = [option(word("current"), "current")];
        for (const entry of state.history) {
          if (entry.editionKey !== current?.editionKey) options.push(option(issueDate(entry.editionDay || entry.editionKey), String(entry.editionKey)));
        }
        if (state.selected !== "current" && !state.history.some((entry) => entry.editionKey === state.selected)) options.push(option(issueDate(state.selected), state.selected));
        menu.replaceChildren(...options);
        menu.value = state.selected;
        const area = $("report");
        const scroll = document.scrollingElement?.scrollTop ?? 0;
        if (!selected) {
          area.replaceChildren(node("p", "empty", state.loaded ? word("noEdition") : word("loading")));
          return;
        }
        const issue = node("section", "issue");
        issue.append(node("h2", "", word("issue")));
        const facts = node("dl", "facts");
        fact(facts, word("issueDate"), issueDate(selected.editionDay || selected.editionKey));
        fact(facts, word("coverage"), selected.windowStartAt && selected.windowEndAt ? date(selected.windowStartAt) + " – " + date(selected.windowEndAt) : word("coverageUnavailable"));
        if (selected.sourceAsOfAt) fact(facts, word("sourcesAsOf"), date(selected.sourceAsOfAt));
        fact(facts, word("published"), date(selected.publishedAt));
        issue.append(facts);
        issue.append(node("p", "summary", word(selected.coverageStatus === "complete" ? "complete" : selected.coverageStatus === "partial" ? "partial" : "unknown")));
        if (selected.coverageNote) issue.append(node("p", "coverage-note", selected.coverageNote));
        if (selected.reportSummary) issue.append(node("p", "summary", selected.reportSummary));
        const items = node("section", "items");
        items.append(node("h2", "", word(kind === "x_ai_digest" ? "selected" : "projects")));
        if (state.items.length === 0) items.append(node("p", "empty", selected.coverageStatus === "complete" ? word("noItems") : word("noVerifiedItems")));
        else { const list = node("ol"); for (const item of state.items) list.append(renderItem(item)); items.append(list); }
        area.replaceChildren(issue, items);
        if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
      }
      async function readGroup() {
        const current = await query("current", {}, {});
        const pinned = { expectedDataRevision: current.revision };
        const history = await query("history", {}, pinned);
        if (history.revision !== current.revision) throw new Error(word("changed"));
        const selected = state.selected === "current" ? current.rows[0] ?? null : (await query("edition", { editionKey: state.selected }, pinned)).rows[0] ?? null;
        const items = selected ? await query("items", { editionKey: String(selected.editionKey) }, pinned) : null;
        if (items && items.revision !== current.revision) throw new Error(word("changed"));
        return { current: current.rows[0] ?? null, edition: selected, history: history.rows, nextCursor: history.nextCursor, items: items?.rows ?? [], revision: current.revision };
      }
      async function refresh() {
        if (state.busy) { state.pending = true; state.run += 1; return; }
        state.busy = true;
        const run = ++state.run;
        $("refresh").disabled = true;
        if (state.loaded) { $("notice").hidden = false; $("notice").textContent = word("checking"); $("notice").dataset.kind = ""; }
        try {
          let result;
          for (let attempt = 0; attempt < 2; attempt++) {
            try { result = await readGroup(); break; }
            catch (error) { if (attempt || !String(error).includes("Data changed")) throw error; }
          }
          if (run !== state.run || !result) return;
          Object.assign(state, result, { loaded: true });
          render();
          $("notice").hidden = true;
        } catch {
          if (run === state.run) {
            $("notice").hidden = false;
            $("notice").dataset.kind = "error";
            $("notice").textContent = word(state.loaded ? "stale" : "unavailable");
            if (!state.loaded) $("report").replaceChildren(node("p", "empty", word("unavailable")));
          }
        } finally {
          state.busy = false;
          $("refresh").disabled = false;
          if (state.pending) { state.pending = false; void refresh(); }
        }
      }
      $("edition").addEventListener("change", (event) => { state.selected = event.target.value; void refresh(); });
      $("return-current").addEventListener("click", () => { state.selected = "current"; void refresh(); });
      $("refresh").addEventListener("click", () => { void refresh(); });
      $("more").addEventListener("click", async () => {
        if (!state.nextCursor || state.busy || state.revision === null) return;
        state.busy = true;
        try {
          const page = await query("history", {}, { cursor: state.nextCursor, expectedDataRevision: state.revision });
          if (page.revision !== state.revision) throw new Error(word("changed"));
          state.history.push(...page.rows);
          state.nextCursor = page.nextCursor;
          render();
        } catch { $("notice").hidden = false; $("notice").dataset.kind = "error"; $("notice").textContent = word("stale"); }
        finally { state.busy = false; }
      });
      if (sdk && typeof sdk.onDataChanged === "function") sdk.onDataChanged(() => { void refresh(); });
      new MutationObserver(() => render()).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
      render();
      void refresh();
    })();
  </script>
</body>
</html>`;

export function createReportTemplate(kind: ReportKind): string {
  return HTML.replace("__REPORT_KIND__", kind);
}
