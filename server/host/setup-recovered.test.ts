import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { errorReplyFailure } from "../drivers/engine-errors.ts";
import { peerStatus, peerStatusWords } from "../peer-roster.ts";
import { Store } from "../store.ts";
import { createSetupRecovery } from "./setup-recovered.ts";

const engineTurn = { replayed: false, stopped: false };

function setup() {
  const store = new Store(() => ({ instanceId: "claude", model: "sonnet" }));
  const bot = store.createBot();
  const failed = store.createTask(bot.id, "Needs setup")!;
  const later = store.createTask(bot.id, "Later")!;
  const recovery = createSetupRecovery(store);
  const failure = { threadId: failed.threadId, providerInstanceId: "claude" };
  const turn = { threadId: later.threadId, turnId: "later-turn", providerInstanceId: "claude" };
  const mark = () => recovery.failed(bot.id, failure);
  const complete = () => recovery.completed(bot.id, { ...turn, ok: true }, engineTurn);
  const activity = () => store.taskByThread(bot.id, failed.threadId)?.activity;
  const status = () => peerStatusWords(peerStatus(store.bot(bot.id)?.activity, store.bot(bot.id)?.busy));
  return { store, bot, failed, later, recovery, failure, turn, mark, complete, activity, status };
}

describe("teammate setup recovery", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("clears a setup mark only on the bot that had a later successful turn", () => {
    const { store, bot, recovery, turn, mark, complete, activity, status } = setup();
    const other = store.createBot({ name: "Other" });
    const untouched = store.createTask(other.id, "Also signed out")!;
    const waiting = store.createTask(bot.id, "Waiting")!;
    mark();
    expect(activity()).toBe("dead");
    expect(status()).toBe("unavailable — needs setup");
    store.setTaskActivity(bot.id, waiting.threadId, "waiting-on-you");
    recovery.failed(other.id, { threadId: untouched.threadId, providerInstanceId: "claude" });
    recovery.started(turn);
    complete();
    expect(activity()).toBe("idle");
    expect(store.taskByThread(bot.id, waiting.threadId)?.activity).toBe("waiting-on-you");
    expect(store.taskByThread(other.id, untouched.threadId)?.activity).toBe("dead");
  });

  it("keeps a mark made after the turn started, including repeated start events", () => {
    const { recovery, turn, mark, complete, activity } = setup();
    recovery.started(turn);
    mark();
    recovery.started(turn);
    complete();
    expect(activity()).toBe("dead");
  });

  it.each([
    ["saved steps", { replayed: true, stopped: false }],
    ["a stopped turn", { replayed: false, stopped: true }],
  ] as const)("keeps a setup mark after %s", (_kind, flags) => {
    const { bot, recovery, turn, mark, activity } = setup();
    mark();
    recovery.started(turn);
    recovery.completed(bot.id, { ...turn, ok: true }, flags);
    expect(activity()).toBe("dead");
  });

  it("uses the provider that answered, including during a failover", () => {
    const { bot, recovery, turn, mark, complete, activity } = setup();
    mark();
    const backup = { ...turn, providerInstanceId: "claude-backup", turnId: "backed-up-turn" };
    recovery.started(backup);
    recovery.completed(bot.id, { ...backup, ok: true }, engineTurn);
    expect(activity()).toBe("dead");
    recovery.started(turn);
    complete();
    expect(activity()).toBe("idle");
  });

  it("requires a successful completion of the exact turn that started", () => {
    const { bot, recovery, turn, mark, complete, activity } = setup();
    mark();
    complete();
    expect(activity()).toBe("dead");
    recovery.started(turn);
    recovery.completed(bot.id, { ...turn, turnId: "stale-turn", ok: true }, engineTurn);
    expect(activity()).toBe("dead");
    recovery.completed(bot.id, { ...turn, ok: false }, engineTurn);
    complete();
    expect(activity()).toBe("dead");
  });

  it("recovers a credit failure marked as needing setup by the driver", () => {
    const { bot, recovery, failure, turn, complete, activity } = setup();
    const error = errorReplyFailure("Test engine", '402 {"type":"error","error":{"type":"billing_error","message":"Your credit balance is too low."}}');
    expect(error?.setup).toBe(true);
    if (error?.setup) recovery.failed(bot.id, failure);
    expect(activity()).toBe("dead");
    recovery.started(turn);
    complete();
    expect(activity()).toBe("idle");
  });
});
