import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("saves private bot documents with a checked basis and uses the approved instructions on direct and room turns", async () => {
  const fixture = await launchVerificationServer();
  const env = { OPENMAUSBOT_URL: fixture.info.url };
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, JSON.stringify(result)).toBe(status);
    return result;
  };
  const control = (args: string[]) => runControlOmb(args, { env });
  const dump = () => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { argv: string[]; systemPrompt: string };
  try {
    const { bot } = await api("POST", "/api/bots", { name: "Fixture gardener" }, 201);
    const { bot: other } = await api("POST", "/api/bots", { name: "Fixture reader" }, 201);
    const path = `/api/bots/${bot.id}`;
    const agents = `${path}/documents/agents`;
    const soul = `${path}/documents/soul`;
    const folder = join(fixture.info.dataDir, "bots", bot.id);
    const agentsFile = join(folder, "AGENTS.md");
    const soulFile = join(folder, "SOUL.md");
    const emptyAgents = await api("GET", agents);
    const emptySoul = await api("GET", soul);
    expect(emptyAgents).toEqual({ text: "", hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const savedSoul = await api("PUT", soul, { text: "Tend the fixture garden.", expectedHash: emptySoul.hash });
    expect(readFileSync(soulFile, "utf8")).toBe(savedSoul.text);
    await api("PUT", soul, { text: "Stale editor", expectedHash: emptySoul.hash }, 409);

    writeFileSync(soulFile, "External soul draft.");
    const drift = await api("PUT", soul, { text: "Pending change.", expectedHash: savedSoul.hash }, 409);
    expect(drift).toMatchObject({ code: "conflict", current: savedSoul.text, currentHash: expect.any(String), mirrorDrift: true });
    expect(await api("PUT", soul, { text: "Pending change.", expectedHash: drift.currentHash }, 409)).toEqual(drift);
    expect(readFileSync(soulFile, "utf8")).toBe("External soul draft.");

    await api("PUT", agents, { text: "🌱".repeat(6_001), expectedHash: emptyAgents.hash }, 400);
    const first = await api("PUT", agents, { text: "Record the tulips.", expectedHash: emptyAgents.hash });
    expect(readFileSync(agentsFile, "utf8")).toBe(first.text);
    expect(await api("GET", agents)).toEqual(first);
    expect((await api("GET", `/api/bots/${other.id}/documents/agents`)).text).toBe("");
    expect(JSON.stringify(await api("GET", "/api/bots"))).not.toContain(first.text);

    const direct = async (message: string) => {
      rmSync(fixture.fixtureDumpPath, { force: true });
      await control(["send", "--bot", bot.id, "--text", message]);
      await control(["wait", "--bot", bot.id, "--timeout", "30"]);
      return dump();
    };
    const initial = await direct("What should you record?");
    expect(initial.systemPrompt).toContain(first.text);
    expect(initial.systemPrompt).toContain(savedSoul.text);
    expect(initial.systemPrompt).not.toContain("External soul draft.");
    writeFileSync(agentsFile, "External agent draft.");
    const preview = await api("GET", `${path}/system-prompt`);
    expect(JSON.stringify(preview)).toContain(first.text);
    expect(JSON.stringify(preview)).not.toContain("External agent draft.");
    const stale = await api("PUT", agents, { text: "Draft", expectedHash: first.hash }, 409);
    expect(stale).toMatchObject({ code: "conflict", current: "External agent draft.", currentHash: expect.any(String) });
    const reopened = await api("GET", agents);
    expect(reopened.text).toBe(first.text);
    expect(reopened.hash).not.toBe(stale.currentHash);
    expect(await api("PUT", agents, { text: "Draft", expectedHash: reopened.hash }, 409)).toEqual(stale);
    expect(readFileSync(agentsFile, "utf8")).toBe("External agent draft.");
    writeFileSync(agentsFile, "Newer external agent draft.");
    const newer = await api("PUT", agents, { text: "Record the roses.", expectedHash: stale.currentHash }, 409);
    expect(newer).toMatchObject({ code: "conflict", current: "Newer external agent draft." });
    expect(newer.currentHash).not.toBe(stale.currentHash);
    expect(readFileSync(agentsFile, "utf8")).toBe(newer.current);
    const second = await api("PUT", agents, { text: "Record the roses.", expectedHash: newer.currentHash });
    const resumed = await direct("And what should you record now?");
    expect(resumed.argv).toContain("--resume");
    expect(resumed.systemPrompt).toContain(second.text);
    expect(resumed.systemPrompt).not.toContain(first.text);

    const { group } = await api("POST", "/api/groups", {
      name: "Fixture garden", memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    }, 201);
    rmSync(fixture.fixtureDumpPath, { force: true });
    await control(["send-channel", "--channel", group.id, "--text", "What do you record in the room?"]);
    await control(["wait", "--channel", group.id, "--timeout", "30"]);
    expect(dump().systemPrompt).toContain(second.text);
    const cleared = await api("PUT", agents, { text: "", expectedHash: second.hash });
    expect(await api("GET", agents)).toEqual(cleared);
    expect(JSON.stringify(await api("GET", `${path}/system-prompt`))).not.toContain("Agent instructions (AGENTS.md)");

    if (process.platform !== "win32") {
      rmSync(agentsFile);
      symlinkSync(soulFile, agentsFile);
      await api("GET", agents, undefined, 500);
      await api("PUT", agents, { text: "Overwrite link", expectedHash: cleared.hash }, 500);
      expect(readFileSync(soulFile, "utf8")).toBe("External soul draft.");
    }
    await api("GET", "/api/bots/no-such-bot/documents/agents", undefined, 404);
  } finally {
    await fixture.close();
  }
}, 90_000);
