import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

type Task = { threadId: string; activity?: string; busy?: boolean };
type Bot = Task & { id: string; mainThreadId?: string; tasks: Task[] };

it("clears a teammate's setup failure after a different conversation succeeds on the signed-in engine", async () => {
  const script = mkdtempSync(join(tmpdir(), "omb-setup-recovered-"));
  const signedOut = join(script, "signed-out");
  const reply = join(script, "reply.txt");
  writeFileSync(reply, "Signed in again.");
  let fixture: VerificationServer | undefined;
  try {
    fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_SIGNED_OUT_FILE: signedOut, FAKE_CLAUDE_REPLY_FILE: reply });
    const { url } = fixture.info;
    const api = async <T>(method: string, path: string, body?: unknown) => {
      const response = await fetch(url + path, {
        method,
        headers: { "content-type": "application/json", origin: url },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await response.json() as T };
    };
    expect((await api("PUT", "/api/config", { automaticRecovery: { enabled: false } })).status).toBe(200);
    const created = await api<{ bot: Bot }>("POST", "/api/bots", { name: "Quill" });
    expect(created.status).toBe(201);
    const { id, threadId, mainThreadId = threadId } = created.body.bot;
    const other = await api<{ task: Task }>("POST", `/api/bots/${id}/tasks`, { title: "Later" });
    expect(other.status).toBeLessThan(300);
    const later = other.body.task.threadId;
    const bot = async () => (await api<{ bots: Bot[] }>("GET", "/api/bots")).body.bots.find((entry) => entry.id === id);
    const send = async (target: string, text: string) => {
      expect((await api("POST", `/api/bots/${id}/messages`, { text, threadId: target })).status).toBe(202);
    };

    writeFileSync(signedOut, "");
    await send(mainThreadId, "Sign-in lapsed");
    await expect.poll(async () => (await bot())?.activity, { timeout: 15_000 }).toBe("dead");
    expect((await bot())?.tasks.find((task) => task.threadId === mainThreadId)?.activity).toBe("dead");

    rmSync(signedOut);
    await send(later, "Sign-in restored");
    await expect.poll(async () => {
      const current = await bot();
      return { activity: current?.activity, failed: current?.tasks.find((task) => task.threadId === mainThreadId)?.activity };
    }, { timeout: 15_000 }).toEqual({ activity: "idle", failed: "idle" });
  } finally {
    await fixture?.close();
    rmSync(script, { recursive: true, force: true });
  }
}, hostTimeout(60_000));
