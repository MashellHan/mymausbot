import { describe, expect, it } from "vitest";

import type { HandoffView } from "../coordinator.ts";
import type { BotRecord, TaskRecord } from "../store.ts";
import { createInternalThreadRoutes } from "./internal-threads.ts";

const lead = { id: "bot-lead", name: "Lead", section: "Work" } as BotRecord;
const ops = { id: "bot-ops", name: "Ops", section: "Work" } as BotRecord;
const task = (threadId: string, title: string, openedBy?: unknown) => ({ threadId, title, createdAt: 1, openedBy }) as TaskRecord;
const handoff = { id: "h-42", rootId: "h-1", parentId: "h-1", threadId: "t-ops-new", botId: "bot-ops", status: "queued" } as HandoffView;
const tasks: Record<string, TaskRecord[]> = {
  "bot-lead": [task("t-lead", "Lead main")],
  "bot-ops": [task("t-ops-busy", "Weekly report"), task("t-ops-new", "Export CSV", { botId: "bot-lead", name: "Lead", at: 5 })],
};

async function listThreads(from: BotRecord) {
  const route = createInternalThreadRoutes({
    store: { bot: (id: string) => [lead, ops].find((bot) => bot.id === id), bots: [lead, ops], tasks: (id: string) => tasks[id] ?? [] } as never,
    coordinator: { awaitingAnswer: () => false, parkedDirect: () => undefined, activeDirect: (threadId: string) => threadId === "t-ops-new" ? handoff : undefined, active: () => [handoff] } as never,
    from, fromThreadId: "t-own", ownsThread: () => true, shown: () => true,
    threadBusy: (_bot, threadId) => threadId === "t-ops-busy", queuedThreadPosition: () => null,
    queuedReason: (node, showTitle) => `${node.id} waits${showTitle ? " (titles)" : ""}`,
    personRequestedWithdrawal: () => true, samePerson: () => true, waitingForPerson: () => false, stopWaiting: async () => {},
  });
  let body: { threads: Array<Record<string, unknown>> } | undefined;
  await route({ res: {}, path: "/api/internal/threads", method: "GET", json: (_res: unknown, _status: number, value: never) => { body = value; } } as never);
  return body!.threads;
}

describe("list_threads on a queued handoff", () => {
  it("tells the sender why it waits and which handoff it is, without the receiver's thread titles", async () => {
    const row = (await listThreads(lead)).find((thread) => thread.threadId === "t-ops-new");
    expect(row).toMatchObject({ state: "queued", waiting: "h-42 waits", delegationId: "h-42", own: false });
  });

  it("lets the receiver name its own busy threads, and adds nothing to a thread that is not queued", async () => {
    const rows = await listThreads(ops);
    expect(rows.find((thread) => thread.threadId === "t-ops-new")).toMatchObject({ state: "queued", waiting: "h-42 waits (titles)", delegationId: "h-42", own: true });
    const running = rows.find((thread) => thread.threadId === "t-ops-busy");
    expect(running).toMatchObject({ state: "running" });
    expect(running).not.toHaveProperty("waiting");
  });
});

describe("withdraw_waiting_thread", () => {
  const source = task("t-source", "Current request");
  const first = task("t-first", "Old question");
  const second = task("t-second", "Other question");
  const peer = task("t-peer", "Peer question");
  const base = (): Parameters<typeof createInternalThreadRoutes>[0] => ({
    store: {
      bot: (id: string) => [lead, ops].find((bot) => bot.id === id), bots: [lead, ops],
      tasks: (id: string) => id === lead.id ? [source, first, second] : [peer],
      taskByThread: (id: string, threadId: string) => (id === lead.id ? [source, first, second] : [peer]).find((row) => row.threadId === threadId),
    } as never,
    coordinator: { awaitingAnswer: () => false, parkedDirect: () => undefined, activeDirect: () => false, active: () => [] } as never,
    from: lead, fromThreadId: source.threadId, ownsThread: () => true, shown: () => true,
    threadBusy: () => false, queuedThreadPosition: () => null, queuedReason: () => "",
    personRequestedWithdrawal: () => true, samePerson: () => true, waitingForPerson: () => true, stopWaiting: async () => {},
  });
  const call = async (deps: Parameters<typeof createInternalThreadRoutes>[0], threadId: string) => {
    let response: { status: number; body: Record<string, unknown> } | undefined;
    await createInternalThreadRoutes(deps)({ res: {}, path: `/api/internal/threads/${threadId}/withdraw-wait`, method: "POST",
      json: (_res: unknown, status: number, body: Record<string, unknown>) => { response = { status, body }; } } as never);
    return response!;
  };

  it("withdraws only the named own wait and reports a repeated call without a second stop", async () => {
    const waiting = new Set([first.threadId, second.threadId]);
    const stopped: string[] = [];
    const deps = { ...base(), waitingForPerson: (id: string) => waiting.has(id), stopWaiting: async (id: string) => { stopped.push(id); waiting.delete(id); } };
    expect(await call(deps, first.threadId)).toEqual({ status: 200, body: { withdrawn: true, waiting: false, threadId: first.threadId } });
    expect(await call(deps, first.threadId)).toEqual({ status: 200, body: { withdrawn: false, waiting: false, threadId: first.threadId } });
    expect(waiting.has(second.threadId)).toBe(true);
    expect(stopped).toEqual([first.threadId]);
  });

  it("refuses unproved origin, other bots, other people and the current conversation", async () => {
    expect((await call({ ...base(), personRequestedWithdrawal: () => false }, first.threadId)).status).toBe(403);
    expect((await call({ ...base(), ownsThread: () => false }, first.threadId)).status).toBe(403);
    expect((await call(base(), peer.threadId)).status).toBe(404);
    expect((await call({ ...base(), samePerson: () => false }, first.threadId)).status).toBe(403);
    expect((await call(base(), source.threadId)).status).toBe(403);
  });

  it("leaves running and queued work untouched even when a question is open", async () => {
    const stopped: string[] = [];
    const deps = { ...base(), stopWaiting: async (id: string) => { stopped.push(id); } };
    expect((await call({ ...deps, threadBusy: () => true }, first.threadId)).status).toBe(409);
    expect((await call({ ...deps, queuedThreadPosition: () => 1 }, first.threadId)).status).toBe(409);
    expect((await call({ ...deps, coordinator: { active: () => [{ threadId: first.threadId, status: "running" }] } as never }, first.threadId)).status).toBe(409);
    expect(stopped).toEqual([]);
  });
});
