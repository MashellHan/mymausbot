import { describe, expect, it, vi } from "vitest";

import type { CoordinatorHost, HandoffView } from "../coordinator.ts";
import { RuntimeCoordinator } from "../runtime-coordinator.ts";
import * as runtimeStores from "../runtime/store.ts";
import type { Assignment } from "../runtime/types.ts";
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
    coordinator: { awaitingAnswer: () => false, activeDirect: () => false, active: () => [],
      threadActivity: () => ({ awaitingAnswer: new Set(), activeDirect: new Set(["t-ops-new"]), queued: new Map([["t-ops-new", new Map([[ops.id, handoff]])]]) }) },
    from, fromThreadId: "t-own", ownsThread: () => true, shown: () => true,
    threadBusy: (_bot, threadId) => threadId === "t-ops-busy", queuedThreadPosition: () => null,
    queuedReason: (node, showTitle) => `${node.id} waits${showTitle ? " (titles)" : ""}`,
    personRequestedWithdrawal: () => true, samePerson: () => true, waitingForPerson: () => false, stopWaiting: async () => {},
    readBody: async () => ({}),
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

  it("only looks up live state for the 100 threads returned", async () => {
    const many = Array.from({ length: 130 }, (_, index) => ({ ...task(`t-${index}`, `Event ${index}`), createdAt: index }));
    const lookedUp = new Set<string>();
    const route = createInternalThreadRoutes({
      store: { bot: () => undefined, bots: [lead], tasks: (id: string) => id === lead.id ? many : [] } as never,
      coordinator: { awaitingAnswer: () => false, activeDirect: () => false, active: () => [],
        threadActivity: () => ({ awaitingAnswer: new Set(), activeDirect: new Set(), queued: new Map() }) },
      from: lead, fromThreadId: "t-own", ownsThread: () => true, shown: () => true,
      threadBusy: (_botId, threadId) => { lookedUp.add(threadId); return threadId === "t-129"; },
      queuedThreadPosition: () => null, queuedReason: () => "",
      personRequestedWithdrawal: () => true, samePerson: () => true, waitingForPerson: () => false, stopWaiting: async () => {},
      readBody: async () => ({}),
    });
    let body: { threads: Array<{ threadId: string; state: string }> } | undefined;
    await route({ res: {}, path: "/api/internal/threads", method: "GET", json: (_res: unknown, _status: number, value: never) => { body = value; } } as never);
    expect(body!.threads).toHaveLength(100);
    expect(body!.threads[0]).toMatchObject({ threadId: "t-129", state: "running" });
    expect(lookedUp).toEqual(new Set(Array.from({ length: 100 }, (_, index) => `t-${30 + index}`)));
  });
});

describe("list_threads with the real runtime store", () => {
  it("reads the live assignments once for a full page without changing their states or queue details", async () => {
    const stores: runtimeStores.RuntimeStore[] = [];
    const open = runtimeStores.openRuntimeStore;
    const factory = vi.spyOn(runtimeStores, "openRuntimeStore").mockImplementation((path) => {
      const store = open(path);
      stores.push(store);
      return store;
    });
    const host: CoordinatorHost = {
      validate: () => undefined, busy: () => false, run: async () => ({ ok: true, text: "" }),
      report: () => {}, changed: () => {}, names: () => ({ requester: "Lead", assignee: "Lead" }),
      park: () => {}, levelOf: () => ({ level: "ask" }), chiefOf: () => false,
    };
    const coordinator = new RuntimeCoordinator({ dataDir: ":memory:", host });
    factory.mockRestore();
    try {
      coordinator.active();
      const runtime = stores[0];
      if (!runtime) throw new Error("runtime store was not opened");
      const insert = (id: string, threadId: string, patch: Partial<Assignment> = {}) => {
        const row: Assignment = {
          id, rootId: id, depth: 0, origin: { kind: "person", source: "chat" }, requester: { kind: "person" },
          assignee: { botId: lead.id, destination: { kind: "standing_thread", threadId } },
          mode: "work", reply: "resume", brief: "", status: "queued", level: "ask", levelSource: "own",
          executions: 0, restarts: 0, createdAt: 10, lastActivityAt: 10, result: "", rework: false, version: 1, ...patch,
        };
        runtime.insert(row, { kind: "enqueued", at: 10 });
      };
      const many = Array.from({ length: 100 }, (_, index) => ({ ...task(`t-${index}`, `Event ${index}`), createdAt: index }));
      many[96] = { ...many[96], activity: "waiting-on-you", closedBy: { botId: lead.id, name: lead.name, at: 2 } };
      many[92] = { ...many[92], activity: "waiting-on-you", closedBy: { botId: lead.id, name: lead.name, at: 2 } };
      insert("finished-parent", "t-95", { status: "completed", assignee: { botId: lead.id, destination: { kind: "room_thread", threadId: "t-95", groupId: "" } } });
      insert("empty-group-first", "t-95", { parentId: "finished-parent", createdAt: 1, assignee: { botId: lead.id, destination: { kind: "room_thread", threadId: "t-95", groupId: "" } } });
      insert("empty-group-only", "t-94", { assignee: { botId: lead.id, destination: { kind: "room_thread", threadId: "t-94", groupId: "" } } });
      for (let i = 0; i < 100; i++) if (![92, 94, 96, 97, 98].includes(i)) insert(`queued-${i}`, `t-${i}`);
      insert("first-queued", "t-90", { createdAt: 1 });
      insert("wrong-bot-queued", "t-peer", { createdAt: 0 });
      insert("peer-first", "t-peer", { createdAt: 1, assignee: { botId: ops.id, destination: { kind: "standing_thread", threadId: "t-peer" } } });
      insert("peer-later", "t-peer", { createdAt: 2, assignee: { botId: ops.id, destination: { kind: "standing_thread", threadId: "t-peer" } } });
      const peer = task("t-peer", "Peer", { botId: lead.id, name: lead.name, at: 100 });
      insert("group-parked", "t-99", { status: "needs_input", assignee: { botId: lead.id, destination: { kind: "room_thread", threadId: "t-99", groupId: "g" } } });
      insert("waiting-for-child", "t-98", { status: "waiting", question: "stale question" });
      insert("direct-parked", "t-96", { status: "needs_input" });
      insert("source", "t-97", { status: "running", executions: 1, createdAt: 1 });
      const route = createInternalThreadRoutes({
        store: { bot: () => undefined, bots: [lead, ops], tasks: (id: string) => id === lead.id ? many : [peer] } as never,
        coordinator, from: lead, fromThreadId: "t-own", ownsThread: () => true, shown: () => true,
        threadBusy: (_botId, threadId) => threadId === "t-99" || threadId === "t-98",
        queuedThreadPosition: () => null, queuedReason: (node, showTitle) => `${node.id}:${node.kind}:${showTitle ? "own" : "peer"}`,
        personRequestedWithdrawal: () => true, samePerson: () => true, waitingForPerson: () => false, stopWaiting: async () => {},
        readBody: async () => ({}),
      });
      const all = vi.spyOn(runtime, "all");
      try {
        let body: { threads: Array<Record<string, unknown>> } | undefined;
        await route({ res: {}, path: "/api/internal/threads", method: "GET",
          json: (_res: unknown, _status: number, value: never) => { body = value; } } as never);
        const rows = body?.threads ?? [];
        expect(rows).toHaveLength(100);
        expect(rows.find(row => row.threadId === "t-99")).toMatchObject({ state: "waiting-on-you" });
        expect(rows.find(row => row.threadId === "t-98")).toMatchObject({ state: "running" });
        expect(rows.find(row => row.threadId === "t-96")).toMatchObject({ state: "waiting-on-you" });
        expect(rows.find(row => row.threadId === "t-92")).toMatchObject({ state: "waiting-on-you" });
        expect(rows.find(row => row.threadId === "t-94")).toMatchObject({ state: "idle" });
        expect(rows.find(row => row.threadId === "t-97")).toMatchObject({ state: "queued", delegationId: undefined });
        expect(rows.find(row => row.threadId === "t-95")).toMatchObject({ state: "queued", delegationId: "empty-group-first", waiting: "empty-group-first:assignment:own" });
        expect(rows.find(row => row.threadId === "t-90")).toMatchObject({ state: "queued", delegationId: "first-queued", waiting: "first-queued:work:own" });
        expect(rows.find(row => row.threadId === "t-peer")).toMatchObject({ botId: ops.id, own: false, state: "queued", delegationId: "peer-first", waiting: "peer-first:work:peer" });
        const liveReads = all.mock.calls.filter(([filter]) => filter?.nonTerminal === true);
        expect(liveReads).toHaveLength(1);
      } finally {
        all.mockRestore();
      }
    } finally {
      coordinator.close();
    }
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
    readBody: async () => ({}),
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

  it("refuses a restored card-only wait when Stop leaves the card open, including on repeat", async () => {
    const openCards = new Set([first.threadId]);
    const stopped: string[] = [];
    const deps = { ...base(), waitingForPerson: (id: string) => openCards.has(id), stopWaiting: async (id: string) => { stopped.push(id); } };
    const refused = { status: 409, body: { error: "that thread is still waiting for the person", withdrawn: false, waiting: true, threadId: first.threadId } };
    expect(await call(deps, first.threadId)).toEqual(refused);
    expect(await call(deps, first.threadId)).toEqual(refused);
    expect(stopped).toEqual([first.threadId, first.threadId]);
    expect(openCards.has(first.threadId)).toBe(true);
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

describe("rename_thread on the conversation the turn speaks in", () => {
  async function rename(body: unknown, opts: { own?: TaskRecord; owns?: boolean } = {}) {
    const own = opts.own ?? task("t-own", "Terminei o design e a skill de carrossel pra cl…");
    const renamed: Array<[string, string, string]> = [];
    const route = createInternalThreadRoutes({
      store: {
        bot: () => lead, bots: [lead, ops], tasks: () => [own],
        taskByThread: (botId: string, threadId: string) => botId === lead.id && threadId === own.threadId ? own : undefined,
        renameTask: (botId: string, threadId: string, title: string) => { renamed.push([botId, threadId, title]); return { ...own, title }; },
      } as never,
      coordinator: {} as never,
      from: lead, fromThreadId: "t-own", ownsThread: () => opts.owns ?? true, shown: () => true,
      threadBusy: () => false, queuedThreadPosition: () => null, queuedReason: () => "",
      readBody: async () => body,
      personRequestedWithdrawal: () => false, samePerson: () => false, waitingForPerson: () => false, stopWaiting: async () => {},
    });
    let status = 0;
    let answer: Record<string, unknown> | undefined;
    await route({ res: {}, path: "/api/internal/thread-title", method: "POST", json: (_res: unknown, code: number, value: never) => { status = code; answer = value; } } as never);
    return { status, answer: answer!, renamed };
  }

  it("renames only its own current thread, trimmed to one line of at most 80 characters", async () => {
    const { status, answer, renamed } = await rename({ title: `  ACME:\n carousel design ${"x".repeat(100)}` });
    expect(status).toBe(200);
    expect(renamed).toHaveLength(1);
    expect(renamed[0]!.slice(0, 2)).toEqual(["bot-lead", "t-own"]);
    expect(renamed[0]![2]).toMatch(/^ACME: carousel design x+$/);
    expect(renamed[0]![2]).toHaveLength(80);
    expect(answer).toMatchObject({ title: renamed[0]![2], previous: "Terminei o design e a skill de carrossel pra cl…" });
  });

  it("refuses an empty title, a conversation that is not the sender's, a room's thread and an automation's chat", async () => {
    expect((await rename({ title: "   " })).status).toBe(400);
    expect((await rename({ title: "New name" }, { owns: false })).status).toBe(403);
    const room = await rename({ title: "New name" }, { own: task("t-room", "Room thread") });
    expect(room.status).toBe(404);
    for (const own of [task("t-own", "Daily brief · Results"), { ...task("t-own", "Run"), routineRunId: "run-1" } as TaskRecord]) {
      const refused = await rename({ title: "New name" }, { own });
      expect(refused.status).toBe(409);
      expect(refused.renamed).toEqual([]);
    }
  });
});
