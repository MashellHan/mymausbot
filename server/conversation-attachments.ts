import { basename } from "node:path";

import { splitTranscriptAttachments } from "../src/lib/composer-attachments.ts";
import type { Message } from "./store.ts";

export interface ConversationAttachment { path: string; name: string }

type Line = Partial<Pick<Message, "kind">> & Pick<
  Message,
  | "role"
  | "text"
  | "attachments"
  | "from"
  | "roomRequest"
  | "threadPost"
  | "via"
  | "relayed"
  | "relay"
  | "inbox"
  | "automated"
  | "automation"
  | "fromApp"
  | "webhookPost"
  | "peerPost"
  | "peerAsk"
  | "aside"
  | "serverCard"
  | "setupSuggestion"
  | "settingsCard"
  | "setupRequest"
  | "app"
  | "widget"
  | "card"
  | "reaction"
  | "routineRun"
  | "burst"
  | "goalRun"
  | "call"
  | "connector"
  | "secret"
  | "signIn"
  | "sender"
>;

function hasSyntheticProvenance(message: Line): boolean {
  if (message.kind !== undefined && message.kind !== "text") return true;
  if (message.role !== "user" && message.role !== "bot") return true;
  return Boolean(
    message.relayed
    || message.relay
    || message.inbox
    || message.automated
    || message.automation
    || message.fromApp
    || message.webhookPost
    || message.peerPost
    || message.peerAsk
    || message.aside
    || message.roomRequest
    || message.threadPost
    || message.via
    || message.serverCard
    || message.setupSuggestion
    || message.settingsCard
    || message.setupRequest
    || message.app
    || message.widget
    || message.card
    || message.reaction
    || message.routineRun
    || message.burst
    || message.goalRun
    || message.call
    || message.connector
    || message.secret
    || message.signIn,
  );
}

/** The stored files of one conversation: what the person attached to their own messages, and a bot's attach_file copies
 * already shown in it. A bot may pass these on by their exact path; the rest of the attachment store, which holds
 * every conversation's files, stays out of reach. Security: a tag is text anyone typing in the chat controls, so a path
 * counts only inside the attachment store (server/bot-attachment.ts) and only from genuine user messages. */
export function conversationAttachments(messages: readonly Line[]): ConversationAttachment[] {
  const found = new Map<string, string>();
  const record = (path: string, name: string) => {
    // Re-insert so repeated attachments keep the last occurrence and display name in conversational order.
    found.delete(path);
    found.set(path, name);
  };
  for (const message of messages) {
    if (hasSyntheticProvenance(message)) continue;
    const isDirectUser = message.role === "user" && !message.from;
    const isBotMessage = message.role === "bot";
    if (!isDirectUser && !isBotMessage) continue;
    for (const file of message.attachments ?? []) {
      if (file.kind === "audio") continue;
      if ("fromTool" in file && file.fromTool === true) continue;
      record(file.path, file.name ?? basename(file.path));
    }
    if (!isDirectUser || !message.text) continue;
    const { images, files } = splitTranscriptAttachments(message.text, false, false);
    for (const file of [...images, ...files]) record(file.path, file.name);
  }
  return [...found].map(([path, name]) => ({ path, name }));
}
