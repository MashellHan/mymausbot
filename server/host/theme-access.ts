// Who may use or undo app_settings theme actions on a turn, and which conversation attachments they can draw from.
import { basename } from "node:path";

import { atLeast, type BotAccessLevel } from "../../shared/bot-access.ts";
import type { VisibleSet, PathSubject, ThreadOwner } from "../bot-visibility.ts";
import { conversationAttachments, type ConversationAttachment } from "../conversation-attachments.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Message } from "../store.ts";

export interface ThemeAccessDeps {
  cloudTeam: boolean;
  attachmentsDir: string;
  fenced(threadId: string): boolean;
  turnOwner(turn: { botId: string; threadId: string; generation: string }): string | null;
  actingRequester(threadId: string, generation: string): string | null;
  isShareKey(person: string): boolean;
  peopleList(): ReadonlyArray<{ email: string; role: string }>;
  personGone(email: string): boolean;
  liveSessions(): ReadonlyArray<{ email?: string; teamRole?: string; id: string }>;
  visibleTo(viewer: { kind: "all" | "member"; email?: string }): VisibleSet;
  threadOwner(threadId: string): ThreadOwner | undefined;
  roomBots(groupId: string): readonly string[];
  subjectVisible(subject: PathSubject, visible: VisibleSet): boolean;
  messageFileRootsForThread(botId: string, threadId: string): string[];
  activeBranch(threadId: string): readonly Message[];
}

export function createThemeAccess(deps: ThemeAccessDeps) {
  function viewerForTurn(turn: { botId: string; threadId: string; generation: string }): { person: string; visible: VisibleSet } | null {
    if (deps.fenced(turn.threadId)) return null;
    if (!deps.cloudTeam) {
      return deps.turnOwner(turn) ? { person: "owner", visible: deps.visibleTo({ kind: "all" }) } : null;
    }
    const person = deps.actingRequester(turn.threadId, turn.generation);
    if (!person || deps.isShareKey(person)) return null;
    const activeMember = deps.peopleList().find((one) => personKey({ id: "", email: one.email }) === person);
    const liveSession = !activeMember
      ? deps.liveSessions().find((s) => s.email && !deps.personGone(s.email) && personKey({ id: s.id, email: s.email }) === person)
      : undefined;
    const email = activeMember?.email ?? liveSession?.email;
    if (!email) return null;
    const role = activeMember?.role ?? liveSession?.teamRole;
    const visible = deps.visibleTo(role === "owner" || role === "admin" ? { kind: "all", email } : { kind: "member", email });
    if (!visible.thread(turn.threadId)) return null;
    const owner = deps.threadOwner(turn.threadId);
    const botIds = owner?.group ? deps.roomBots(owner.group) : [turn.botId];
    if (botIds.some((id) => !atLeast(visible.level(id) as BotAccessLevel, "chat"))) return null;
    return { person, visible };
  }

  return {
    person(turn: { botId: string; threadId: string; generation: string }): string | null {
      return viewerForTurn(turn)?.person ?? null;
    },
    sources(turn: { botId: string; threadId: string; generation: string }): {
      roots: string[];
      attachmentsDir: string;
      attachments: ConversationAttachment[];
    } {
      const access = viewerForTurn(turn);
      if (!access) return { roots: [], attachmentsDir: deps.attachmentsDir, attachments: [] };
      const raw = conversationAttachments(deps.activeBranch(turn.threadId));
      const attachments = deps.cloudTeam
        ? raw.filter((one) => {
            const name = basename(one.path);
            return !name || deps.subjectVisible({ kind: "attachment", name }, access.visible);
          })
        : raw;
      return {
        roots: deps.messageFileRootsForThread(turn.botId, turn.threadId).filter((root) => root !== deps.attachmentsDir),
        attachmentsDir: deps.attachmentsDir,
        attachments,
      };
    },
  };
}

export function themeUndoRefusal(deps: {
  cloudTeam: boolean;
  auth: RequestAuth;
  threadId: string;
  requestId: string;
  cardMessage: Message | undefined;
  undoPerson(requestId: string): string | undefined;
  cardRequesterKey(threadId: string, requestId: string): string | undefined;
  ownerOrAdmin(auth: RequestAuth): boolean;
  cardAnswerRefusal(auth: RequestAuth, threadId: string, requestId: string, behavior: "allow"): string | null;
}): string | null {
  const card = deps.cardMessage?.card;
  if (!card?.appSettingRequest) return deps.cardAnswerRefusal(deps.auth, deps.threadId, deps.requestId, "allow");
  if (deps.cloudTeam && card.appSettingRequest.settingId === "appearance.theme") {
    const owner = deps.undoPerson(deps.requestId) ?? deps.cardRequesterKey(deps.threadId, deps.requestId);
    return deps.auth.kind !== "session" || !owner || personKey(deps.auth.session) !== owner
      ? "Only the person who made this theme change can undo it."
      : null;
  }
  return !deps.ownerOrAdmin(deps.auth)
    ? "Only the owner can undo an app setting."
    : deps.cardAnswerRefusal(deps.auth, deps.threadId, deps.requestId, "allow");
}
