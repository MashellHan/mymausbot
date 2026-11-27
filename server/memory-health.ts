import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseMemoryEntries, isExpired } from "./memory-entries.ts";
import { parseTopicHeader } from "./memory-topics.ts";
import { readPlaybook, playbookUtility } from "./memory-playbook.ts";
import { MEMORY_MAX_BYTES, memoryDate, readMemoryText, workspaceDir } from "./workspace.ts";

export interface MemoryHealthSnapshot {
  botId: string;
  coreBytes: number;
  coreBudgetRatio: number;
  activeEntries: number;
  expiredEntries: number;
  supersededEntries: number;
  topicCount: number;
  orphanTopicCount: number;
  playbookRuleCount: number;
  activePlaybookRules: number;
  averagePlaybookUtility: number | null;
}

export function memoryHealth(botId: string, today = memoryDate()): MemoryHealthSnapshot {
  const dir = workspaceDir(botId);
  const corePath = join(dir, "MEMORY.md");
  const coreText = existsSync(corePath) ? readMemoryText(corePath) : "";
  const coreBytes = existsSync(corePath) ? statSync(corePath).size : 0;

  let activeEntries = 0;
  let expiredEntries = 0;
  let supersededEntries = 0;

  const tallyText = (text: string) => {
    for (const entry of parseMemoryEntries(text)) {
      if (entry.struck || entry.supersededAt) {
        supersededEntries += 1;
      } else if (isExpired(entry, today)) {
        expiredEntries += 1;
      } else {
        activeEntries += 1;
      }
    }
  };
  tallyText(coreText);

  const memoryDir = join(dir, "memory");
  const topicSlugs = new Set<string>();
  const linkedTargets = new Set<string>();
  const topicLinks = new Map<string, string[]>();

  if (existsSync(memoryDir)) {
    for (const name of readdirSync(memoryDir)) {
      if (!name.endsWith(".md") || name === "playbook.md") continue;
      const fullPath = join(memoryDir, name);
      if (!statSync(fullPath).isFile()) continue;
      const text = readMemoryText(fullPath);
      tallyText(text);
      const slug = name.slice(0, -3).toLowerCase();
      topicSlugs.add(slug);
      const header = parseTopicHeader(text);
      const links = header.links ?? [];
      topicLinks.set(slug, links);
      for (const target of links) linkedTargets.add(target.toLowerCase());
    }
  }

  let orphanTopicCount = 0;
  for (const slug of topicSlugs) {
    const out = topicLinks.get(slug) ?? [];
    if (out.length === 0 && !linkedTargets.has(slug)) orphanTopicCount += 1;
  }

  const rules = readPlaybook(botId);
  const activeRules = rules.filter((r) => !r.struck);
  const averagePlaybookUtility = activeRules.length > 0
    ? Number((activeRules.reduce((sum, rule) => sum + playbookUtility(rule, today), 0) / activeRules.length).toFixed(4))
    : null;

  return {
    botId,
    coreBytes,
    coreBudgetRatio: Number((coreBytes / MEMORY_MAX_BYTES).toFixed(4)),
    activeEntries,
    expiredEntries,
    supersededEntries,
    topicCount: topicSlugs.size,
    orphanTopicCount,
    playbookRuleCount: rules.length,
    activePlaybookRules: activeRules.length,
    averagePlaybookUtility,
  };
}
