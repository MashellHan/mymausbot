import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalAgentActivityResponse, LocalAgentTeamsResponse, LocalUsageResponse } from "../../../shared/local-dashboard";
import type { MiniAppDashboardRead, MiniAppDashboardReadResult, MiniAppDocument, MiniAppState } from "../../../shared/mini-apps";
import { usePageVisible } from "@/lib/page-visible";
import { api, ApiError } from "@/state/store";
import { AgentTeamView } from "../AgentTeamPanel";
import { LocalUsageView } from "../LocalUsagePanel";
import { miniAppNativeFrameGuard } from "./native-frame-guard";

const TEAM_REFRESH_MS = 2_000;
const USAGE_REFRESH_MS = 5 * 60_000;
const unavailableTeams: LocalAgentTeamsResponse = { status: "unavailable", updatedAt: null, teamCount: null, teams: [] };
const unavailableUsage: LocalUsageResponse = {
  status: "unavailable", asOf: null, timeZone: "Asia/Shanghai", sourceCoverage: null,
  prSourceCoverage: null, prCoverage: null, windows: null, trend: [],
};

export function MiniAppDashboard({ document, state, onRevoked, onChanged }: {
  document: MiniAppDocument; state: MiniAppState; onRevoked(): void; onChanged(): void;
}) {
  const visible = usePageVisible();
  const kind = document.app.dashboard?.kind;
  const appId = document.app.id;
  const revision = document.app.revision;
  const callbacks = useRef({ onRevoked, onChanged });
  callbacks.current = { onRevoked, onChanged };
  const [teams, setTeams] = useState<LocalAgentTeamsResponse | null>(null);
  const [usage, setUsage] = useState<LocalUsageResponse | null>(null);
  const valid = miniAppNativeFrameGuard() && document.app.status === "active" && state.status === "active"
    && state.appId === appId && state.revision === revision && document.app.dashboard?.renderer === "native"
    && document.app.dashboard.htmlRole === "fallback-only";

  const read = useCallback(async (body: MiniAppDashboardRead, signal: AbortSignal): Promise<MiniAppDashboardReadResult> => {
    if (!miniAppNativeFrameGuard()) throw new Error("This Mini App requires the guarded desktop window.");
    const result = await api<MiniAppDashboardReadResult>(`/api/mini-apps/${encodeURIComponent(appId)}/dashboard`, {
      method: "POST", body: JSON.stringify(body), background: true, signal, timeoutMs: 5_000,
    });
    if (!miniAppNativeFrameGuard() || result.appId !== appId || result.revision !== revision || result.resource !== body.resource) {
      throw new Error("This app changed while its dashboard was being read.");
    }
    return result;
  }, [appId, revision]);

  const stopFor = useCallback((error: unknown) => {
    if (!miniAppNativeFrameGuard()) { callbacks.current.onRevoked(); return true; }
    if (!(error instanceof ApiError)) return false;
    if (error.status === 401 || error.status === 403 || error.status === 404) { callbacks.current.onRevoked(); return true; }
    if (error.status === 409) { callbacks.current.onChanged(); return true; }
    return false;
  }, []);

  useEffect(() => {
    if (!valid || !visible) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const resource = kind === "agent-team" ? "teams" : "usage";
    const refresh = async () => {
      const started = Date.now();
      try {
        const body: MiniAppDashboardRead = resource === "teams" ? { resource: "teams", expectedRevision: revision }
          : { resource: "usage", expectedRevision: revision };
        const result = await read(body, controller.signal);
        if (!active) return;
        if (result.resource === "teams") setTeams((previous) => result.snapshot.status === "unavailable" && previous?.updatedAt != null
          ? { ...previous, status: "stale" } : result.snapshot);
        else if (result.resource === "usage") setUsage((previous) => result.snapshot.status === "unavailable" && previous?.asOf != null
          ? { ...previous, status: "stale" } : result.snapshot);
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        if (stopFor(error)) { active = false; controller.abort(); return; }
        if (resource === "teams") setTeams((previous) => previous?.updatedAt != null ? { ...previous, status: "stale" } : unavailableTeams);
        else setUsage((previous) => previous?.asOf != null ? { ...previous, status: "stale" } : unavailableUsage);
      } finally {
        if (active) timer = setTimeout(refresh, resource === "teams" ? Math.max(0, TEAM_REFRESH_MS - (Date.now() - started)) : USAGE_REFRESH_MS);
      }
    };
    void refresh();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [kind, read, revision, valid, visible, stopFor]);

  const readActivity = useCallback(async (agentId: string, signal: AbortSignal): Promise<LocalAgentActivityResponse> => {
    try {
      const result = await read({ resource: "activity", expectedRevision: revision, agentId }, signal);
      if (result.resource !== "activity") throw new Error("This app's activity read changed.");
      return result.snapshot;
    } catch (error) {
      if (!signal.aborted) stopFor(error);
      throw error;
    }
  }, [read, revision, stopFor]);

  if (!valid) return null;
  return kind === "agent-team" ? <AgentTeamView snapshot={teams} active={visible} readActivity={readActivity} /> : <LocalUsageView snapshot={usage} />;
}
