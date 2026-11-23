import type { Message, Store } from "../store.ts";
import { waitContinuationPlaceholder, type MessageLookup } from "../wait-continuation.ts";
import { toolResultPrefix } from "../tool-results.ts";

const MESSAGE_PAGE_MAX = 200;
/** How much of a tool step's output a conversation page carries: the rest is fetched when the step is opened, so
 * switching to a conversation full of tool steps stays light. */
export const TOOL_OUTPUT_PREVIEW = 1_000;

/** undefined = absent, null = present but unusable (the caller answers 400). */
export function pageSize(raw: string | null): number | null | undefined {
  if (raw === null) return undefined;
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 0) return null;
  return Math.min(size, MESSAGE_PAGE_MAX);
}

function slimMessage(message: Message, lookup?: MessageLookup): Message | Record<string, unknown> {
  const wait = waitContinuationPlaceholder(message, lookup);
  if (wait) return wait;
  if (message.kind !== "screen" || !message.png) return message;
  const { png: _png, ...rest } = message;
  return { ...rest, hasImage: true };
}

/** A message as a conversation page carries it: slimmed, and a plain tool step's long output cut to a preview marked
 * `clipped`. Input stays whole (labels parse it), and so do rows whose tool output is the reply itself (a teammate's
 * result, a relayed message, a handoff). */
export function pageMessage(message: Message, lookup?: MessageLookup): Message | Record<string, unknown> {
  const slim = slimMessage(message, lookup);
  const tool = message.tool;
  if (!tool || message.kind !== "activity" || message.relay || message.roomRequest || message.comm || message.threadRef) return slim;
  const output = tool.output;
  if (output === undefined || output.length <= TOOL_OUTPUT_PREVIEW) return slim;
  return { ...slim, tool: { ...tool, output: toolResultPrefix(output, TOOL_OUTPUT_PREVIEW), clipped: true } };
}

/** A conversation's messages one page at a time (newest first when `before` is absent), and the page around one message. */
export function messagePages(store: Pick<Store, "messagesFor" | "messagesTail" | "activeLeaf">, readMessage: (threadId: string, id: string) => Message | null) {
  const wireMessage = (threadId: string, message: Message) => slimMessage(message, (id) => readMessage(threadId, id));
  const paged = (threadId: string, messages: Message[]) =>
    messages.map((message) => pageMessage(message, (id) => readMessage(threadId, id)));

  function messagePage(threadId: string, limit: number | undefined, before?: string | null) {
    if (limit === undefined) {
      const lookup = (id: string) => readMessage(threadId, id);
      return {
        messages: store.messagesFor(threadId).map((message) => waitContinuationPlaceholder(message, lookup) ?? message),
        activeLeafId: store.activeLeaf(threadId),
      };
    }
    if (!before) {
      const tail = store.messagesTail(threadId, limit);
      return { messages: paged(threadId, tail.messages), hasMore: tail.hasMore, activeLeafId: tail.activeLeafId };
    }
    const all = store.messagesFor(threadId);
    const end = all.findIndex((msg) => msg.id === before);
    const stop = end === -1 ? all.length : end;
    const start = Math.max(0, stop - limit);
    return {
      messages: paged(threadId, all.slice(start, stop)),
      hasMore: start > 0,
      activeLeafId: store.activeLeaf(threadId),
    };
  }

  function messageWindow(threadId: string, messageId: string, limit: number) {
    const all = store.messagesFor(threadId);
    const index = all.findIndex((message) => message.id === messageId);
    if (index < 0) return null;
    const before = Math.floor((limit - 1) / 2);
    const start = Math.max(0, Math.min(index - before, all.length - limit));
    const stop = Math.min(all.length, start + limit);
    return { messages: paged(threadId, all.slice(start, stop)), hasMore: start > 0 };
  }

  return { messagePage, messageWindow, wireMessage };
}
