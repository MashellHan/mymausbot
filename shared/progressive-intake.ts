export const PROGRESSIVE_INTAKE_MODES = [
  "live-steer",
  "progressive-continue",
  "soft-redirect",
  "readonly-concurrent",
  "delegation-forward",
] as const;

export type ProgressiveIntakeMode = (typeof PROGRESSIVE_INTAKE_MODES)[number];

export const PROGRESSIVE_INTAKE_STATES = [
  "received",
  "folding",
  "processing",
  "answered",
  "superseded",
] as const;

export type ProgressiveIntakeState = (typeof PROGRESSIVE_INTAKE_STATES)[number];

export interface ProgressiveIntakeMeta {
  mode: ProgressiveIntakeMode;
  state: ProgressiveIntakeState;
  targetTurnId?: string;
  workerTurnId?: string;
  updatedAt: number;
}

export interface ConcurrentWorkerMeta {
  workerId: string;
  readOnly: true;
  parentTurnId?: string;
}

export function isProgressiveIntakeMode(value: unknown): value is ProgressiveIntakeMode {
  return typeof value === "string" && (PROGRESSIVE_INTAKE_MODES as readonly string[]).includes(value);
}

export function isProgressiveIntakeState(value: unknown): value is ProgressiveIntakeState {
  return typeof value === "string" && (PROGRESSIVE_INTAKE_STATES as readonly string[]).includes(value);
}

export function isTerminalIntakeState(state: ProgressiveIntakeState): boolean {
  return state === "answered" || state === "superseded";
}

export function isPendingIntakeState(state: ProgressiveIntakeState): boolean {
  return state === "received" || state === "folding";
}

export function createProgressiveIntakeMeta(input: {
  mode: ProgressiveIntakeMode;
  state?: ProgressiveIntakeState;
  targetTurnId?: string;
  workerTurnId?: string;
  updatedAt?: number;
}): ProgressiveIntakeMeta {
  return {
    mode: input.mode,
    state: input.state ?? "received",
    ...(input.targetTurnId ? { targetTurnId: input.targetTurnId } : {}),
    ...(input.workerTurnId ? { workerTurnId: input.workerTurnId } : {}),
    updatedAt: input.updatedAt ?? Date.now(),
  };
}

export function transitionProgressiveIntakeState(
  current: ProgressiveIntakeMeta | undefined,
  nextState: ProgressiveIntakeState,
  updatedAt = Date.now(),
  patch?: { targetTurnId?: string | null; workerTurnId?: string; mode?: ProgressiveIntakeMode },
): ProgressiveIntakeMeta | undefined {
  if (!current && !patch?.mode) return undefined;
  const targetTurnId = patch && Object.hasOwn(patch, "targetTurnId")
    ? patch.targetTurnId ?? undefined
    : current?.targetTurnId;
  const workerTurnId = patch?.workerTurnId ?? current?.workerTurnId;
  return {
    mode: patch?.mode ?? current!.mode,
    state: nextState,
    ...(targetTurnId ? { targetTurnId } : {}),
    ...(workerTurnId ? { workerTurnId } : {}),
    updatedAt,
  };
}

declare module "../packages/phone-protocol/src/wire.ts" {
  interface WireMessage {
    /** Progressive intake routing metadata on messages submitted while a turn is busy. */
    intake?: ProgressiveIntakeMeta;
    /** Marker on assistant/worker replies produced by a read-only concurrent worker. */
    concurrentWorker?: ConcurrentWorkerMeta;
  }
}
