import { describe, expect, it } from "vitest";
import { usageTrendRange } from "./local-usage-range";

describe("China-calendar trend ranges", () => {
  it.each(["30", "60", "90"] as const)("includes the data date in a %s-day range", (range) => {
    const result = usageTrendRange("2026-01-01", range);
    expect(result.days).toBe(Number(range));
    expect(result.endDay).toBe("2026-01-01");
  });
  it.each([
    ["2026-11-09", "2026-05-10", 184],
    ["2024-08-31", "2024-03-01", 184],
    ["2025-08-31", "2025-03-01", 184],
    ["2024-02-29", "2023-08-30", 184],
    ["2026-03-31", "2025-10-01", 182],
    ["2026-01-01", "2025-07-02", 184],
  ])("clamps the six-month lower boundary for %s", (endDay, startDay, days) => {
    expect(usageTrendRange(endDay as string, "6m")).toEqual({ startDay, endDay, days });
  });
});
