import { availableMemory, boxMemory, type BoxMemory } from "../box-memory.ts";
import { engineMemory, type EngineMemory } from "../engine-memory.ts";
import { onThreadSeen, seenWithin } from "../thread-presence.ts";

export interface SessionIdlePolicy {
  idleMs: number;
  minimumMs: number;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
/** One warm engine and its MCP servers take 250 to 450 MB: on a box this small an idle one is soon given back, and the
 * next turn resumes its session by id. */
export const SMALL_BOX_BYTES = 1.5 * 1024 ** 3;
export const SMALL_BOX_IDLE_MS = 150_000;
const MINIMUM_IDLE_MS = 10_000;
/** setTimeout treats anything above 2^31-1 ms as 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

function usableMilliseconds(raw: string | undefined): number | null {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS ? value : null;
}

/** Per-harness names (OMB_CLAUDE_SESSION_IDLE_*, OMB_ACP_SESSION_IDLE_*) win over OMB_SESSION_IDLE_MS /
 *  OMB_SESSION_IDLE_MIN_MS, which win over the box's default; the floor is the greater of ten seconds and any configured
 *  minimum. */
export function sessionIdlePolicy(
  driverPrefix: string,
  env: Record<string, string | undefined> = process.env,
  boxBytes: number = boxMemory().bytes,
): SessionIdlePolicy {
  const minimumMs = Math.max(
    MINIMUM_IDLE_MS,
    usableMilliseconds(
      env[`OMB_${driverPrefix}_SESSION_IDLE_MIN_MS`] ?? env.OMB_SESSION_IDLE_MIN_MS,
    ) ?? 0,
  );
  const configured =
    usableMilliseconds(
      env[`OMB_${driverPrefix}_SESSION_IDLE_MS`] ?? env.OMB_SESSION_IDLE_MS,
    ) ?? (boxBytes <= SMALL_BOX_BYTES ? SMALL_BOX_IDLE_MS : DEFAULT_IDLE_MS);
  return { idleMs: Math.max(minimumMs, configured), minimumMs };
}

/** On a small box with less than half of it free, a second idle engine would leave no room for a turn's own engine. On a
 * self-hosted server whose memory or pids limit holds only so many engines (`fits`), no more stay idle than fit beside the
 * ones working: each holds its processes and threads against that limit while it waits. */
export function idleEnginesAllowed(box: Pick<BoxMemory, "bytes">, availableBytes: number, fits: number = Infinity): number {
  return Math.min(fits, box.bytes <= SMALL_BOX_BYTES && availableBytes < box.bytes / 2 ? 1 : Infinity);
}

export interface WarmEngine {
  /** Still idle and free to close: no turn running, no hold keeping it up. */
  idle: () => boolean;
  close: () => void;
  /** A per-chat engine's conversation: used to prefer keeping watched engines on the cap. */
  threadId?: string;
  /** Kept on purpose until a time (a prompt-cache keep-warm): never closed for idleness or the cap. */
  held?: () => boolean;
  /** Started before any message and not yet used by a turn: closes before used engines when capped. */
  spare?: () => boolean;
}

const GB = 1024 ** 3;
export const SMALL_BOX_IDLE_ENGINES = 2;
const IDLE_ENGINES_FEWEST = 4, IDLE_ENGINES_MOST = 8;

/** How many engines may stay idle at once across every driver and conversation, whatever the idle times allow:
 * OMB_IDLE_ENGINES_MAX (1 or more), else one per 2 GB of the box between four and eight, and two on a box of 1.5 GB or
 * less. Each holds 250 to 450 MB with its MCP servers. */
export function idleEngineCap(env: Record<string, string | undefined> = process.env, boxBytes: number = boxMemory().bytes): number {
  const configured = Number(env.OMB_IDLE_ENGINES_MAX);
  if (env.OMB_IDLE_ENGINES_MAX && Number.isInteger(configured) && configured >= 1) return configured;
  if (boxBytes <= SMALL_BOX_BYTES) return SMALL_BOX_IDLE_ENGINES;
  return Math.min(IDLE_ENGINES_MOST, Math.max(IDLE_ENGINES_FEWEST, Math.floor(boxBytes / (2 * GB))));
}

/** Idle engines of every driver, the least recently used first: an engine moves to the end when it goes idle and when a
 * person opens or reads its conversation. */
const warmEngines = new Map<string, WarmEngine>();

/** An engine went idle: when the box allows fewer idle engines than are up, the ones idle longest close now (an engine
 * started ahead of a first message before them); past the cap on idle engines, the least recently used close now (one
 * whose conversation no person has had in front of them before them). Never one with a turn running, nor one held. */
export function keepWarm(key: string, engine: WarmEngine, box: Pick<BoxMemory, "bytes"> = boxMemory(),
  available: () => number = availableMemory, fits: () => number = () => engineMemory.idleEnginesAllowed(),
  cap: () => number = () => idleEngineCap(process.env, box.bytes)): void {
  warmEngines.delete(key);
  warmEngines.set(key, engine);
  for (const [other, warm] of warmEngines) if (other !== key && (!warm.idle() || warm.held?.())) warmEngines.delete(other);
  const most = fits();
  const roomAllows = box.bytes > SMALL_BOX_BYTES && most === Infinity ? Infinity : idleEnginesAllowed(box, available(), most);
  const idleBefore = () => [...warmEngines].filter(([other]) => other !== key);
  closeKept(sparesFirst(idleBefore()).slice(0, Math.max(0, warmEngines.size - roomAllows)));
  closeKept(unwatchedFirst(idleBefore()).slice(0, Math.max(0, warmEngines.size - Math.max(1, cap()))));
}

function closeKept(engines: Array<[string, WarmEngine]>): void {
  for (const [key, warm] of engines) {
    warmEngines.delete(key);
    const entry = armed.get(key);
    if (entry) clearTimeout(entry.timer);
    armed.delete(key);
    warm.close();
  }
}

const sparesFirst = (engines: Array<[string, WarmEngine]>): Array<[string, WarmEngine]> =>
  [...engines.filter(([, warm]) => warm.spare?.()), ...engines.filter(([, warm]) => !warm.spare?.())];

const watched = (warm: WarmEngine): boolean => warm.threadId !== undefined && seenWithin(warm.threadId, WATCHED_MS);
const unwatchedFirst = (engines: Array<[string, WarmEngine]>): Array<[string, WarmEngine]> =>
  [...engines.filter(([, warm]) => !watched(warm)), ...engines.filter(([, warm]) => watched(warm))];

/** A person opened or read a conversation: its idle engines become the most recently used. */
function touchWarm(threadId: string): void {
  const touched = [...warmEngines].filter(([, warm]) => warm.threadId === threadId);
  for (const [key, warm] of touched) {
    warmEngines.delete(key);
    warmEngines.set(key, warm);
  }
}
onThreadSeen(touchWarm);

/** Every per-chat engine idle now, with when it went idle: what the timer tracks. */
const armed = new Map<string, { engine: WarmEngine; since: number; timer: ReturnType<typeof setTimeout> }>();

/** Closes an idle engine after `ms`, or sooner on a small box or past the idle engine cap once another engine goes idle after it. */
export function armIdleClose(key: string, ms: number, engine: WarmEngine, now: number = Date.now()): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    if (armed.get(key)?.timer !== timer) return;
    armed.delete(key);
    if (!engine.idle() || engine.held?.()) return;
    engine.close();
  }, ms);
  timer.unref?.();
  armed.set(key, { engine, since: now, timer });
  keepWarm(key, engine);
  return timer;
}

export function stopIdleClose(key: string, timer: ReturnType<typeof setTimeout> | null): void {
  if (timer) clearTimeout(timer);
  const entry = armed.get(key);
  if (timer && entry && entry.timer !== timer) return;
  warmEngines.delete(key);
  armed.delete(key);
}

export function warmEngineKeys(): string[] {
  return [...warmEngines.keys()];
}

export const armedIdleCount = (): number => armed.size;

/** A person wrote in, opened or read the thread this recently: it is the conversation in front of them. */
const WATCHED_MS = 30 * 60_000;
/** A thread nobody has in front of them (a teammate's delegated work, a routine) keeps its engine this long. */
export const UNWATCHED_IDLE_MS = 30_000;

/** An engine started before any message (a person just made a conversation) waits this long for the first one: the time
 * an engine nobody is looking at is already kept, and longer than writing a first line usually takes. */
export const PRESTART_IDLE_MS = UNWATCHED_IDLE_MS;
/** Each waiting engine holds 250 to 450 MB, so only this many wait at once. */
export const PRESTART_MOST = 2;

/** Engines start ahead of a first message only where memory is not rationed: never on a small box, and never where turns wait
 * for room (a Cloud home, a self-hosted server), whose admission counts the engines a turn starts. */
export function prestartAllowed(box: Pick<BoxMemory, "bytes"> = boxMemory(), memory: Pick<EngineMemory, "enabled"> = engineMemory): boolean {
  return !memory.enabled && box.bytes > SMALL_BOX_BYTES;
}

/**
 * How long one thread's idle engine stays up after a turn. Where turns wait for room (a Cloud home, a self-hosted Linux
 * server): briefly for a thread no person has had in front of them lately, and for the one they have, the configured time
 * scaled by the memory left (down to a tenth). Elsewhere the configured time.
 */
export function engineIdleMs(threadId: string, policy: SessionIdlePolicy, memory: Pick<EngineMemory, "enabled" | "headroom"> = engineMemory,
  now: number = Date.now()): number {
  if (!memory.enabled) return policy.idleMs;
  if (!seenWithin(threadId, WATCHED_MS, now)) return Math.max(policy.minimumMs, Math.min(policy.idleMs, UNWATCHED_IDLE_MS));
  return Math.max(policy.minimumMs, Math.round(policy.idleMs * memory.headroom()));
}

/** Whether this thread's engine (`pid`, the process that exited) was just stopped to make room, or for want of it: a
 * driver does not start it again at once, into the same shortage. */
export const stoppedForRoom = (threadId: string, pid?: number): boolean => engineMemory.stoppedForRoom(threadId, pid);
