import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { MiniAppActionBridge } from "./actions.ts";
import { MINI_APPS_OWNER, ensureMiniApps, type MiniAppActor } from "./registry.ts";

function setupFixture() {
  const db = new DatabaseSync(":memory:");
  ensureMiniApps(db);
  const now = Date.now();
  const appId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const datasetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  db.prepare(`
    INSERT INTO mini_apps (id, owner_id, slug, title, description, status, revision, template_version, publishers, responsible_bot_id, capabilities, created_at, updated_at)
    VALUES (?, ?, 'bookkeeping', 'Bookkeeping', 'desc', 'active', 4, 1, '[]', 'bot-finance', ?, ?, ?)
  `).run(appId, MINI_APPS_OWNER, JSON.stringify(["action:routine-run", "action:bot-task", "action:dataset-append"]), now, now);
  db.prepare(`
    INSERT INTO mini_app_versions (app_id, version, doc, title, description, bindings, created_at)
    VALUES (?, 1, 'sha256:doc', 'Bookkeeping', 'desc', ?, ?)
  `).run(appId, JSON.stringify([{ datasetId, queries: {} }]), now);

  const noCapAppId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  db.prepare(`
    INSERT INTO mini_apps (id, owner_id, slug, title, description, status, revision, template_version, publishers, capabilities, created_at, updated_at)
    VALUES (?, ?, 'viewer', 'Viewer', 'desc', 'active', 1, 1, '[]', '[]', ?, ?)
  `).run(noCapAppId, MINI_APPS_OWNER, now, now);

  const runRoutine = vi.fn(async ({ routineId }: { routineId: string }) => ({ started: true, routineId }));
  const sendBotMessage = vi.fn(async ({ responsibleBotId, prompt }: { responsibleBotId: string; prompt: string }) => ({ botId: responsibleBotId, queued: true, length: prompt.length }));
  const appendRecord = vi.fn(async ({ datasetId: ds, table }: { datasetId: string; table: string }) => ({ datasetId: ds, table, revision: 9 }));

  const bridge = new MiniAppActionBridge(
    { database: () => db, write: (fn) => fn(db) },
    { runRoutine, sendBotMessage, appendRecord },
  );
  const owner: MiniAppActor = { writeAllowed: true, assertActive: () => {}, canBind: () => true };
  const bot: MiniAppActor = { botId: "bot-finance", writeAllowed: true, assertActive: () => {}, canBind: () => true };
  return { bridge, owner, bot, appId, noCapAppId, datasetId, runRoutine, sendBotMessage, appendRecord };
}

describe("MiniAppActionBridge", () => {
  it("executes capability-granted actions and replays duplicate requestKeys idempotently", async () => {
    const { bridge, owner, appId, runRoutine } = setupFixture();
    const first = await bridge.invoke(owner, appId, {
      expectedRevision: 4,
      requestKey: "req-routine-001",
      action: { kind: "run-routine", routineId: "rt-daily" },
    });
    expect(first).toMatchObject({ appId, revision: 4, kind: "run-routine", replayed: false, detail: { started: true, routineId: "rt-daily" } });
    expect(runRoutine).toHaveBeenCalledTimes(1);

    const replay = await bridge.invoke(owner, appId, {
      expectedRevision: 4,
      requestKey: "req-routine-001",
      action: { kind: "run-routine", routineId: "rt-daily" },
    });
    expect(replay.replayed).toBe(true);
    expect(runRoutine).toHaveBeenCalledTimes(1);

    await expect(bridge.invoke(owner, appId, {
      expectedRevision: 4,
      requestKey: "req-routine-001",
      action: { kind: "run-routine", routineId: "rt-other" },
    })).rejects.toThrow(/different action payload/);
  });

  it("enforces owner-only, capability grants, responsibleBotId confinement, and bound dataset validation", async () => {
    const { bridge, owner, bot, appId, noCapAppId, datasetId, sendBotMessage, appendRecord } = setupFixture();

    await expect(bridge.invoke(bot, appId, {
      expectedRevision: 4,
      requestKey: "req-bot-1",
      action: { kind: "run-routine", routineId: "rt-1" },
    })).rejects.toThrow(/Only the local workspace owner/);

    await expect(bridge.invoke(owner, noCapAppId, {
      expectedRevision: 1,
      requestKey: "req-nocap-1",
      action: { kind: "send-bot-message", prompt: "hello" },
    })).rejects.toThrow(/lacks the required capability/);

    await expect(bridge.invoke(owner, appId, {
      expectedRevision: 4,
      requestKey: "req-unbound-1",
      action: { kind: "append-record", bindingDatasetId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", table: "expenses", row: { amount: 12 } },
    })).rejects.toThrow(/not bound/);

    const msgRes = await bridge.invoke(owner, appId, {
      expectedRevision: 4,
      requestKey: "req-msg-1",
      action: { kind: "send-bot-message", prompt: "Summarize today's expenses" },
    });
    expect(msgRes.detail).toMatchObject({ botId: "bot-finance", queued: true });
    expect(sendBotMessage).toHaveBeenCalledTimes(1);

    const appendRes = await bridge.invoke(owner, appId, {
      expectedRevision: 4,
      requestKey: "req-append-1",
      action: { kind: "append-record", bindingDatasetId: datasetId, table: "expenses", row: { amount: 42.5, note: "coffee" } },
    });
    expect(appendRes.detail).toMatchObject({ datasetId, table: "expenses", revision: 9 });
    expect(appendRecord).toHaveBeenCalledTimes(1);
  });
});
