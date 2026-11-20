import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";
import type { TurnAutomationAction } from "../shared/turn-progress.ts";

it("reports real authenticated automation actions on the held turn, then rejects the stale capability", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omb-chat-status-"));
  const release = join(dir, "release");
  const key = randomUUID();
  try {
    const fixture = await launchVerificationServer({
      FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_RELEASE: release, OMB_TEST_INTERNAL_CAPABILITY_KEY: key,
    });
    const url = fixture.info.url;
    let sse: Awaited<ReturnType<typeof openSse>> | undefined;
    try {
      const request = (path: string, method: "GET" | "POST" = "GET", body?: unknown, headers: Record<string, string> = {}) =>
        fetch(new URL(path, url), {
          method, headers: { origin: url, "content-type": "application/json", ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
        });
      const snapshot = await (await request("/api/bots")).json() as { bots: Array<{ id: string; threadId: string }> };
      const bot = snapshot.bots[0]!;
      sse = await openSse(url + "/api/events", { origin: url });
      const ask = "Check and change my fixture automations.";
      expect((await request(`/api/bots/${bot.id}/messages`, "POST", { text: ask, threadId: bot.threadId })).status).toBe(202);
      const { event: started } = await sse.until((frame) =>
        frame.kind === "runtime" && frame.event.type === "turn.started" && frame.event.threadId === bot.threadId, 20_000);
      expect(started.requestMessageId).toBeTruthy();

      const minted = await request("/api/testing/internal-capability", "POST", { botId: bot.id, threadId: bot.threadId },
        { "x-openmausbot-test-capability": key });
      expect(minted.status).toBe(201);
      const { token } = await minted.json() as { token: string };
      const internal = { authorization: `Bearer ${token}` };
      const update = (operation: Record<string, unknown>) => request("/api/internal/trigger-requests", "POST",
        { fromBotId: bot.id, fromThreadId: bot.threadId, ...operation }, internal);
      const missing = await update({ action: "update", triggerId: "missing-trigger", changes: { name: "Fixture invalid" } });
      expect(missing.status).toBe(404);
      const accept = async (action: TurnAutomationAction, response: Promise<Response>, status: number) => {
        const reply = await response;
        expect(reply.status).toBe(status);
        const { event: began } = await sse!.until((frame) => frame.kind === "runtime" && frame.event.type === "turn.progress" &&
          frame.event.automation?.action === action && frame.event.automation?.phase === "started", 5_000);
        const { event: finished } = await sse!.until((frame) => frame.kind === "runtime" && frame.event.type === "turn.progress" &&
          frame.event.itemId === began.itemId && frame.event.automation?.phase === "finished", 5_000);
        expect(began).toMatchObject({ threadId: bot.threadId, turnId: started.turnId });
        expect(finished).toMatchObject({ threadId: bot.threadId, turnId: started.turnId, automation: { action, phase: "finished" } });
        for (const event of [began, finished]) {
          for (const key of ["target", "detail", "raw", "tool", "summary", "input", "tail"]) expect(event).not.toHaveProperty(key);
        }
        return reply.json();
      };

      await accept("view", request("/api/internal/triggers", "GET", undefined, internal), 200);
      const created = await accept("create", update({ action: "create", kind: "schedule", routine: {
        name: "Fixture private working note", instructions: "Only the isolated tool should see this.", schedule: { type: "interval", everyMinutes: 60 },
      } }), 201) as { result: { resultId: string } };
      const triggerId = created.result.resultId;
      await accept("update", update({ action: "update", triggerId, changes: { name: "Fixture revised" } }), 201);
      await accept("pause", update({ action: "pause", triggerId }), 201);

      const events = () => sse!.frames.filter((frame) => frame.kind === "runtime" && frame.event.type === "turn.progress" && frame.event.automation);
      expect(events().map(({ event }) => event.automation.action)).toEqual(["view", "view", "create", "create", "update", "update", "pause", "pause"]);
      await writeFile(release, "");
      await sse.until((frame) => frame.kind === "runtime" && frame.event.type === "turn.completed" && frame.event.turnId === started.turnId, 15_000);
      const stale = await update({ action: "update", triggerId, changes: { name: "Stale request" } });
      expect(stale.ok).toBe(false);
      expect(events()).toHaveLength(8);
    } finally {
      sse?.close();
      await fixture.close();
    }
  } finally {
    await removeTempDir(dir);
  }
}, 90_000);
