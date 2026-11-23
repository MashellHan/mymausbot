import type {
  LocalUsageCoverage, LocalUsageEstimatedCost, LocalUsageModelRow, LocalUsageTokenDetails,
} from "../shared/local-dashboard.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { listPriceFor } from "./model-prices.ts";
import { activityListPriceFor } from "./model-manifest/activity-prices.ts";
import { billableFor, type ModelPrice } from "./prices.ts";

interface TokenAmounts {
  input: number;
  output: number;
  cacheRead: number;
}

interface ModelObservation extends TokenAmounts {
  provider: string;
  model: string;
}

export interface DailyTokenObservation extends TokenAmounts {
  models: ModelObservation[];
}

const fields = ["input", "output", "cacheRead"] as const;
const providers = new Set(["codex", "copilot", "hermes", "pi", "opencode"]);
const modelLabel = /^[A-Za-z0-9][A-Za-z0-9_.+-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.+-]*)?$/;
const maxDailyModels = 24;
const unavailableCost: LocalUsageEstimatedCost = { coverage: "unavailable", usd: null };
const totalTokens = ({ input, output, cacheRead }: TokenAmounts) => input + output + cacheRead;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function amounts(values: TokenAmounts[]): TokenAmounts {
  return values.reduce((total, row) => ({
    input: total.input + row.input, output: total.output + row.output, cacheRead: total.cacheRead + row.cacheRead,
  }), { input: 0, output: 0, cacheRead: 0 });
}

export function sameTokenAmounts(left: TokenAmounts, right: TokenAmounts): boolean {
  return fields.every((field) => left[field] === right[field]);
}

function modelRows(raw: unknown, totals: TokenAmounts): ModelObservation[] {
  if (!Array.isArray(raw) || raw.length > maxDailyModels) return [];
  const keys = new Set<string>();
  const result: ModelObservation[] = [];
  for (const candidate of raw) {
    const row = record(candidate);
    if (!row) return [];
    const { provider, model, input, output, cacheRead } = row;
    if (typeof provider !== "string" || !providers.has(provider) || typeof model !== "string" ||
        model.length > 120 || model.trim() !== model || model.toLowerCase() === "unknown" ||
        !modelLabel.test(model) || redactSecretsInText(model) !== model ||
        !isCount(input) || !isCount(output) || !isCount(cacheRead) || input + output + cacheRead === 0) return [];
    const key = `${provider}/${model}`;
    if (keys.has(key)) return [];
    keys.add(key);
    result.push({ provider, model, input, output, cacheRead });
  }
  const observed = amounts(result);
  return fields.every((field) => observed[field] <= totals[field]) ? result : [];
}

export function retainedTokenObservation(row: Record<string, unknown>, newTokens: number, cacheRead: number): DailyTokenObservation | undefined {
  const { input, output } = row;
  if (!isCount(input) || !isCount(output) || input + output !== newTokens) return;
  const tokens = { input, output, cacheRead };
  return { ...tokens, models: modelRows(row.models, tokens) };
}

function combinedCost(costs: LocalUsageEstimatedCost[], complete: boolean): LocalUsageEstimatedCost {
  const priced = costs.flatMap(({ usd }) => usd === null ? [] : [usd]);
  if (complete && costs.every(({ coverage }) => coverage === "ready")) {
    return { coverage: "ready", usd: priced.reduce((total, value) => total + value, 0) };
  }
  return priced.length ? { coverage: "partial", usd: priced.reduce((total, value) => total + value, 0) } : unavailableCost;
}

export function createLocalTokenProjector(at: Date) {
  const rates = new Map<string, ModelPrice | null>();

  function estimate(row: ModelObservation): LocalUsageEstimatedCost {
    const key = `${row.provider}/${row.model}`;
    if (!rates.has(key)) rates.set(key, listPriceFor(key, at) ?? activityListPriceFor(row.model, at));
    const rate = rates.get(key);
    if (!rate || ![rate.inputPerMillion, rate.outputPerMillion].every(Number.isFinite)) return unavailableCost;
    const cached = rate.cachedInputPerMillion === undefined ? 0 : row.cacheRead;
    if (row.input + row.output + cached === 0) return unavailableCost;
    const usd = billableFor({ driverKind: row.provider, model: row.model, input: row.input + cached,
      output: row.output, cachedInput: cached }, { [row.model]: rate });
    return { coverage: cached === row.cacheRead ? "ready" : "partial", usd };
  }

  return (days: DailyTokenObservation[], coverage: LocalUsageCoverage): LocalUsageTokenDetails => {
    const observed = days.flatMap((day) => day.models);
    const complete = coverage === "ready" && days.length > 0 && days.every((day) => sameTokenAmounts(amounts(day.models), day));
    const grouped = new Map<string, ModelObservation[]>();
    for (const row of observed) {
      const records = grouped.get(row.model);
      if (records) records.push(row);
      else grouped.set(row.model, [row]);
    }
    const rows: LocalUsageModelRow[] = [...grouped].map(([model, records]) => {
      const tokens = amounts(records);
      return { model, ...tokens, totalTokens: totalTokens(tokens), estimatedCost: combinedCost(records.map(estimate), complete) };
    }).sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
    const totals = amounts(days);
    return { input: days.length ? totals.input : null, output: days.length ? totals.output : null,
      estimatedCost: combinedCost(rows.map((row) => row.estimatedCost), complete),
      models: { coverage: complete ? "ready" : rows.length ? "partial" : "unavailable", rows } };
  };
}
