import type { ReportKind } from "./report-mini-app.ts";

const HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Report</title>
  <meta name="description" content="Selected report updates with recorded sources and coverage.">
  <style>
    /* Hallmark · v2.0.0 · shape: app screen · genre: editorial · direction: user reference blue · redesign: full */
    /* Hallmark · pre-emit critique: P4 H4 E4 S4 R5 V4 · weakest: execution; keep source URLs usable without a host link grant */
    :root {
      color-scheme: light dark;
      --report-font: var(--font-sans, system-ui, sans-serif);
      --report-paper: var(--color-background-primary, light-dark(#fbfcff, #1b1e24));
      --report-surface: var(--color-background-secondary, light-dark(#f2f5fa, #262a32));
      --report-ink: var(--color-text-primary, light-dark(#20242b, #eef2f8));
      --report-muted: var(--color-text-secondary, light-dark(#586270, #aeb8c6));
      --report-line: var(--color-border-secondary, light-dark(#dce3ed, #343b46));
      --report-blue: var(--color-text-link, light-dark(#1f6fe5, #91bdff));
      --report-blue-soft: var(--color-background-info, light-dark(#eaf2ff, #24354d));
      --report-warn: var(--color-text-warning, light-dark(#79520a, #f3c878));
      --report-warn-surface: var(--color-background-warning, light-dark(#fff5e3, #352c1e));
      --report-error: var(--color-text-danger, light-dark(#9e3232, #ffaaaa));
      --report-error-surface: var(--color-background-danger, light-dark(#fff0ee, #351e1e));
      --report-ring: var(--color-ring-primary, light-dark(#146cdb, #8cb9ff));
      font: 14px/1.5 var(--report-font);
      background: var(--report-paper);
      color: var(--report-ink);
    }
    * { box-sizing: border-box; }
    html, body { overflow-x: clip; }
    body { margin: 0; }
    button, select { font: inherit; color: inherit; }
    button { cursor: pointer; }
    button:disabled { cursor: default; color: var(--report-muted); background: var(--report-surface); border-color: var(--report-line); }
    button:focus-visible, select:focus-visible { outline: 2px solid var(--report-ring); outline-offset: 2px; }
    ::selection { background: var(--report-blue-soft); color: var(--report-ink); }
    main { max-width: 980px; min-height: 100%; margin: 0 auto; padding: 20px 24px 40px; }
    h1, h2, h3, p { margin: 0; }
    h1, h2 { text-wrap: balance; }
    h1 { min-width: 0; font-size: 22px; line-height: 1.25; font-weight: 700; letter-spacing: -.025em; overflow-wrap: break-word; }
    h2 { min-width: 0; font-size: 16px; line-height: 1.3; font-weight: 680; overflow-wrap: break-word; }
    h3 { min-width: 0; font-size: 14px; line-height: 1.4; font-weight: 680; overflow-wrap: break-word; }
    [hidden] { display: none !important; }
    .masthead { padding-bottom: 16px; border-bottom: 1px solid var(--report-line); }
    .masthead-top { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; }
    .issue-day { color: var(--report-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
    .purpose { margin-top: 4px; max-width: 70ch; color: var(--report-muted); }
    .controls { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 8px 16px; margin-top: 16px; }
    .selector { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }
    .selector label { display: grid; gap: 4px; min-width: 0; color: var(--report-muted); font-size: 12px; }
    .selector select { min-width: 138px; max-width: 100%; border: 1px solid var(--report-line); border-radius: 8px; background: var(--report-paper); padding: 4px 8px; font-size: 13px; }
    .button { min-height: 33px; border: 1px solid var(--report-line); border-radius: 8px; background: var(--report-surface); padding: 4px 8px; }
    .button:hover:not(:disabled), .button:active:not(:disabled) { background: var(--report-blue-soft); }
    .selector .button { background: transparent; }
    .notice { margin-top: 12px; border-radius: 8px; background: var(--report-warn-surface); padding: 8px 12px; color: var(--report-warn); }
    .notice[data-kind="error"] { background: var(--report-error-surface); color: var(--report-error); }
    .overview { padding: 20px 0 20px; border-bottom: 1px solid var(--report-line); }
    .overview-summary { max-width: 68ch; border-radius: 10px; background: var(--report-blue-soft); padding: 12px 16px; font-size: 15px; line-height: 1.55; }
    .edition-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 16px; margin: 12px 0 0; }
    .edition-facts div, .detail-meta div, .project-facts div { min-width: 0; }
    dt { color: var(--report-muted); font-size: 12px; }
    dd { margin: 2px 0 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
    .coverage-state { margin-top: 12px; color: var(--report-muted); font-size: 12px; }
    .coverage-state[data-status="partial"], .coverage-state[data-status="unknown"] { color: var(--report-warn); }
    .coverage-note { max-width: 72ch; margin-top: 4px; color: var(--report-muted); font-size: 12px; }
    .reading-layout { display: grid; grid-template-columns: minmax(0, 290px) minmax(0, 1fr); align-items: start; gap: 24px; margin-top: 24px; }
    .index { position: sticky; top: 12px; min-width: 0; max-height: calc(100vh - 24px); overflow-y: auto; padding-right: 16px; border-right: 1px solid var(--report-line); }
    .index ol { list-style: none; margin: 12px 0 0; padding: 0; }
    .index li + li { border-top: 1px solid var(--report-line); }
    .index-button { display: grid; grid-template-columns: 31px minmax(0, 1fr); align-items: start; gap: 8px; width: 100%; border: 0; border-radius: 8px; background: transparent; padding: 8px 8px; text-align: left; }
    .index-button:hover, .index-button[aria-pressed="true"] { background: var(--report-blue-soft); }
    .index-number { color: var(--report-blue); font-size: 17px; line-height: 1.15; font-weight: 700; font-variant-numeric: tabular-nums; }
    .index-copy { min-width: 0; }
    .index-title { display: block; font-size: 13px; line-height: 1.4; font-weight: 630; overflow-wrap: anywhere; }
    .index-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; margin-top: 4px; color: var(--report-muted); font-size: 11px; }
    .index-meta span { overflow-wrap: anywhere; }
    .detail { min-width: 0; }
    .detail-title { font-size: 25px; line-height: 1.22; letter-spacing: -.025em; }
    .repo-name { margin-top: 8px; color: var(--report-muted); overflow-wrap: anywhere; }
    .detail-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; margin: 16px 0 0; padding: 8px 0; border-top: 1px solid var(--report-line); border-bottom: 1px solid var(--report-line); }
    .detail-section { margin-top: 20px; }
    .detail-section h3 { margin-bottom: 4px; }
    .detail-section p { max-width: 70ch; overflow-wrap: anywhere; }
    .detail-section[data-tone="info"] { border-radius: 10px; background: var(--report-blue-soft); padding: 12px 16px; }
    .project-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; margin: 20px 0 0; padding: 12px 0; border-top: 1px solid var(--report-line); border-bottom: 1px solid var(--report-line); }
    .source-section { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--report-line); }
    .source-section h3 { margin-bottom: 8px; }
    .source-section h3:not(:first-child) { margin-top: 16px; }
    .source-url { display: block; width: fit-content; max-width: 100%; color: var(--color-text-primary, var(--report-ink)); overflow-wrap: anywhere; user-select: text; }
    .source-action { display: inline-block; margin-top: 4px; border: 0; border-radius: 4px; background: transparent; padding: 4px 0; color: var(--report-blue); text-align: left; text-decoration: underline; text-underline-offset: 3px; }
    .source-action:hover:not(:disabled) { text-decoration-thickness: 2px; }
    .source-action:active:not(:disabled) { color: var(--report-ink); }
    .source-action:disabled { background: transparent; color: var(--report-muted); text-decoration: none; }
    .source-date { margin-top: 4px; color: var(--report-muted); font-size: 12px; }
    .empty { margin-top: 20px; border-radius: 10px; background: var(--report-surface); padding: 12px 16px; color: var(--report-muted); }
    .overview + section { margin-top: 24px; }
    @media (max-width: 720px) {
      .reading-layout { grid-template-columns: minmax(0, 1fr); gap: 20px; }
      .index { position: static; max-height: none; overflow: visible; padding: 0 0 16px; border-right: 0; border-bottom: 1px solid var(--report-line); }
      .index ol { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 8px; }
      .index li { border-top: 1px solid var(--report-line); }
    }
    @media (max-width: 490px) {
      main { padding: 16px 16px 28px; }
      h1 { font-size: 20px; }
      .controls { flex-wrap: nowrap; align-items: end; }
      .selector { flex: 1; min-width: 0; }
      .selector label { flex: 1; }
      .selector select { width: 100%; }
      .controls > #refresh { flex: 0 0 auto; }
      .index ol { grid-template-columns: minmax(0, 1fr); }
      .edition-facts { grid-template-columns: minmax(0, 1fr); }
      .detail-title { font-size: 22px; }
      .detail-meta, .project-facts { grid-template-columns: minmax(0, 1fr); }
    }
  </style>
</head>
<body>
  <main>
    <header class="masthead">
      <div class="masthead-top"><h1 id="title"></h1><p id="issue-day" class="issue-day"></p></div>
      <p id="purpose" class="purpose"></p>
      <div class="controls">
        <div id="selector" class="selector" hidden><label><span id="edition-label">Earlier editions</span><select id="edition"></select></label>
          <button id="return-current" class="button" type="button" hidden>Return to current</button>
          <button id="more" class="button" type="button" hidden>More editions</button></div>
        <button id="refresh" class="button" type="button">Refresh</button>
      </div>
      <p id="notice" class="notice" role="status" hidden></p>
    </header>
    <section id="report" aria-live="polite"></section>
  </main>
  <script>
    (() => {
      "use strict";
      const kind = "__REPORT_KIND__";
      const $ = (id) => document.getElementById(id);
      const sdk = window.mausApp;
      const state = { selected: "current", committedSelection: "current", selectedItemIndex: null, current: null, edition: null, history: [], items: [], nextCursor: null, revision: null, loaded: false, busy: false, pending: false, run: 0 };
      const labels = {
        en: {
          xTitle: "Daily X AI digest", xPurpose: "Selected X AI updates with source and coverage notes.", githubTitle: "Github Rending", githubPurpose: "Selected open-source projects and observed activity signals.",
          refresh: "Refresh", current: "Current", earlier: "Earlier editions", returnCurrent: "Return to current", more: "More editions", loading: "Loading report…", checking: "Checking for new editions…",
          noEdition: "No report published yet. The first edition will appear after this Automation publishes one.", selectedUnavailable: "This edition is unavailable. Return to current or choose another edition.", noItems: "No noteworthy items in this verified edition.", noVerifiedItems: "No verified items in this partial edition.", noVerifiedUnknown: "No verified items are available for this edition.",
          unavailable: "Report unavailable. Try Refresh.", stale: "Showing the last loaded edition. Data could not be refreshed; try Refresh.", changed: "Data changed while this report was being read. Try Refresh.",
          issueDate: "Issue date", coverage: "Coverage window", coverageUnavailable: "Coverage window unavailable", sourcesAsOf: "Sources as of (report)", published: "Report published", dateUnavailable: "Date unavailable",
          complete: "Coverage complete", partial: "Coverage incomplete", unknown: "Coverage unknown", selected: "Selected updates", projects: "Selected projects", source: "Source", sourcePublished: "Source published", sourceDateUnavailable: "Source date unavailable",
          what: "What happened", projectSummary: "Project summary", category: "Category", attribution: "Attribution", rangeTo: "to", originalSource: "Original source", openSource: "Open original source", openSignal: "Open signal source", sourceOpenError: "Source could not be opened. Select the URL to copy it.",
          why: "Why it matters", verification: "Verification note", selection: "Selection basis", vendor: "Vendor claim", primary: "Primary source", secondary: "Secondary source", curated: "Curated selection",
          repoStars: "Stars", repoForks: "Forks", repoPushed: "Last repository activity", weekly: "Weekly Trending star increase", signal: "Signal source", advisories: "Public advisories returned", advisoryNote: "This is not a safety audit.", advisoryAsOf: "Public advisory check as of"
        },
        zh: {
          xTitle: "每日 X AI 摘要", xPurpose: "精选 X AI 动态，并标明来源与覆盖限制。", githubTitle: "Github Rending", githubPurpose: "精选开源项目及已记录的活跃信号。",
          refresh: "刷新", current: "当前版本", earlier: "过往版本", returnCurrent: "返回当前版本", more: "更多版本", loading: "正在读取报告…", checking: "正在检查新版本…",
          noEdition: "尚无已发布的报告。该自动化首次发布后，版本才会出现在这里。", selectedUnavailable: "此版本暂不可用。请返回当前版本或选择其他版本。", noItems: "此已核实版本没有值得报告的条目。", noVerifiedItems: "此部分覆盖版本没有已核实的条目。", noVerifiedUnknown: "此版本暂无可确认的条目。",
          unavailable: "报告暂不可用，请重试刷新。", stale: "正在显示上次读取的版本；数据刷新失败，请重试。", changed: "读取时 Data 已变化，请重试刷新。",
          issueDate: "期次日期", coverage: "覆盖时间", coverageUnavailable: "覆盖时间范围未知", sourcesAsOf: "来源截至时间（整期）", published: "报告发布时间", dateUnavailable: "日期未知",
          complete: "覆盖完整", partial: "覆盖不完整", unknown: "覆盖情况未知", selected: "精选动态", projects: "精选项目", source: "来源", sourcePublished: "来源发布时间", sourceDateUnavailable: "来源日期未知",
          what: "发生了什么", projectSummary: "项目简介", category: "类别", attribution: "信息属性", rangeTo: "至", originalSource: "原始来源", openSource: "打开原始来源", openSignal: "打开信号来源", sourceOpenError: "无法打开来源。可选择下方网址复制。",
          why: "为何重要", verification: "核实说明", selection: "入选依据", vendor: "供应商说法", primary: "一手来源", secondary: "二手来源", curated: "精选收录",
          repoStars: "星标", repoForks: "复刻", repoPushed: "最近仓库活动", weekly: "每周 Trending 星标增长", signal: "信号来源", advisories: "返回的公开安全公告", advisoryNote: "这不是安全审计。", advisoryAsOf: "公开公告查询截至"
        }
      };
      function word(key) { return labels[document.documentElement.lang.toLowerCase().startsWith("zh") ? "zh" : "en"][key]; }
      function node(tag, className, value) { const result = document.createElement(tag); if (className) result.className = className; if (value !== undefined) result.textContent = String(value); return result; }
      function date(value) {
        if (!value) return word("dateUnavailable");
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return word("dateUnavailable");
        return new Intl.DateTimeFormat(document.documentElement.lang || "en", { timeZone: "Asia/Shanghai", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(parsed) + (document.documentElement.lang.toLowerCase().startsWith("zh") ? "（中国时间）" : " (China time)");
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
      function safeUrl(value) {
        if (typeof value !== "string") return null;
        try {
          const parsed = new URL(value);
          return (parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password && parsed.hostname && parsed.href.length <= 2048 ? parsed.href : null;
        } catch { return null; }
      }
      function sourceLink(value, actionLabel) {
        const url = safeUrl(value);
        if (!url) return null;
        const wrap = node("div");
        wrap.append(node("span", "source-url", value));
        if (typeof sdk?.openSource === "function") {
          const action = node("button", "source-action", actionLabel);
          action.type = "button";
          action.addEventListener("click", async () => {
            action.disabled = true;
            try { await sdk.openSource(url); }
            catch {
              $("notice").hidden = false;
              $("notice").dataset.kind = "error";
              $("notice").textContent = word("sourceOpenError");
            } finally { action.disabled = false; }
          });
          wrap.append(action);
        }
        return wrap;
      }
      function detailSection(label, value, tone) {
        const section = node("section", "detail-section");
        if (tone) section.dataset.tone = tone;
        section.append(node("h3", "", label), node("p", "", value));
        return section;
      }
      function renderItemDetail(item) {
        const content = node("div");
        content.append(node("h2", "detail-title", item.title || ""));
        if (kind === "github_activity" && item.repoFullName) content.append(node("p", "repo-name", item.repoFullName));
        const meta = node("dl", "detail-meta");
        fact(meta, word("source"), item.sourceLabel || word("dateUnavailable"));
        fact(meta, word("sourcePublished"), item.sourcePublishedAt ? date(item.sourcePublishedAt) : word("sourceDateUnavailable"));
        optionalFact(meta, word("category"), item.category);
        if (item.attribution) optionalFact(meta, word("attribution"), word(item.attribution));
        content.append(meta);
        if (item.summary) content.append(detailSection(word(kind === "x_ai_digest" ? "what" : "projectSummary"), item.summary));
        if (item.whyItMatters) content.append(detailSection(word("why"), item.whyItMatters, "info"));
        if (item.verificationNote) content.append(detailSection(word("verification"), item.verificationNote));
        if (kind === "github_activity") {
          const facts = node("dl", "project-facts");
          optionalFact(facts, word("repoStars"), item.repoStars);
          optionalFact(facts, word("repoForks"), item.repoForks);
          if (item.repoPushedAt) fact(facts, word("repoPushed"), date(item.repoPushedAt));
          optionalFact(facts, word("weekly"), item.weeklyStarIncrease);
          if (item.publicAdvisoryCount !== null && item.publicAdvisoryCount !== undefined) {
            fact(facts, word("advisories"), String(item.publicAdvisoryCount) + ". " + word("advisoryNote"));
            if (item.publicAdvisoryAsOfAt) fact(facts, word("advisoryAsOf"), date(item.publicAdvisoryAsOfAt));
          }
          if (facts.children.length) content.append(facts);
          if (item.selectionBasis) content.append(detailSection(word("selection"), item.selectionBasis));
        }
        const source = node("section", "source-section");
        source.append(node("h3", "", word("originalSource")));
        const original = sourceLink(item.sourceUrl, word("openSource"));
        if (original) source.append(original);
        if (kind === "github_activity" && item.signalSourceUrl) {
          const signal = sourceLink(item.signalSourceUrl, word("openSignal"));
          if (signal) { source.append(node("h3", "", word("signal")), signal); }
        }
        if (source.children.length > 1) content.append(source);
        return content;
      }
      function updateSelectedItem() {
        const item = state.items.find((entry) => String(entry.itemIndex) === state.selectedItemIndex) || state.items[0];
        if (!item) return;
        state.selectedItemIndex = String(item.itemIndex);
        for (const button of $("report").querySelectorAll("[data-report-index]"))
          button.setAttribute("aria-pressed", String(button.dataset.reportIndex === state.selectedItemIndex));
        $("selected-detail").replaceChildren(renderItemDetail(item));
      }
      function render() {
        $("title").textContent = word(kind === "x_ai_digest" ? "xTitle" : "githubTitle");
        document.title = $("title").textContent;
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
        if (state.selected !== state.committedSelection || !selected) {
          $("issue-day").textContent = "";
          const message = state.selected !== state.committedSelection || !state.loaded ? "loading" : state.selected === "current" ? "noEdition" : "selectedUnavailable";
          area.replaceChildren(node("p", "empty", word(message)));
          return;
        }
        $("issue-day").textContent = word("issueDate") + ": " + issueDate(selected.editionDay || selected.editionKey);
        const overview = node("section", "overview");
        if (selected.reportSummary) overview.append(node("p", "overview-summary", selected.reportSummary));
        const facts = node("dl", "edition-facts");
        fact(facts, word("coverage"), selected.windowStartAt || selected.windowEndAt
          ? date(selected.windowStartAt) + " " + word("rangeTo") + " " + date(selected.windowEndAt) : word("coverageUnavailable"));
        if (selected.sourceAsOfAt) fact(facts, word("sourcesAsOf"), date(selected.sourceAsOfAt));
        fact(facts, word("published"), date(selected.publishedAt));
        overview.append(facts);
        const status = selected.coverageStatus === "complete" ? "complete" : selected.coverageStatus === "partial" ? "partial" : "unknown";
        const coverage = node("p", "coverage-state", word(status));
        coverage.dataset.status = status;
        overview.append(coverage);
        if (selected.coverageNote) overview.append(node("p", "coverage-note", selected.coverageNote));
        if (state.items.length === 0) {
          const emptySection = node("section");
          emptySection.append(node("h2", "", word(kind === "x_ai_digest" ? "selected" : "projects")),
            node("p", "empty", word(status === "complete" ? "noItems" : status === "partial" ? "noVerifiedItems" : "noVerifiedUnknown")));
          area.replaceChildren(overview, emptySection);
        } else {
          const layout = node("div", "reading-layout");
          const index = node("nav", "index");
          index.setAttribute("aria-label", word(kind === "x_ai_digest" ? "selected" : "projects"));
          index.append(node("h2", "", word(kind === "x_ai_digest" ? "selected" : "projects")));
          const list = node("ol");
          for (const item of state.items) {
            const entry = node("li");
            const button = node("button", "index-button");
            button.type = "button";
            button.dataset.reportIndex = String(item.itemIndex);
            button.setAttribute("aria-controls", "selected-detail");
            const copy = node("span", "index-copy");
            copy.append(node("strong", "index-title", item.title || ""));
            const meta = node("span", "index-meta");
            if (kind === "github_activity" && item.repoFullName) meta.append(node("span", "", item.repoFullName));
            else if (item.sourceLabel) meta.append(node("span", "", item.sourceLabel));
            if (item.sourcePublishedAt) meta.append(node("span", "", date(item.sourcePublishedAt)));
            copy.append(meta);
            button.append(node("span", "index-number", String(item.itemIndex).padStart(2, "0")), copy);
            button.addEventListener("click", (event) => {
              state.selectedItemIndex = String(item.itemIndex);
              updateSelectedItem();
              if (event.detail > 0 && matchMedia("(max-width: 720px)").matches)
                $("selected-detail").scrollIntoView?.({ block: "start" });
            });
            entry.append(button);
            list.append(entry);
          }
          index.append(list);
          const detail = node("article", "detail");
          detail.id = "selected-detail";
          layout.append(index, detail);
          area.replaceChildren(overview, layout);
          updateSelectedItem();
        }
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
        if (state.loaded) { $("notice").hidden = state.selected !== state.committedSelection; $("notice").textContent = word("checking"); $("notice").dataset.kind = ""; }
        try {
          let result;
          for (let attempt = 0; attempt < 2; attempt++) {
            try { result = await readGroup(); break; }
            catch (error) { if (attempt || !String(error).includes("Data changed")) throw error; }
          }
          if (run !== state.run || !result) return;
          const previousKey = state.edition?.editionKey;
          Object.assign(state, result, { loaded: true, committedSelection: state.selected });
          if (previousKey !== result.edition?.editionKey || !result.items.some((item) => String(item.itemIndex) === state.selectedItemIndex))
            state.selectedItemIndex = result.items[0] ? String(result.items[0].itemIndex) : null;
          render();
          $("notice").hidden = true;
        } catch {
          if (run === state.run) {
            if (state.selected !== state.committedSelection) { state.selected = state.committedSelection; render(); }
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
      $("edition").addEventListener("change", (event) => { state.selected = event.target.value; if (document.scrollingElement) document.scrollingElement.scrollTop = 0; render(); void refresh(); });
      $("return-current").addEventListener("click", () => { state.selected = "current"; if (document.scrollingElement) document.scrollingElement.scrollTop = 0; render(); void refresh(); });
      $("refresh").addEventListener("click", () => { void refresh(); });
      $("more").addEventListener("click", async () => {
        if (!state.nextCursor || state.busy || state.revision === null) return;
        state.busy = true;
        const run = state.run;
        try {
          const page = await query("history", {}, { cursor: state.nextCursor, expectedDataRevision: state.revision });
          if (run !== state.run) return;
          if (page.revision !== state.revision) throw new Error(word("changed"));
          state.history.push(...page.rows);
          state.nextCursor = page.nextCursor;
          render();
        } catch { if (run === state.run) { $("notice").hidden = false; $("notice").dataset.kind = "error"; $("notice").textContent = word("stale"); } }
        finally { state.busy = false; if (state.pending) { state.pending = false; void refresh(); } }
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
