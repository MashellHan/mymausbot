import { createHash, randomBytes } from "node:crypto";
import { LOCAL_AGENT_ACTIVITY_HISTORY_CURSOR } from "../shared/local-dashboard.ts";
import type { LocalAgentActivityEvent, LocalAgentActivityHistoryRequest, LocalAgentActivityResponse } from "../shared/local-dashboard.ts";

export const MAX_ACTIVITY_EVENTS = 60;
export const MAX_ACTIVITY_TOOL_EVENTS = 30;
export const MAX_ACTIVITY_HISTORY_EVENTS = 360;
export const isToolActivity = (event: LocalAgentActivityEvent) => event.kind === "tool-call" || event.kind === "tool-result";

export type ActivityHistorySource = { file: string; path: string; size: number; revision: string; branch?: ReadonlySet<string> };
export type ActivityHistoryRead = { events: LocalAgentActivityEvent[]; truncated: boolean; historySource?: ActivityHistorySource };
type Stream = { id: string; occupantId: string; file: string; size: number; revision: string; leaf?: string;
  events: ReadonlyMap<string, string>; anchors: Set<string> };

export function unavailableActivityHistory(agentId: string): LocalAgentActivityResponse {
  return { agentId, status: "unavailable", updatedAt: null, truncated: false, events: [],
    history: { version: 1, streamId: null, nextBefore: null } };
}

function continues(stream: Stream, request: LocalAgentActivityHistoryRequest, source: ActivityHistorySource,
  events: ReadonlyMap<string, string>): boolean {
  if (stream.occupantId !== request.occupantId || stream.file !== source.file || stream.size > source.size ||
      (stream.size === source.size && stream.revision !== source.revision) ||
      (stream.leaf !== undefined && !source.branch?.has(stream.leaf))) return false;
  for (const anchor of stream.anchors) if (!events.has(anchor)) return false;
  let overlap = false;
  for (const [id, fingerprint] of events) {
    const previous = stream.events.get(id);
    if (previous === undefined) continue;
    if (previous !== fingerprint) return false;
    overlap = true;
  }
  return overlap || !stream.events.size;
}

export function createActivityHistory() {
  const streams = new Map<string, Stream>();
  return (agentId: string, request: LocalAgentActivityHistoryRequest, read: ActivityHistoryRead, updatedAt: number): LocalAgentActivityResponse => {
    const source = read.historySource;
    if (!source) return unavailableActivityHistory(agentId);
    const events = new Map(read.events.map((event) => [event.id,
      createHash("sha256").update(JSON.stringify(event)).digest("base64url")]));
    const prior = streams.get(agentId);
    const continuing = prior && continues(prior, request, source, events);
    let stream: Stream, end: number;
    if (request.before !== undefined) {
      const cursor = LOCAL_AGENT_ACTIVITY_HISTORY_CURSOR.exec(request.before);
      if (!prior || !cursor || cursor[1] !== prior.id || prior.occupantId !== request.occupantId ||
          !prior.anchors.has(cursor[2]!)) return unavailableActivityHistory(agentId);
      if (!continuing) {
        streams.delete(agentId);
        return unavailableActivityHistory(agentId);
      }
      stream = prior;
      end = read.events.findIndex((event) => event.id === cursor[2]);
      if (end < 0) return unavailableActivityHistory(agentId);
    } else {
      stream = { id: continuing ? prior.id : randomBytes(16).toString("hex"), occupantId: request.occupantId,
        file: source.file, size: source.size, revision: source.revision, leaf: source.branch?.values().next().value,
        events, anchors: continuing ? prior.anchors : new Set() };
      end = read.events.length;
      streams.delete(agentId);
      streams.set(agentId, stream);
      if (streams.size > 64) streams.delete(streams.keys().next().value!);
    }
    const first = Math.max(0, end - MAX_ACTIVITY_EVENTS);
    const anchor = first > 0 ? read.events[first]!.id : null;
    if (anchor) stream.anchors.add(anchor);
    return { agentId, status: "ready", updatedAt, truncated: read.truncated, events: read.events.slice(first, end),
      history: { version: 1, streamId: stream.id, nextBefore: anchor ? `${stream.id}.${anchor}` : null } };
  };
}
