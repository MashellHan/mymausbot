import { cn } from "./cn";

export interface ComposerDockClassOptions {
  simpleDock: boolean;
}

/** Bottom padding honors iOS safe-area-inset-bottom while resting and collapses cleanly via `.pwa-composer-dock` when the OS keyboard opens. */
export function composerDockClass({ simpleDock }: ComposerDockClassOptions): string {
  return cn(
    "pwa-composer-dock pointer-events-none relative px-5 max-md:px-3",
    simpleDock ? "pb-4" : "pb-3",
  );
}

/** Keeps desktop buttons compact (`28px`/`32px`) while enlarging coarse-pointer phone controls to comfortable `40px` touch targets. */
export function composerActionSizeClass(simpleDock: boolean): string {
  return simpleDock ? "size-7 touch:size-10" : "size-8 touch:size-10";
}
