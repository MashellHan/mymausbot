import { plainRecord } from "./codex-app-approval.ts";
import { parseVersionTriple, versionAtLeast } from "./acp/version-probe.ts";

/** Codex app-server 0.167.1 exposes model_context_window in thread/start and thread/resume config. */
export function codexContextWindowSupported(version: string): boolean {
  const match = /^codex-cli (\d+\.\d+\.\d+)$/.exec(version.trim());
  const parsed = match && parseVersionTriple(match[1]);
  return parsed !== null && versionAtLeast(parsed, [0, 167, 1]);
}

/** Thread-config overrides adding `patterns` to the person's shell exclusions. Codex keeps two
 * representations, the `exclude`/`include_only` lists and the `filters` table, and a higher layer
 * that writes one drops the other below it (codex-cli 0.160, which reports unset fields as null). */
export function extendShellExclusions(policy: Record<string, unknown>, patterns: readonly string[]): Record<string, unknown> {
  const unconfirmed = () => new Error("Codex could not confirm its shell environment exclusions. No prompt was sent.");
  const exclude = policy.exclude ?? undefined;
  const filters = policy.filters ?? undefined;
  if (exclude !== undefined && (!Array.isArray(exclude) || exclude.some(name => typeof name !== "string"))) throw unconfirmed();
  if (filters === undefined) {
    return { "shell_environment_policy.exclude": [...new Set([...(exclude ?? []) as string[], ...patterns])] };
  }
  const table = plainRecord(filters);
  if (!table || Object.values(table).some(action => action !== "exclude" && action !== "include")) throw unconfirmed();
  // One Codex layer cannot mix the two; writing filters would drop the lists.
  if (exclude !== undefined || (policy.include_only ?? undefined) !== undefined) throw unconfirmed();
  // Patterns match, merge across layers, and must be unique ignoring case.
  const ours = new Set(patterns.map(pattern => pattern.toLowerCase()));
  return { "shell_environment_policy.filters": Object.fromEntries([
    ...Object.entries(table).filter(([pattern]) => !ours.has(pattern.toLowerCase())),
    ...patterns.map(pattern => [pattern, "exclude"]),
  ]) };
}
