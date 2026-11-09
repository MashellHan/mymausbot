export const MAX_USAGE_HISTORY_DAYS = 191;
export const usageTrendRanges = ["30", "60", "90", "6m"] as const;
export type UsageTrendRange = typeof usageTrendRanges[number];

export function shiftUsageDay(day: string, offset: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

/** Inclusive China-calendar dates; six months excludes the clamped same date six calendar months earlier. */
export function usageTrendRange(endDay: string, range: UsageTrendRange) {
  let startDay: string;
  if (range === "6m") {
    const end = new Date(`${endDay}T00:00:00Z`);
    const month = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 6, 1));
    const last = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
    month.setUTCDate(Math.min(end.getUTCDate(), last));
    startDay = shiftUsageDay(month.toISOString().slice(0, 10), 1);
  } else startDay = shiftUsageDay(endDay, 1 - Number(range));
  return { startDay, endDay, days: Math.round((Date.parse(endDay) - Date.parse(startDay)) / 86_400_000) + 1 };
}
