import { expect, it } from "vitest";

import { approvalModeFor, levelWithin } from "../../shared/approval-mode.ts";
import { approvalModeForOrigin } from "../auto-approve.ts";
import type { Assignment } from "../runtime/types.ts";
import type { BotRecord } from "../store.ts";
import { createLiveApprovalMode, createRecipientApprovalLevel, type LiveApprovalDeps } from "./live-approval.ts";

const running = { id: "ada", threadId: "t1", approvalMode: "ask", modelSelection: { instanceId: "openaiCompat", model: "m" } } as unknown as BotRecord;

function live(saved: Partial<BotRecord> | null) {
  const seen: Array<{ bot: BotRecord; peer: boolean; threadId: string }> = [];
  const store = { projectBotForTask: () => saved && { ...running, ...saved } } as unknown as LiveApprovalDeps["store"];
  const level = createLiveApprovalMode({ store, turnLevel: (bot, peer, threadId) => { seen.push({ bot, peer, threadId }); return approvalModeFor(bot); } });
  return { level: (peer = false) => level(running, "t1", peer), seen };
}

it("reads the level saved now, never the copy the turn started with", () => {
  expect(live({ approvalMode: "full" }).level()).toBe("full");
  expect(live({ approvalMode: "ask" }).level()).toBe("ask");
  expect(live(null).level()).toBe("ask");
});

it("judges the saved level on the engine the turn runs, and passes the turn's origin through", () => {
  const w = live({ approvalMode: "full", modelSelection: { instanceId: "codex", model: "x" } });
  w.level(true);
  expect(w.seen).toEqual([{ bot: expect.objectContaining({ approvalMode: "full", modelSelection: running.modelSelection }), peer: true, threadId: "t1" }]);
});

it("uses current Custom for a restarted direct root recorded at Ask", () => {
  const bot = { ...running, modelSelection: { instanceId: "codex", model: "m" } } as BotRecord;
  const store = { projectBotForTask: () => ({ ...bot, approvalMode: "custom" }), taskByThread: () => ({ threadId: "t1" }) } as unknown as LiveApprovalDeps["store"] &
    Parameters<typeof createRecipientApprovalLevel>[0]["store"];
  const liveMode = createLiveApprovalMode({ store, turnLevel: (current, peer) => approvalModeForOrigin(approvalModeFor(current), { peerInitiated: peer }) });
  const recorded = { status: "running", level: "ask", restarts: 1, assignee: { botId: "ada", destination: { threadId: "t1" } }, requester: { kind: "person" } } as Pick<Assignment, "status" | "level" | "restarts" | "assignee" | "requester">;
  let internal = false;
  const level = createRecipientApprovalLevel({ store, assignment: (id) => id === "root" ? recorded : undefined,
    botForThread: () => bot, internal: () => internal, liveMode });
  expect(recorded.level).toBe("ask");
  expect(level("ada", "t1", "root")).toBe("custom");
  expect(levelWithin(level("ada", "t1", "root")!, "auto")).toBe(false);
  expect(level("ada", "t1", "other")).toBeNull();
  internal = true;
  expect(level("ada", "t1", "root")).toBe("auto");
});
