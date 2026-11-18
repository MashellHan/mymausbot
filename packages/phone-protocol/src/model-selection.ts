/** Reasoning-effort levels, ascending: a union of what any engine accepts;
 * each driver declares the subset its CLI will take. */
export const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** Input bounds for a requested native window, not a model's advertised capacity. */
export const MIN_CONTEXT_WINDOW_TOKENS = 8_192;
export const MAX_CONTEXT_WINDOW_TOKENS = 1_000_000;

/** instanceId is the routing key. */
export interface ModelSelection {
  instanceId: string;
  model: string;
  /** Optional: no effort means no flag, and the CLI keeps its own default. */
  effort?: EffortLevel;
  /** Explicit model-specific variant. Omitted leaves the native session alone. */
  variant?: string;
  /** Requested native context window. Omitted uses the engine's default; the observed meter remains authoritative. */
  contextWindowTokens?: number;
}
