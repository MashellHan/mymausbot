import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { ownTurnText } from "./testing/room-handoff-agent.ts";

type Bot = { id: string; threadId: string };
type Line = { id: string; role: string; text?: string; replyToId?: string; sendId?: string };

it("keeps a quoted source and current request through direct send, queue, retry and reload", async () => {
  const control = mkdtempSync(join(tmpdir(), "mausbot-quote-context-"));
  const gate = join(control, "finish");
  writeFileSync(gate, "open");
  let fixture: VerificationServer | undefined;
  try {
    fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate, FAKE_CLAUDE_VERSION: "2.1.270" });
    const { url } = fixture.info;
    const api = async (method: string, path: string, body?: unknown, expected = 200) => {
      const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
      const result = await response.json() as Record<string, unknown>;
      expect(response.status, JSON.stringify(result)).toBe(expected);
      return result;
    };
    const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as Line[];
    const settled = async (bot: Bot) => runControlOmb(["wait", "--bot", bot.id, "--task", bot.threadId, "--url", url]);
    const prompt = () => {
      try { return ownTurnText((JSON.parse(readFileSync(fixture!.fixtureDumpPath, "utf8")) as { prompt?: unknown }).prompt); }
      catch { return ""; }
    };
    const bot = (await api("POST", "/api/bots", { name: "Quote fixture" }, 201)).bot as Bot;
    const sourceReceipt = await api("POST", `/api/bots/${bot.id}/messages`, {
      threadId: bot.threadId, text: "Source plan: blue door", sendId: "quote-source-00000001",
    }, 202);
    expect(sourceReceipt).toHaveProperty("message");
    const source = sourceReceipt.message as Line;
    await settled(bot);

    const directBody = { threadId: bot.threadId, text: "Current choice: green door", replyToId: source.id, sendId: "quote-direct-00000001" };
    const directReceipt = await api("POST", `/api/bots/${bot.id}/messages`, directBody, 202);
    expect(directReceipt).toHaveProperty("message");
    const direct = directReceipt.message as Line;
    await expect.poll(prompt, { timeout: 15_000 }).toContain("Current choice: green door");
    expect(prompt()).toContain("--- quoted excerpt ---\nSource plan: blue door\n--- end quoted excerpt ---\nCurrent message:\nCurrent choice: green door");
    expect((await api("POST", `/api/bots/${bot.id}/messages`, directBody, 202)).message).toMatchObject({ id: direct.id, replyToId: source.id });
    await api("POST", `/api/bots/${bot.id}/messages`, { ...directBody, replyToId: undefined }, 409);
    await settled(bot);
    expect((await messages(bot.threadId)).find((line) => line.id === direct.id)).toMatchObject({ replyToId: source.id, text: directBody.text });

    const foreign = (await api("POST", "/api/bots", { name: "Foreign fixture" }, 201)).bot as Bot;
    const foreignSource = (await api("POST", `/api/bots/${foreign.id}/messages`, {
      threadId: foreign.threadId, text: "Other thread source", sendId: "quote-foreign-0000001",
    }, 202)).message as Line;
    await settled(foreign);
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Wrong source", replyToId: foreignSource.id }, 404);
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Missing source", replyToId: "missing-message" }, 404);
    const denied = await fetch(`${url}/api/bots/${bot.id}/messages`, { method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.8" },
      body: JSON.stringify({ threadId: bot.threadId, text: "Denied source", replyToId: source.id }) });
    expect(denied.status).toBe(403);
    const invalidSession = await fetch(`${url}/api/bots/${bot.id}/messages`, { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer omb_sess_fixture_invalid" },
      body: JSON.stringify({ threadId: bot.threadId, text: "Invalid-session source", replyToId: source.id }) });
    expect(invalidSession.status).toBe(401);
    expect((await messages(bot.threadId)).filter((line) => ["Wrong source", "Missing source", "Denied source", "Invalid-session source"].includes(line.text ?? ""))).toHaveLength(0);

    unlinkSync(gate);
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Hold this turn", sendId: "quote-hold-000000001" }, 202);
    await expect.poll(prompt, { timeout: 15_000 }).toContain("Hold this turn");
    const busyBody = { threadId: bot.threadId, text: "Busy choice: keep green", replyToId: source.id,
      sendId: "quote-busy-00000001", followUp: "queue" };
    const queued = await api("POST", `/api/bots/${bot.id}/messages`, busyBody, 202);
    expect(queued).toMatchObject({ queued: true, queueId: expect.any(String) });
    expect(await api("POST", `/api/bots/${bot.id}/messages`, busyBody, 202)).toMatchObject({ queued: true, queueId: queued.queueId });
    writeFileSync(gate, "release");
    await expect.poll(prompt, { timeout: 20_000 }).toContain("Busy choice: keep green");
    expect(prompt()).toContain("--- quoted excerpt ---\nSource plan: blue door\n--- end quoted excerpt ---\nCurrent message:\nBusy choice: keep green");
    await settled(bot);
    const reloaded = await messages(bot.threadId);
    const busyLines = reloaded.filter((line) => line.sendId === busyBody.sendId);
    expect(busyLines).toHaveLength(1);
    expect(busyLines[0]).toMatchObject({ text: busyBody.text, replyToId: source.id });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, busyBody, 202)).message).toMatchObject({ id: busyLines[0]!.id, replyToId: source.id });

    unlinkSync(gate);
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Hold live turn", sendId: "quote-live-hold-00001" }, 202);
    await expect.poll(prompt, { timeout: 15_000 }).toContain("Hold live turn");
    const steerBody = { threadId: bot.threadId, text: "Live choice: keep blue", replyToId: source.id,
      sendId: "quote-steer-00000001", followUp: "steer" };
    const live = await api("POST", `/api/bots/${bot.id}/messages`, steerBody, 202);
    expect(live).toMatchObject({ steered: true, message: { replyToId: source.id, sendId: steerBody.sendId } });
    const liveMessage = live.message as Line;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, steerBody, 202)).message).toMatchObject({ id: liveMessage.id, replyToId: source.id });
    await api("POST", `/api/bots/${bot.id}/messages`, { ...steerBody, replyToId: undefined }, 409);
    writeFileSync(gate, "release");
    await settled(bot);
    const afterSteer = await messages(bot.threadId);
    expect(afterSteer.filter((line) => line.sendId === steerBody.sendId)).toEqual([
      expect.objectContaining({ id: liveMessage.id, replyToId: source.id, text: steerBody.text }),
    ]);
    const received = afterSteer.filter((line) => line.role === "bot" && line.text?.includes("steered:")).at(-1)?.text?.split("steered:").at(-1) ?? "";
    expect(received).toMatch(/--- quoted excerpt ---[\s\S]*Source plan: blue door[\s\S]*--- end quoted excerpt ---[\s\S]*Current message:[\s\S]*Live choice: keep blue/);
  } finally {
    await fixture?.close();
    await removeTempDir(control);
  }
}, 90_000);
