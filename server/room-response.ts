import { isMentionBoundary, isMentionNameContinuation } from "../shared/mention-boundary.ts";
import { resolveMentions } from "../shared/room-mentions.ts";
import type { GroupDefaultResponder, WireGroup } from "../shared/wire.ts";

export function normalizeGroupDefaultResponder(
  value: unknown,
  memberIds: string[],
  dm = false,
): GroupDefaultResponder {
  if (dm) return { kind: "mentions" };
  if (value && typeof value === "object") {
    const candidate = value as { kind?: unknown; botId?: unknown; fallbackBotId?: unknown };
    if (candidate.kind === "everyone") return { kind: "everyone" };
    if (candidate.kind === "mentions") return { kind: "mentions" };
    if (candidate.kind === "auto") {
      return typeof candidate.fallbackBotId === "string" && memberIds.includes(candidate.fallbackBotId)
        ? { kind: "auto", fallbackBotId: candidate.fallbackBotId }
        : { kind: "auto" };
    }
    if (
      candidate.kind === "member" &&
      typeof candidate.botId === "string" &&
      memberIds.includes(candidate.botId)
    ) {
      return { kind: "member", botId: candidate.botId };
    }
  }
  if (memberIds.length === 0) return { kind: "mentions" };
  return { kind: "member", botId: memberIds[0] };
}

export function roomResponders<T extends { id: string; name: string; hidden?: boolean }>(
  text: string,
  members: T[],
  defaultResponder: GroupDefaultResponder,
  picked: readonly string[] = [],
): T[] {
  const available = members.filter((member) => !member.hidden);
  const everyone = "everyone";
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    const candidate = text.slice(at + 1, at + 1 + everyone.length);
    if (
      isMentionBoundary(text, at) &&
      candidate.toLocaleLowerCase() === everyone &&
      !isMentionNameContinuation(text.slice(at + 1 + everyone.length))
    ) {
      return available;
    }
  }
  const { bots, ambiguous } = resolveMentions(text, available, picked);
  const mentioned = bots.filter((bot) => !ambiguous.some((sharing) => sharing.includes(bot)));
  if (mentioned.length) return mentioned;
  if (defaultResponder.kind === "everyone") return available;
  if (defaultResponder.kind === "member") {
    const lead = available.find((member) => member.id === defaultResponder.botId);
    return lead ? [lead] : [];
  }
  if (defaultResponder.kind === "auto") {
    const fallback = available.find((member) => member.id === defaultResponder.fallbackBotId) ?? available[0];
    return fallback ? [fallback] : [];
  }
  return [];
}

export function pruneRoomHolds(group: Pick<WireGroup, "memberIds" | "holds" | "heldMessages">): void {
  for (const key of ["holds", "heldMessages"] as const) {
    const map = group[key];
    if (!map) continue;
    const kept = Object.fromEntries(Object.entries(map).filter(([botId]) => group.memberIds.includes(botId)));
    if (Object.keys(kept).length !== Object.keys(map).length) (group as Record<typeof key, unknown>)[key] = kept;
  }
}
