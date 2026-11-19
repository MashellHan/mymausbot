import { describe, expect, it } from "vitest";
import { activityListPriceFor } from "./activity-prices.ts";

const at = new Date("2026-11-19T02:00:00Z");

describe("Activities list rates", () => {
  it.each([
    ["gpt-6-astra", "openai/gpt-6-astra", 10, 1, 50],
    ["gpt-6.2-astra", "openai/gpt-6.2-astra", 8, 0.4, 40],
    ["gpt-6-sol", "openai/gpt-6-sol", 2, 0.2, 10],
    ["gpt-6.1-sol", "openai/gpt-6.1-sol", 2, 0.1, 10],
    ["gpt-6.2-sol", "openai/gpt-6.2-sol", 2, 0.1, 10],
    ["gemini-4-hydrogen", "google/gemini-4-hydrogen", 1.5, 0.075, 7.5],
    ["gemini-4-carbon", "google/gemini-4-carbon", 2, 0.1, 10],
    ["mai-code-2", "mai-code-2", 0.5, 0.025, 2.5],
  ])("prices %s through its exact listed model", (model, qualified, input, cached, output) => {
    for (const id of [model, qualified]) {
      expect(activityListPriceFor(id, at)).toMatchObject({
        inputPerMillion: input, cachedInputPerMillion: cached, outputPerMillion: output,
      });
    }
  });

  it.each(["other/gemini-4-carbon", "gpt-6.2-sol-unknown", "constructor"])(
    "keeps %s unpriced without a matching list rate",
    (model) => expect(activityListPriceFor(model, at)).toBeNull(),
  );

  it.each([
    ["gemini-4-carbon", "2026-12-01", 4, 0.2, 20],
    ["mai-code-2", "2027-05-17", 1, 0.05, 5],
  ])("applies the published rate change for %s on %s", (model, from, input, cached, output) => {
    expect(activityListPriceFor(model, new Date(from))).toEqual({
      inputPerMillion: input, cachedInputPerMillion: cached, outputPerMillion: output,
    });
  });
});
