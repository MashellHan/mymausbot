import { listPriceAt, listPriceFor, type ListPrice } from "../model-prices.ts";
import type { ModelPrice } from "../prices.ts";

const openai = { asOf: "2026-11-19", source: "https://developers.openai.com/api/docs/pricing" };
const google = { asOf: "2026-11-19", source: "https://ai.google.dev/gemini-api/docs/pricing" };
const github = { asOf: "2026-11-19", source: "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing#pricing-tables" };
const prices: Readonly<Record<string, ListPrice>> = {
  "openai/gpt-6-astra": { inputPerMillion: 10, cachedInputPerMillion: 1, outputPerMillion: 50, ...openai },
  "openai/gpt-6.2-astra": { inputPerMillion: 8, cachedInputPerMillion: 0.4, outputPerMillion: 40, ...openai },
  "openai/gpt-6-sol": { inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 10, ...openai },
  "openai/gpt-6.1-sol": { inputPerMillion: 2, cachedInputPerMillion: 0.1, outputPerMillion: 10, ...openai },
  "openai/gpt-6.2-sol": { inputPerMillion: 2, cachedInputPerMillion: 0.1, outputPerMillion: 10, ...openai },
  "google/gemini-4-hydrogen": { inputPerMillion: 1.5, cachedInputPerMillion: 0.075, outputPerMillion: 7.5, ...google },
  "google/gemini-4-carbon": {
    inputPerMillion: 2, cachedInputPerMillion: 0.1, outputPerMillion: 10, ...google,
    changes: [{ from: "2026-12-01", inputPerMillion: 4, cachedInputPerMillion: 0.2, outputPerMillion: 20 }],
  },
  "mai-code-2": {
    inputPerMillion: 0.5, cachedInputPerMillion: 0.025, outputPerMillion: 2.5, ...github,
    changes: [{ from: "2027-05-17", inputPerMillion: 1, cachedInputPerMillion: 0.05, outputPerMillion: 5 }],
  },
};

const proxyAliases = new Map(Object.keys(prices).map((id) => [id.slice(id.indexOf("/") + 1), id]));

export function activityListPriceFor(model: string, at: Date): ModelPrice | null {
  const key = model.trim().toLowerCase();
  const qualified = proxyAliases.get(key) ?? key;
  return listPriceFor(key, at) ?? (qualified === key ? null : listPriceFor(qualified, at))
    ?? (Object.hasOwn(prices, qualified) ? listPriceAt(prices[qualified]!, at) : null);
}
