export * from "../packages/phone-protocol/src/model-selection.ts";
import type { EffortLevel } from "../packages/phone-protocol/src/model-selection.ts";

/** Why the provider's model list could not be read. */
export type ModelListProblem = "signedOut" | "timedOut" | "failed";

export function modelEffortLevels(options: readonly { id: string; effortLevels?: readonly EffortLevel[] }[] | undefined,
  model: string, fallback: readonly EffortLevel[] | undefined): readonly EffortLevel[] {
  return options?.find((option) => option.id === model)?.effortLevels ?? fallback ?? [];
}
