import { createHash } from "node:crypto";

export function localAgentOccupantId(agent: Record<string, unknown>, paneId: string): string | null {
  const session = agent.agent_session;
  if (!session || typeof session !== "object" || Array.isArray(session)) return null;
  const { source, value } = session as Record<string, unknown>;
  if (typeof source !== "string" || !source || typeof value !== "string" || !value ||
      typeof agent.name !== "string" || !agent.name) return null;
  const digest = createHash("sha256").update(`${paneId}\0${agent.name}\0${source}\0${value}`).digest("hex").slice(0, 16);
  return `o${digest}`;
}
