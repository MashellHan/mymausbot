import type { ReportKind } from "./report-mini-app.ts";

export function reportKindForRoutine(routine: { name: string; prompt: string }): ReportKind | null {
  const explicit = (["x_ai_digest", "github_activity"] as const).filter((kind) =>
    routine.prompt.includes("mini_app_report") && routine.prompt.includes(kind));
  if (explicit.length) return explicit.length === 1 ? explicit[0]! : null;
  const name = routine.name.toLowerCase();
  const x = /(?:\bx\b|twitter|推特)/.test(name) && /\bai\b|人工智能/.test(name);
  const github = /github|开源/.test(name) && /日报|早报|汇总|热门|活跃|报告|report|digest|trend|discover|activity/.test(name);
  return x === github ? null : x ? "x_ai_digest" : "github_activity";
}
