import { useEffect, useRef } from "react";
import { usePageVisible } from "@/lib/page-visible";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api, useStore } from "@/state/store";
import type { MiniAppDefaultsResult } from "../../../shared/mini-apps";
import bookkeepingHtml from "../../../examples/mini-apps/bookkeeping/index.html?raw";
import { miniAppNativeFrameGuard } from "./native-frame-guard";

let pending: Promise<MiniAppDefaultsResult> | null = null;

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

  useEffect(() => {
    if (!state.connected || !visible || owner !== true || !nativeGuard || !localPage || started.current) return;
    started.current = true;
    void ensureMiniAppDefaults().catch(() => { started.current = false; });
  }, [state.connected, visible, owner, nativeGuard, localPage]);

  return null;
}
