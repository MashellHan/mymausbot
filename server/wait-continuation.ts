import type { Message } from "./store.ts";

export type MessageLookup = (id: string) => Message | null | undefined;

const LEGACY_WAIT_ANCESTORS = 200;

function legacyWaitText(message: Message): string | undefined {
  if (message.kind !== "text" || !message.text?.startsWith("[Wait finished: ") || message.sender || message.sendId || message.via || message.relayed || message.peerAsk) return undefined;
  return message.text;
}

export function isWaitContinuation(message: Message, lookup?: MessageLookup): boolean {
  if (message.role !== "user" || message.kind !== "text" || !message.automated) return false;
  if (message.waitContinuation) return true;
  const text = legacyWaitText(message);
  if (!lookup || !text) return false;

  const unmatchedInputs = [text];
  const seen = new Set([message.id]);
  let id = message.parentId;
  while (id && !seen.has(id) && seen.size <= LEGACY_WAIT_ANCESTORS) {
    seen.add(id);
    const parent = lookup(id);
    if (!parent) break;
    if (parent.role === "user" && parent.automated && !parent.waitContinuation) {
      const earlier = legacyWaitText(parent);
      if (!earlier) break;
      unmatchedInputs.push(earlier);
    } else if (parent.wait?.status === "fired") {
      const label = parent.textParams?.label ?? /^(.*?): done\. /s.exec(parent.text ?? "")?.[1];
      if (typeof label === "string") {
        const prefix = `[Wait finished: ${label}] `;
        const match = unmatchedInputs.findIndex((input) => input.startsWith(prefix) && input.length > prefix.length);
        if (match >= 0) unmatchedInputs.splice(match, 1);
        if (!unmatchedInputs.length) return true;
      }
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
