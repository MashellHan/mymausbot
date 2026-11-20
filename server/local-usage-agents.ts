import type { LocalUsageAgentTokenRow } from "../shared/local-dashboard.ts";
import { redactSecretsInText } from "../shared/redact.ts";

const MAX_DAILY_AGENTS = 64;
const MAX_LABEL_LENGTH = 120;

function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string" || !value.length || value.length > MAX_LABEL_LENGTH) return null;
  if (value.trim() !== value) return null;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return null;
  }
  return redactSecretsInText(value) === value ? value : null;
}

export function retainedAgentTokens(raw: unknown, dayTotalTokens: number): LocalUsageAgentTokenRow[] | undefined {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_DAILY_AGENTS) return undefined;
  if (!Number.isSafeInteger(dayTotalTokens) || dayTotalTokens < 0) return undefined;
  const seen = new Set<string>();
  const result: LocalUsageAgentTokenRow[] = [];
  let sum = 0;
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const row = candidate as Record<string, unknown>;
    const id = cleanLabel(row.id);
    const name = cleanLabel(row.name);
    const teamId = cleanLabel(row.teamId);
    const teamName = cleanLabel(row.teamName);
    const totalTokens = row.totalTokens;
    if (!id || !name || !teamId || !teamName || !Number.isSafeInteger(totalTokens) || (totalTokens as number) < 0) {
      return undefined;
    }
    const key = JSON.stringify([teamId, id]);
    if (seen.has(key)) return undefined;
    seen.add(key);
    sum += totalTokens as number;
    if (!Number.isSafeInteger(sum) || sum > dayTotalTokens) return undefined;
    result.push({ id, name, teamId, teamName, totalTokens: totalTokens as number });
  }
  return result;
}
