import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { appendUsage } from "./usage-ledger.ts";

describe("usage ledger through real turns", () => {
  let session: VerificationServer;

  beforeEach(async () => {
    session = await launchVerificationServer();
  }, 60_000);

  afterEach(async () => {
    console.info(JSON.stringify(session.info));
    await session.close();
  });

  const control = (args: string[]) => runControlOmb([...args, "--url", session.info.url]) as Promise<any>;
  const api = (path: string, init: RequestInit = {}) => fetch(`${session.info.url}${path}`, init);
  const jsonRequest = (body: unknown, token?: string): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const pair = async (label: string, scopes?: string[]) => {
    const opened = (await (await api("/api/auth/pairing", jsonRequest(scopes ? { scopes } : {}))).json()) as { code: string };
    const paired = (await (await api("/api/auth/pair", jsonRequest({ code: opened.code, label }))).json()) as { token: string };
    expect(paired.token).toBeTypeOf("string");
    return paired.token;
  };

  it("writes one row per settled turn naming who asked, and reports it by person, bot and model", async () => {
    const created = await control(["new-bot", "--name", "Ledger probe"]);
    const botId = created.bot.id as string;

    await control(["send", "--bot", botId, "--text", "hello from the owner"]);
    expect(JSON.stringify(await control(["wait", "--bot", botId, "--timeout", "30"]))).toContain("settled");

    const phone = await pair("Ada's phone");
    const sent = await api(`/api/bots/${encodeURIComponent(botId)}/messages`, jsonRequest({ text: "hello from a phone" }, phone));
    expect([200, 201, 202]).toContain(sent.status);
    expect(JSON.stringify(await control(["wait", "--bot", botId, "--timeout", "30"]))).toContain("settled");

    const file = join(session.info.dataDir, "usage", `${new Date().toISOString().slice(0, 7)}.jsonl`);
    await expect.poll(() => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").length : 0), { timeout: 10_000 }).toBe(2);
    const rows = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows[0]).toMatchObject({
      botId, botName: "Ledger probe", instanceId: "claude", driverKind: "claudeAgent", costUsd: 0.01, trigger: { kind: "owner" },
    });
    expect(rows[0].input).toBeGreaterThanOrEqual(10);
    expect(rows[0].output).toBeGreaterThanOrEqual(1);
    expect(rows[0].model).toBeTypeOf("string");
    expect(rows[1]).toMatchObject({ botId, costUsd: 0.01, trigger: { kind: "user", label: "Ada's phone" } });
    expect(readFileSync(file, "utf8")).not.toContain("hello from");

    const byUser = (await (await api("/api/usage?groupBy=user")).json()) as any;
    expect(byUser.groups.map((g: any) => [g.key, g.turns, g.costUsd])).toEqual(
      expect.arrayContaining([["owner", 1, 0.01], ["user:ada's phone", 1, 0.01]]),
    );
    expect(byUser.total).toMatchObject({ turns: 2, unpriced: 0 });
    expect(byUser.total.costUsd).toBeCloseTo(0.02, 6);
    const byBot = (await (await api("/api/usage?groupBy=bot")).json()) as any;
    expect(byBot.groups).toEqual([expect.objectContaining({ key: `bot:${botId}`, label: "Ledger probe", turns: 2 })]);
    const split = (await (await api("/api/usage?groupBy=bot&splitBy=model")).json()) as any;
    expect(split.splitBy).toBe("model");
    expect(split.groups[0].segments).toEqual([expect.objectContaining({ key: expect.stringMatching(/^model:/), turns: 2 })]);
    expect((await api("/api/usage?groupBy=bot&splitBy=engine")).status).toBe(400);

    const csv = await api("/api/usage.csv");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect((await csv.text()).trim().split("\n")).toHaveLength(3);

    const client = await pair("Client phone", ["client"]);
    expect((await api("/api/usage", { headers: { authorization: `Bearer ${client}` } })).status).toBe(403);
    expect((await api("/api/usage.csv", { headers: { authorization: `Bearer ${client}` } })).status).toBe(403);

    await appendUsage(session.info.dataDir, {
      ...rows[0], at: "2026-01-15T16:30:01Z", startedAt: "2026-01-15T16:30:00Z", endedAt: "2026-01-15T16:30:01Z",
    });
    const query = "from=2026-01-16&to=2026-01-16&tz=Asia%2FShanghai";
    const insight = await api(`/api/usage/insights?${query}`);
    expect(insight.status).toBe(200);
    expect(insight.headers.get("cache-control")).toBe("no-store");
    expect(await insight.json()).toMatchObject({
      from: "2026-01-16", to: "2026-01-16", timeZone: "Asia/Shanghai", unit: "hour",
      totals: { turns: 1, costUsd: 0.01 }, bots: [expect.objectContaining({ label: "Ledger probe" })],
    });
    const traces = await api(`/api/usage/traces?${query}`);
    expect(traces.status).toBe(200);
    expect(await traces.json()).toMatchObject({ roots: [expect.any(Object)] });
    const localCsv = await api(`/api/usage.csv?${query}`);
    expect(localCsv.headers.get("content-disposition")).toContain("usage-2026-01-16-2026-01-16.csv");
    expect((await localCsv.text()).trim().split("\n")).toHaveLength(2);
    expect((await api(`/api/usage/insights?${query}`, { headers: { authorization: `Bearer ${client}` } })).status).toBe(403);
    expect((await api("/api/usage/insights?from=2026-01-16&to=2026-01-16&tz=Mars%2FOlympus")).status).toBe(400);
  }, 120_000);
});
