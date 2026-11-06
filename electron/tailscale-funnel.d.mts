export type TailscaleFunnelState =
  | { status: "ready"; origin: string }
  | { status: "unavailable"; reason: "not-running" | "not-configured" | "unverified" | "blocked" };

/** Local desktop only. Reads an existing Funnel and checks its server identity; never opens a tunnel. */
export interface TailscaleFunnelBridge {
  status(): Promise<TailscaleFunnelState>;
}
