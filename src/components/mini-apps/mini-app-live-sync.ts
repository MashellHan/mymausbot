import { useEffect } from "react";
import { listenLiveFrames } from "@/lib/live-events";
import type { MiniAppState } from "../../../shared/mini-apps";

export const MINI_APP_UPDATE_CHECK_TTL_MS = 30 * 60_000;
export const MINI_APP_FALLBACK_POLL_MS = 120_000;

export function shouldCheckMiniAppUpdate(
  lastCheckedAt: number | undefined,
  now: number,
  manual: boolean,
): boolean {
  if (manual) return true;
  return lastCheckedAt === undefined || now - lastCheckedAt >= MINI_APP_UPDATE_CHECK_TTL_MS;
}

export function applyMiniAppDataChanged(
  current: MiniAppState | null,
  datasetId: string,
  revision: number,
): MiniAppState | null {
  if (!current) return null;
  const idx = current.data.findIndex((entry) => entry.datasetId === datasetId);
  if (idx === -1 || current.data[idx]!.revision >= revision) return null;
  const nextData = current.data.map((entry, i) => (i === idx ? { ...entry, revision } : entry));
  return { ...current, data: nextData };
}

export function useMiniAppLiveSync(options: {
  enabled: boolean;
  onAppChanged: (event: { appId: string; revision: number; templateVersion: number; status: "active" | "archived" }) => void;
  onDataChanged: (event: { datasetId: string; revision: number }) => void;
  onMissed: () => void;
}): void {
  const { enabled, onAppChanged, onDataChanged, onMissed } = options;
  useEffect(() => {
    if (!enabled) return;
    return listenLiveFrames({
      onFrame: (frame) => {
        if (frame.kind === "mini-app.changed") {
          onAppChanged(frame);
        } else if (frame.kind === "mini-app.data-changed") {
          onDataChanged(frame);
        }
      },
      onMissedFrames: onMissed,
    });
  }, [enabled, onAppChanged, onDataChanged, onMissed]);
}
