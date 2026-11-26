import { describe, expect, it } from "vitest";

import type { Message } from "../store.ts";
import { messagePages, pageMessage, TOOL_OUTPUT_PREVIEW } from "./message-pages.ts";

const step = (output: string | undefined, extra: Partial<Message> = {}): Message => ({
  id: "m1", role: "bot", kind: "activity", at: 1, text: "", turnId: "t1",
  tool: { name: "Read", ok: true, summary: "read notes.md", input: JSON.stringify({ path: "notes.md", text: "x".repeat(5_000) }), output },
  ...extra,
} as Message);

describe("pageMessage", () => {
  it("keeps the branch for a Wait retry without exposing the recovery prompt", () => {
    const input: Message = { id: "retry", at: 2, parentId: "previous", role: "user", kind: "text", automated: true, waitContinuation: true, text: "Resume the run after restarting." };
    expect(pageMessage(input)).toEqual({ id: "retry", at: 2, parentId: "previous", role: "user", kind: "text", automated: true, waitContinuation: true });
    expect(input.text).toBe("Resume the run after restarting.");
  });

  it("preserves a separately automated line whose Wait-like words have no matching notice", () => {
    const input: Message = { id: "hook", at: 2, parentId: "old", role: "user", kind: "text", automated: true, text: "[Wait finished: the sample] A webhook's own message." };
    const previous: Message = { id: "old", at: 1, role: "bot", kind: "text", text: "different wait: done. The file is ready.", wait: { id: "other", status: "fired" } };
    expect(pageMessage(input, () => previous)).toBe(input);
  });

  it("leaves a step whose output fits the preview exactly as stored", () => {
    for (const output of [undefined, "", "short", "y".repeat(TOOL_OUTPUT_PREVIEW)]) {
      const message = step(output);
      expect(pageMessage(message)).toBe(message);
    }
  });

  it("cuts a long output to its start, marks it clipped and keeps everything else", () => {
    const message = step("z".repeat(6_000));
    const paged = pageMessage(message) as Message;
    expect(paged.tool).toEqual({ ...message.tool, output: "z".repeat(TOOL_OUTPUT_PREVIEW), clipped: true });
    expect(paged.tool!.input).toBe(message.tool!.input);
    expect({ ...paged, tool: undefined }).toEqual({ ...message, tool: undefined });
    expect(message.tool!.output).toHaveLength(6_000);
    expect(message.tool).not.toHaveProperty("clipped");
  });

  it("never splits a surrogate pair at the cut", () => {
    const output = `${"a".repeat(TOOL_OUTPUT_PREVIEW - 1)}😀${"b".repeat(50)}`;
    const paged = pageMessage(step(output)) as Message;
    expect(paged.tool!.output).toBe("a".repeat(TOOL_OUTPUT_PREVIEW - 1));
    expect(paged.tool).toHaveProperty("clipped", true);
  });

  it("keeps whole the rows whose output is the reply itself", () => {
    const long = "r".repeat(6_000);
    const rows: Array<Partial<Message>> = [
      { relay: { kind: "told", email: "bob@example.com", name: "Bob" } },
      { roomRequest: { id: "q1", phase: "result" } },
      { comm: { groupId: "g1", withBotId: "b2", withName: "Ada", withColor: "blue" } },
      { threadRef: { botId: "b1", threadId: "th2", title: "Side job" } },
      { kind: "text" },
    ];
    for (const extra of rows) {
      const message = step(long, extra);
      expect(pageMessage(message)).toBe(message);
    }
  });

  it("still drops a screen's picture", () => {
    const screen = { id: "s1", role: "bot", kind: "screen", at: 1, text: "", png: "iVBOR" } as Message;
    expect(pageMessage(screen)).toEqual({ id: "s1", role: "bot", kind: "screen", at: 1, text: "", hasImage: true });
  });
});

it("keeps historical reply lineage while hiding a generated Wait continuation across pages", () => {
  const notice: Message = {
    id: "notice", role: "bot", kind: "text", at: 1, text: "Report: done. The file is ready.",
    wait: { id: "wait-1", status: "fired" },
  };
  const typed: Message = {
    id: "typed", role: "user", kind: "text", at: 2, parentId: notice.id,
    text: "[Wait finished: Report] Please take a look.",
  };
  const continuation: Message = {
    id: "generated", role: "user", kind: "text", at: 3, parentId: typed.id, automated: true,
    text: "[Wait finished: Report] Read the sample and summarize it.",
  };
  const reply: Message = {
    id: "reply", role: "user", kind: "text", at: 4, parentId: continuation.id, replyToId: continuation.id,
    text: "Which report?",
  };
  const rows = [notice, typed, continuation, reply];
  const byId = new Map(rows.map((message) => [message.id, message]));
  const { messagePage, messageWindow, wireMessage } = messagePages({
    messagesFor: () => rows,
    messagesTail: (_threadId, limit) => ({
      messages: rows.slice(-limit), hasMore: rows.length > limit, activeLeafId: reply.id,
    }),
    messagesBefore: (_threadId, before, limit) => {
      const end = rows.findIndex((msg) => msg.id === before);
      if (end < 0) return null;
      const start = Math.max(0, end - limit);
      return { messages: rows.slice(start, end), hasMore: start > 0, activeLeafId: reply.id };
    },
    activeLeaf: () => reply.id,
  }, (_threadId, id) => byId.get(id) ?? null);
  const placeholder: Message = {
    id: continuation.id, at: continuation.at, parentId: typed.id, role: "user", kind: "text",
    automated: true, waitContinuation: true,
  };

  expect(messagePage("thread", undefined)).toEqual({ messages: [notice, typed, placeholder, reply], activeLeafId: reply.id });
  expect(messagePage("thread", 2)).toEqual({ messages: [placeholder, reply], hasMore: true, activeLeafId: reply.id });
  expect(messagePage("thread", 2, reply.id)).toEqual({ messages: [typed, placeholder], hasMore: true, activeLeafId: reply.id });
  expect(messageWindow("thread", continuation.id, 1)).toEqual({ messages: [placeholder], hasMore: true, activeLeafId: reply.id });
  expect(wireMessage("thread", continuation)).toEqual(placeholder);
  expect(continuation.text).toBe("[Wait finished: Report] Read the sample and summarize it.");
});

it("projects two queued legacy Waits when both notices arrived before either turn started", () => {
  const first: Message = { id: "notice-a", at: 1, role: "bot", kind: "text", text: "Report: done. The report is ready.", wait: { id: "a", status: "fired" } };
  const second: Message = { id: "notice-b", at: 2, parentId: first.id, role: "bot", kind: "text", text: "Package: done. The package is ready.", wait: { id: "b", status: "fired" } };
  const inputA: Message = { id: "input-a", at: 3, parentId: second.id, role: "user", kind: "text", automated: true, text: "[Wait finished: Report] Read the report." };
  const answerA: Message = { id: "answer-a", at: 4, parentId: inputA.id, role: "bot", kind: "text", text: "Summary of the report." };
  const inputB: Message = { id: "input-b", at: 5, parentId: answerA.id, role: "user", kind: "text", automated: true, text: "[Wait finished: Package] Check the package." };
  const byId = new Map([first, second, inputA, answerA, inputB].map((row) => [row.id, row]));
  const lookup = (id: string) => byId.get(id);
  expect(pageMessage(inputA, lookup)).toMatchObject({ waitContinuation: true, parentId: second.id });
  expect(pageMessage(inputB, lookup)).toMatchObject({ waitContinuation: true, parentId: answerA.id });
  expect(pageMessage(inputB, lookup)).not.toHaveProperty("text");

  const typed = { ...inputB, automated: undefined };
  expect(pageMessage(typed, lookup)).toBe(typed);
  byId.set(inputA.id, { ...inputA, text: "[Wait finished: Unknown] An unrelated webhook." });
  expect(pageMessage(inputB, lookup)).toBe(inputB);
});
