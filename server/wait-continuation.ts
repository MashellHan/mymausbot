import type { Message } from "./store.ts";

export type MessageLookup = (id: string) => Message | null | undefined;

export function isWaitContinuation(message: Message, lookup?: MessageLookup): boolean {
  if (message.role !== "user" || message.kind !== "text" || !message.automated) return false;
  if (message.waitContinuation) return true;
  const text = message.text;
  if (!lookup || !text?.startsWith("[Wait finished: ") || message.sender || message.sendId || message.via || message.relayed || message.peerAsk) return false;
  const seen = new Set([message.id]);
  let id = message.parentId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const parent = lookup(id);
    if (!parent || (parent.role === "user" && parent.automated)) break;
    if (parent.wait?.status === "fired") {
      const label = parent.textParams?.label ?? /^(.*?): done\. /s.exec(parent.text ?? "")?.[1];
      const prefix = typeof label === "string" ? `[Wait finished: ${label}] ` : undefined;
      if (prefix && text.startsWith(prefix) && text.length > prefix.length) return true;
    }
    id = parent.parentId;
  }
  return false;
}

export function waitContinuationPlaceholder(message: Message, lookup?: MessageLookup): Message | undefined {
  if (!isWaitContinuation(message, lookup)) return undefined;
  const { id, at, parentId, role, kind } = message;
  return { id, at, parentId, role, kind, automated: true, waitContinuation: true };
}
