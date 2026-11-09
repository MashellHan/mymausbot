import { createHash } from "node:crypto";
import type { DefaultMiniAppKind } from "../../shared/mini-apps.ts";
import { REPORT_APPS } from "../../shared/report-mini-app.ts";
import { GITHUB_PENDING_TEMPLATE_SHA256 } from "./default-template-history.ts";

export const DEFAULT_APPS = {
  bookkeeping: { slug: "bookkeeping", title: "记账管家", description: "Records, calendar, cash flow and trends from your existing ledger." },
  ...REPORT_APPS,
  "agent-team": { slug: "agent-team", title: "Agent Team", description: "Your local teams and their current activity." },
  usage: { slug: "usage", title: "Activities", description: "Your work, contributions and agent activity." },
} as const;

export const NATIVE_DEFAULT_HTML = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Built-in dashboard</title><body>Open this app in the OpenMausBot desktop app.</body></html>';

export function updatedDefaultAppTitle(kind: DefaultMiniAppKind, title: string): string {
  return kind === "github_activity" && ["GitHub activity", "GitHub activity & discovery"].includes(title)
    ? DEFAULT_APPS.github_activity.title : title;
}

export function matchesPendingDefaultHtml(kind: DefaultMiniAppKind, html: string): boolean {
  return html === pendingDefaultHtml(kind) || kind === "github_activity"
    && createHash("sha256").update(html).digest("hex") === GITHUB_PENDING_TEMPLATE_SHA256;
}

export function pendingDefaultHtml(kind: DefaultMiniAppKind): string {
  const ledger = kind === "bookkeeping";
  const zh = ledger ? "还没有找到记账记录。记账 Bot 的账本准备好后，记录会自动出现在这里。"
    : "报告更新后会出现在这里。现有 Bot 和自动化可以持续更新这个应用。";
  const en = ledger ? "No ledger is available yet. Your bookkeeping Bot’s records will appear here automatically."
    : "New reports will appear here as your Bot and its Automations publish updates.";
  return `<!doctype html><html><meta charset="utf-8"><title>${DEFAULT_APPS[kind].title}</title>
<style>body{margin:0;color:var(--color-text-primary);background:var(--color-background-primary);font:14px/1.6 system-ui,sans-serif}main{padding:24px;max-width:65ch}h1{font-size:20px;line-height:1.3;margin:0 0 12px}p{margin:0;color:var(--color-text-secondary)}:root:lang(zh) .en{display:none}:root:not(:lang(zh)) .zh{display:none}</style>
<main><h1>${DEFAULT_APPS[kind].title}</h1><p class="zh" lang="zh">${zh}</p><p class="en" lang="en">${en}</p></main></html>`;
}
