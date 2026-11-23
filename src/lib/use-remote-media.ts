import { useEffect, useState } from "react";

import {
  clearCachedMediaBlob,
  getPwaAuth,
  isRelayMediaPath,
  isRemotePwaMode,
  resolveRemoteMediaUrl,
} from "./pwa-config";

export function useRemoteMediaUrl(
  src: string | null | undefined,
  attempt = 0,
): { url: string | null; loading: boolean; failed: boolean } {
  const needsRemoteResolution = Boolean(src && isRemotePwaMode() && isRelayMediaPath(src));
  const [resolved, setResolved] = useState<{ src: string; attempt: number; url: string | null; failed: boolean } | null>(null);

  useEffect(() => {
    if (!needsRemoteResolution || !src) return;
    let active = true;
    if (attempt > 0 && getPwaAuth()) {
      clearCachedMediaBlob(src);
    }
    void resolveRemoteMediaUrl(src).then(
      (url) => {
        if (active) setResolved({ src, attempt, url, failed: false });
      },
      () => {
        if (active) setResolved({ src, attempt, url: null, failed: true });
      },
    );
    return () => {
      active = false;
    };
  }, [src, needsRemoteResolution, attempt]);

  if (!src) return { url: null, loading: false, failed: false };
  if (!needsRemoteResolution) return { url: src, loading: false, failed: false };
  if (resolved && resolved.src === src && resolved.attempt === attempt) {
    return { url: resolved.url, loading: false, failed: resolved.failed };
  }
  return { url: null, loading: true, failed: false };
}
