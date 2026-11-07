import { useEffect, useRef, useState } from "react";
import { usePageVisible } from "@/lib/page-visible";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api, useStore } from "@/state/store";
import type { MiniAppDefaultsResult } from "../../../shared/mini-apps";
import bookkeepingHtml from "../../../examples/mini-apps/bookkeeping/index.html?raw";
import { miniAppNativeFrameGuard } from "./native-frame-guard";

let pending: Promise<MiniAppDefaultsResult> | null = null;
const RETRY_DELAYS_MS = [2_000, 10_000] as const;

export function ensureMiniAppDefaults(): Promise<MiniAppDefaultsResult> {
  if (pending) return pending;
  const request = api<MiniAppDefaultsResult>("/api/mini-apps/defaults", {
    method: "POST", body: JSON.stringify({ bookkeepingHtml }), timeoutMs: 30_000,
  });
  pending = request;
  void request.then(() => { if (pending === request) pending = null; }, () => { if (pending === request) pending = null; });
  return request;
}

export function MiniAppDefaultsBootstrap() {
  const { state } = useStore();
  const owner = useOwnerOrAdmin();
  const visible = usePageVisible();
  const nativeGuard = miniAppNativeFrameGuard();
  const localPage = typeof window !== "undefined" && window.ogb?.app?.ownPage === true;
  const started = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const eligible = state.connected && visible && owner === true && nativeGuard && localPage;

  useEffect(() => {
    if (!eligible || started.current) return;
    started.current = true;
    let active = true;
    let settled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    void ensureMiniAppDefaults().then(() => { settled = true; }, (cause: unknown) => {
      settled = true;
      if (!active) return;
      started.current = false;
      const status = cause && typeof cause === "object" && "status" in cause ? Number(cause.status) : null;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || status !== null && Number.isInteger(status) && status >= 400 && status < 500) return;
      retry = setTimeout(() => { retry = null; setAttempt(attempt + 1); }, delay);
    });
    return () => {
      active = false;
      if (retry) clearTimeout(retry);
      if (!settled) started.current = false;
    };
  }, [eligible, attempt]);

  return null;
}
