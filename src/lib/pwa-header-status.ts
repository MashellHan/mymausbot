export interface HeaderStatusInput {
  remotePwa: boolean;
  connected: boolean;
  cachedHydrated: boolean;
  busy: boolean;
  waitingOnYou: boolean;
}

export type HeaderStatusTone = "none" | "offline-cached" | "waiting" | "streaming";

export interface HeaderStatusCue {
  tone: HeaderStatusTone;
  dotClass: string;
  labelKey?: "liveConnection.offline" | "task.waiting" | "chat.activity.working";
}

/**
 * Calm, token-pure header status cue for Remote PWA phones: avoids noisy count badges and surfaces
 * only actionable connection or turn state.
 */
export function resolvePwaHeaderStatus(input: HeaderStatusInput): HeaderStatusCue {
  if (!input.remotePwa) {
    return { tone: "none", dotClass: "" };
  }
  if (!input.connected && input.cachedHydrated) {
    return {
      tone: "offline-cached",
      dotClass: "bg-ink-tertiary",
      labelKey: "liveConnection.offline",
    };
  }
  if (input.waitingOnYou) {
    return {
      tone: "waiting",
      dotClass: "bg-warning",
      labelKey: "task.waiting",
    };
  }
  if (input.busy) {
    return {
      tone: "streaming",
      dotClass: "bg-success animate-status-pulse motion-reduce:animate-none",
      labelKey: "chat.activity.working",
    };
  }
  return { tone: "none", dotClass: "" };
}

export const MOBILE_HEADER_BUTTON_CLASS =
  "flex size-9 touch:size-11 shrink-0 items-center justify-center rounded-full border border-hairline bg-card text-ink hover:bg-raised active:scale-95 transition-[transform,background-color] duration-100 motion-reduce:transition-none";

export const MOBILE_DRAWER_TRIGGER_CLASS =
  "absolute left-3 top-[max(0.75rem,calc(env(safe-area-inset-top,0px)+0.5rem))] z-30 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink max-md:flex max-md:size-9 max-md:touch:size-11 max-md:items-center max-md:justify-center max-md:rounded-full max-md:border max-md:border-hairline max-md:bg-card max-md:p-0 max-md:text-ink max-md:active:scale-95 md:hidden";
