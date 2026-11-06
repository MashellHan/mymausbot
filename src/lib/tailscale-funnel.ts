import { useCallback, useEffect, useRef, useState } from "react";
import type { TailscaleFunnelState } from "../../electron/tailscale-funnel.mjs";

export interface TailscaleFunnelConnection {
  checking: boolean;
  state: TailscaleFunnelState | null;
  refresh(): Promise<TailscaleFunnelState>;
}

export function useTailscaleFunnel(enabled: boolean): TailscaleFunnelConnection | null {
  const bridge = enabled && typeof window !== "undefined" ? window.ogb?.tailscaleFunnel : undefined;
  const [state, setState] = useState<TailscaleFunnelState | null>(null);
  const [checking, setChecking] = useState(Boolean(bridge));
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setChecking(true);
    const next = await bridge?.status().catch((): TailscaleFunnelState => ({ status: "unavailable", reason: "unverified" }))
      ?? { status: "unavailable", reason: "not-configured" } as const;
    if (request === generation.current) {
      setState(next);
      setChecking(false);
    }
    return next;
  }, [bridge]);
  useEffect(() => {
    if (bridge) void refresh();
    return () => { generation.current += 1; };
  }, [bridge, refresh]);
  return bridge ? { state, checking, refresh } : null;
}
