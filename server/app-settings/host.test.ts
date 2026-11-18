import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { flushDecisionLog, readDecisions } from "../decision-log.ts";
import { UNDO_STALE } from "../direct-apply.ts";
import type { BotRecord } from "../store.ts";
import { createAppSettings, WRITE_BUDGET } from "./host.ts";
import { createSettingsRegistry } from "./registry.ts";

const OPENAI_KEY = "sk-live-9f8e7d6c5b4a3210";
const GATEWAY_KEY = "sk-gateway-0a1b2c3d";
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) {
    await flushDecisionLog(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(options: { owner?: boolean; guest?: boolean; group?: boolean; window?: boolean; savedStepsHere?: boolean; pinFailureId?: string; chosen?: string[]; engineGate?: Promise<void> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "app-settings-"));
  dirs.push(dataDir);
  const bots: BotRecord[] = [
    { id: "kiwi", name: "Kiwi", color: "#0f0", threadId: "t-kiwi", approvalMode: "full", section: "Sales" } as unknown as BotRecord,
    { id: "clive", name: "Clive", color: "#00f", threadId: "t-clive", approvalMode: "ask" } as unknown as BotRecord,
  ];
  const cfg = { language: "en", rooms: { turnTimeoutMinutes: 30 }, mcp: {}, threads: { maxConcurrentPerBot: 3 }, openai: { key: OPENAI_KEY }, anthropic: { url: "https://api.anthropic.com" },
    instances: { "openai-compat-gw": { driver: "openai-compat", displayName: "Gateway", config: { key: GATEWAY_KEY, url: "https://gw.example/v1" } } } } as unknown as AppConfig;
  const saved: Record<string, unknown>[] = [];
  const savedStepsHere = { value: options.savedStepsHere !== false };
  const pinCalls: Array<{ botId: string; pinned: boolean }> = [];
  const renameCalls: Array<{ botId: string; name: string }> = [];
  const colorCalls: Array<{ botId: string; color: string }> = [];
  const archiveCalls: Array<{ botId: string; archived: boolean; demoteChief: boolean }> = [];
  const helperCalls: Array<{ botId: string; shown: boolean }> = [];
  const engineCalls: unknown[] = [];
  const chosen = new Set(options.chosen ?? []);
  const messages: Array<Record<string, any>> = [];
  const windowValues = new Map<string, unknown>(options.window === false ? [] : [["appearance.skin", "daylight"]]);
  const windowWrites: Array<{ id: string; value: unknown }> = [];
  const store = {
    appendMessage: (threadId: string, message: Record<string, unknown>) => {
      const row = { ...message, id: `m${messages.length + 1}`, threadId };
      messages.push(row);
      return row as never;
    },
    bot: (id: string) => bots.find((bot) => bot.id === id),
    messagesFor: (threadId: string) => messages.filter((message) => message.threadId === threadId) as never,
    patchMessage: (threadId: string, messageId: string, patch: Record<string, unknown>) => {
      const row = messages.find((message) => message.threadId === threadId && message.id === messageId);
      if (row) Object.assign(row, patch);
      return null;
    },
    setActivity: () => null,
    setTaskActivity: () => null,
    taskByThread: () => ({ busy: true }),
  };
  const credentialCards: Record<string, unknown>[] = [];
  const entries = createSettingsRegistry({
    cfg: () => cfg,
    saveConfig: async (patch) => {
      if (patch.anthropic && typeof patch.anthropic === "object" && (patch.anthropic as { url?: string }).url === "https://refused.example") return "the provider refused it";
      saved.push(patch);
      const features = patch.features && typeof patch.features === "object" ? { ...cfg.features, ...patch.features } : undefined;
      Object.assign(cfg, patch);
      if (features) cfg.features = features;
      return null;
    },
    savedStepsHere: () => savedStepsHere.value,
    bots: () => bots,
    sections: () => ["Sales"],
    reorderBots: async (botIds) => { bots.sort((a, b) => botIds.indexOf(a.id) - botIds.indexOf(b.id)); return null; },
    pinBot: async (botId, pinned) => {
      pinCalls.push({ botId, pinned });
      if (botId === options.pinFailureId) return "pin change refused";
      const bot = bots.find((candidate) => candidate.id === botId);
      if (!bot) return "no such bot";
      bot.pinned = pinned;
      return null;
    },
    renameBot: async (botId, name) => {
      renameCalls.push({ botId, name });
      const bot = bots.find((candidate) => candidate.id === botId);
      if (!bot) return "no such bot";
      bot.name = name;
      return null;
    },
    colorBot: async (botId, color) => {
      colorCalls.push({ botId, color });
      const bot = bots.find((candidate) => candidate.id === botId);
      if (!bot) return "no such bot";
      bot.color = color;
      return null;
    },
    archiveBot: async (botId, archived, demoteChief) => {
      archiveCalls.push({ botId, archived, demoteChief });
      const bot = bots.find((candidate) => candidate.id === botId);
      if (!bot) return "no such bot";
      bot.hidden = archived;
      if (demoteChief) bot.chiefOfStaff = false;
      return null;
    },
    showHelper: async (botId, shown) => {
      helperCalls.push({ botId, shown });
      const bot = bots.find((candidate) => candidate.id === botId);
      if (!bot?.defaultBot) return "no such helper";
      bot.sidebarHidden = !shown;
      return null;
    },
    credentials: () => cfg,
    engines: () => [{ instanceId: "claude", name: "Claude", working: true }, { instanceId: "openai-compat-gw", name: "Gateway", working: true }],
    engineChosen: (instanceId) => chosen.has(instanceId),
    addEngine: async (path, body) => { engineCalls.push({ add: path, body }); await options.engineGate; return null; },
    removeEngine: async (instanceId) => { engineCalls.push({ remove: instanceId }); await options.engineGate; return null; },
    window: {
      read: (id) => windowValues.get(id),
      write: (id, value) => { if (!windowValues.size) return "Open mymausbot on this computer first."; windowWrites.push({ id, value }); windowValues.set(id, value); return null; },
    },
  });
  const notified: unknown[] = [];
  const host = createAppSettings({
    store: store as never, dataDir, entries, holdMs: 1_000,
    turnOwner: () => (options.owner === false ? null : "owner"),
    guestDriven: () => options.guest === true,
    requestCredential: async (_bot, _threadId, body) => { credentialCards.push(body); return { status: 201, body: { messageId: "secret-1", label: "OpenAI API key" } }; },
    connectorThread: () => ({ group: options.group ? { id: "g", name: "Room" } as never : undefined }),
    activeGroupTurnForBot: () => null,
    notify: (notification) => notified.push(notification),
    language: () => undefined,
  });
  const turn = { botId: "kiwi", threadId: "t-kiwi", generation: "gen-1" };
  const set = (id: string, value?: unknown, generation = turn.generation, ended?: AbortSignal) => host.handle({ action: "set", id, ...(value === undefined ? {} : { value }) }, { ...turn, generation }, ended);
  const answer = (requestId: string, behavior: "allow" | "deny", ownerReview = true) => {
    let sent: { status: number; body: unknown } | null = null;
    const res = { writeHead: (status: number) => { sent = { status, body: null }; }, end: (text: string) => { sent = { status: sent?.status ?? 0, body: JSON.parse(text) }; } } as unknown as ServerResponse;
    const claimed = host.resolveAndSend(res, { threadId: turn.threadId, requestId, behavior }, ownerReview);
    return { claimed, sent: sent as { status: number; body: Record<string, unknown> } | null };
  };
  const cards = () => messages.filter((message) => message.card?.appSettingRequest);
  return { host, cfg, saved, savedStepsHere, pinCalls, renameCalls, colorCalls, archiveCalls, helperCalls, windowWrites, engineCalls, chosen, messages, cards, credentialCards, notified, windowValues, bots, turn, set, answer, dataDir, entries };
}

describe("reads", () => {
  it("find lists matches with tier, value and where; get adds help and allowed values", async () => {
    const { host, turn } = fixture();
    const found = await host.handle({ action: "find", query: "dark mode" }, turn);
    const hits = JSON.parse(String(found.body.text)) as Array<Record<string, unknown>>;
    expect(hits[0]).toMatchObject({ id: "appearance.skin", tier: "safe", value: "daylight", where: "Settings → Appearance" });
    const got = await host.handle({ action: "get", id: "rooms.turnTimeoutMinutes" }, turn);
    expect(JSON.parse(String(got.body.text))).toMatchObject({ id: "rooms.turnTimeoutMinutes", value: "30", allowed: "1 to 1440 minutes", change: "set applies at once, with Undo on the card" });
  });

  it("reports the effective learned-skill sharing mode and refuses unavailable controls", async () => {
    const fx = fixture();
    fx.cfg.features = { shareLearnedSkills: "auto" };
    const get = async () => JSON.parse(String((await fx.host.handle({ action: "get", id: "bots.shareLearnedSkills" }, fx.turn)).body.text));
    expect(await get()).toMatchObject({ tier: "confirm", value: "off", allowed: "off, ask or auto" });
    expect((await fx.set("bots.shareLearnedSkills", "ask")).body.error).toContain("skills library");
    fx.cfg.features = { skillsLibrary: true };
    expect(await get()).toMatchObject({ value: "ask" });
    fx.cfg.features.skillAuthoring = false;
    expect((await fx.set("bots.shareLearnedSkills", "auto")).body.error).toContain("skill authoring");
    expect(fx.saved).toEqual([]);
    expect(fx.cards()).toEqual([]);
  });

  it("keeps settings details and writes out of a turn that is not the owner's", async () => {
    const { host, turn, set, saved, pinCalls, helperCalls, bots } = fixture({ owner: false });
    bots[1]!.defaultBot = {};
    expect((await host.handle({ action: "get", id: "bots.approvalModes" }, turn)).status).toBe(403);
    expect((await host.handle({ action: "find", query: "anthropic" }, turn)).status).toBe(403);
    const refused = await set("general.language", "de");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain("owner's own conversation");
    expect((await set("bots.pinned", ["kiwi"])).status).toBe(403);
    expect((await set("sidebar.showHelper", false)).status).toBe(403);
    expect(saved).toEqual([]);
    expect(pinCalls).toEqual([]);
    expect(helperCalls).toEqual([]);
  });

  it("refuses writes in a guest-driven conversation", async () => {
    const { host, turn, set, saved } = fixture({ guest: true });
    expect((await host.handle({ action: "get", id: "bots.groups" }, turn)).status).toBe(403);
    expect((await set("general.language", "de")).status).toBe(403);
    expect(saved).toEqual([]);
  });

  it("refuses an unknown id and a value the schema rejects", async () => {
    const { set, saved } = fixture();
    expect((await set("nope.nothing", 1)).status).toBe(404);
    const bad = await set("rooms.turnTimeoutMinutes", 100_000);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("1 to 1440 minutes");
    expect(saved).toEqual([]);
  });
  it("reads numbers and JSON lists from the text the tool sends", async () => {
    const { set, saved } = fixture();
    expect((await set("rooms.turnTimeoutMinutes", "45")).status).toBe(200);
    expect((await set("rooms.turnTimeoutMinutes", "lots")).status).toBe(400);
    expect(saved).toHaveLength(1);
  });
});

describe("safe tier", () => {
  it("applies at once, posts an applied card with Undo, and logs a decision", async () => {
    const { set, saved, cards, dataDir } = fixture();
    const result = await set("rooms.turnTimeoutMinutes", 45);
    expect(result.status).toBe(200);
    expect(result.body.text).toContain("Changed Room turn timeout from 30 to 45");
    expect(saved).toEqual([{ rooms: { turnTimeoutMinutes: 45 } }]);
    expect(cards()[0]!.card).toMatchObject({ autoApplied: true, answered: "allow", options: [], tool: "app_settings", appSettingRequest: { settingId: "rooms.turnTimeoutMinutes", before: "30", after: "45", tier: "safe" } });
    await flushDecisionLog(dataDir);
    expect(readDecisions(dataDir, 10)).toMatchObject([{ decision: "auto-approved", source: "app-settings", tool: "app_settings", summary: "rooms.turnTimeoutMinutes: 30 → 45", botId: "kiwi" }]);
  });

  it("undo restores the earlier value only while the current one is still the applied one", async () => {
    const { host, set, cfg, cards, turn, saved } = fixture();
    await set("rooms.turnTimeoutMinutes", 45);
    const requestId = String(cards()[0]!.card.requestId);
    cfg.rooms = { turnTimeoutMinutes: 60 };
    expect(await host.undo({ threadId: turn.threadId, requestId })).toMatchObject({ claimed: true, state: "invalid", error: UNDO_STALE, stale: true });
    cfg.rooms = { turnTimeoutMinutes: 45 };
    expect(await host.undo({ threadId: turn.threadId, requestId })).toEqual({ claimed: true, state: "undone" });
    expect(saved.at(-1)).toEqual({ rooms: { turnTimeoutMinutes: 30 } });
    expect(cards()[0]!.card.undone).toBe(true);
    expect(await host.undo({ threadId: turn.threadId, requestId })).toEqual({ claimed: true, state: "already_undone" });
  });

  it("restores an omitted default model without replacing other new-bot defaults", async () => {
    const { host, set, cfg, cards, turn, saved } = fixture();
    cfg.newBotDefaults = { profile: { name: "Keep" }, memory: {}, skills: [], routines: [] };
    expect(cfg.defaultModelSelection).toBeUndefined();
    expect((await set("bots.defaultModel", { instanceId: "codex", model: "fixture" })).status).toBe(200);
    const requestId = String(cards()[0]!.card.requestId);
    expect(await host.undo({ threadId: turn.threadId, requestId })).toEqual({ claimed: true, state: "undone" });
    expect(saved.at(-1)).toEqual({ defaultModelSelection: null });
    expect(cfg.newBotDefaults.profile.name).toBe("Keep");
  });

  it.each([
    ["effort", "high"], ["variant", "fast"], ["contextWindowTokens", 200_000],
  ] as const)("refuses stale default-model Undo after a later %s edit", async (field, value) => {
    const { host, set, cfg, cards, turn, saved } = fixture();
    cfg.defaultModelSelection = { instanceId: "codex", model: "before" };
    expect((await set("bots.defaultModel", { instanceId: "codex", model: "after" })).status).toBe(200);
    Object.assign(cfg.defaultModelSelection!, { [field]: value });
    const requestId = String(cards()[0]!.card.requestId);
    expect(await host.undo({ threadId: turn.threadId, requestId })).toMatchObject({ claimed: true, state: "invalid", error: UNDO_STALE, stale: true });
    expect(saved).toHaveLength(1);
  });

  it("uses bot identities when names cannot distinguish a later order change", async () => {
    const { host, set, bots, cards, turn } = fixture();
    bots[0]!.name = bots[1]!.name = "Same";
    expect((await set("bots.order", ["clive", "kiwi"])).status).toBe(200);
    bots.reverse();
    const requestId = String(cards()[0]!.card.requestId);
    expect(await host.undo({ threadId: turn.threadId, requestId })).toMatchObject({ claimed: true, state: "invalid", error: UNDO_STALE, stale: true });
  });

  it("a setting never saved reads as the default the app runs on, so Undo of its first change sets that default back", async () => {
    const { host, set, cfg, cards, turn, saved } = fixture();
    delete cfg.rooms; delete cfg.threads; cfg.mcp = {};
    for (const [id, value] of [["rooms.turnTimeoutMinutes", 45], ["mcp.callTimeoutMinutes", 20], ["threads.maxConcurrentPerBot", 7]] as const) {
      const before = cards().length;
      expect((await set(id, value)).status).toBe(200);
      const card = cards()[before]!.card;
      expect(card.appSettingRequest.before, id).toMatch(/^\d+$/);
      expect(await host.undo({ threadId: turn.threadId, requestId: String(card.requestId) }), id).toEqual({ claimed: true, state: "undone" });
    }
    expect(saved.slice(-1)).toEqual([{ threads: { maxConcurrentPerBot: Number(cards()[2]!.card.appSettingRequest.before) } }]);
    expect(saved).toContainEqual({ rooms: { turnTimeoutMinutes: 5 } });
    expect(saved).toContainEqual({ mcp: { callTimeoutMinutes: 10 } });
  });

  it("reorders bots with Undo, but leaves department moves to the owner", async () => {
    const { host, set, bots, cards, turn } = fixture();
    expect((await set("bots.order", ["clive", "kiwi"])).status).toBe(200);
    expect(bots.map((bot) => bot.id)).toEqual(["clive", "kiwi"]);
    expect(await host.undo({ threadId: turn.threadId, requestId: String(cards()[0]!.card.requestId) })).toEqual({ claimed: true, state: "undone" });
    expect(bots.map((bot) => bot.id)).toEqual(["kiwi", "clive"]);
    expect((await set("bots.groups", { Ops: ["clive"] })).body.error).toContain("only by the owner");
    expect(cards()).toHaveLength(1);
    expect(bots.map((bot) => bot.section)).toEqual(["Sales", undefined]);
  });

  it("sets the complete pinned-bot list and refuses stale Undo after another pin changes", async () => {
    const { host, set, bots, cards, turn, pinCalls } = fixture();
    const pins = () => bots.filter((bot) => bot.pinned).map((bot) => bot.id);
    expect((await set("bots.pinned", JSON.stringify(["clive"]))).status).toBe(200);
    expect(pins()).toEqual(["clive"]);
    expect((await set("bots.pinned", ["kiwi"])).status).toBe(200);
    expect(pins()).toEqual(["kiwi"]);
    expect(pinCalls).toEqual([{ botId: "clive", pinned: true }, { botId: "kiwi", pinned: true }, { botId: "clive", pinned: false }]);
    const requestId = String(cards()[1]!.card.requestId);
    bots[1]!.pinned = true;
    expect(await host.undo({ threadId: turn.threadId, requestId })).toMatchObject({ state: "invalid", error: UNDO_STALE, stale: true });
    expect(pins()).toEqual(["kiwi", "clive"]);
    bots[1]!.pinned = false;
    expect(await host.undo({ threadId: turn.threadId, requestId })).toEqual({ claimed: true, state: "undone" });
    expect(pins()).toEqual(["clive"]);
    expect((await set("bots.pinned", [])).status).toBe(200);
    expect(pins()).toEqual([]);
  });

  it("validates every requested id and reports a later route refusal without a success card or rollback", async () => {
    const { set, bots, cards, pinCalls } = fixture({ pinFailureId: "clive" });
    expect((await set("bots.pinned", ["kiwi", "ghost"])).body.error).toContain("No bot has the id ghost");
    expect(pinCalls).toEqual([]);
    const partial = await set("bots.pinned", ["kiwi", "clive"]);
    expect(partial.status).toBe(409);
    expect(partial.body.error).toContain("Pinned bots did not finish");
    expect(bots.filter((bot) => bot.pinned).map((bot) => bot.id)).toEqual(["kiwi"]);
    expect(cards()).toEqual([]);
  });

  it("a window preference refuses until a window has reported, then pushes the change", async () => {
    const closed = fixture({ window: false });
    const refused = await closed.set("appearance.skin", "midnight");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Open mymausbot on this computer first");
    const open = fixture();
    expect((await open.set("appearance.skin", "midnight")).status).toBe(200);
    expect(open.windowValues.get("appearance.skin")).toBe("midnight");
    expect((await open.set("appearance.skin", "neon")).status).toBe(400);
  });

  it(`stops after ${WRITE_BUDGET} writes in one turn and allows the next turn`, async () => {
    const { set } = fixture();
    for (let index = 0; index < WRITE_BUDGET; index += 1) expect((await set("rooms.turnTimeoutMinutes", 10 + index)).status).toBe(200);
    const over = await set("rooms.turnTimeoutMinutes", 99);
    expect(over.status).toBe(429);
    expect(over.body.error).toContain(`${WRITE_BUDGET} settings`);
    expect((await set("rooms.turnTimeoutMinutes", 99, "gen-2")).status).toBe(200);
  });
});

describe("confirm tier", () => {
  it("changes new-bot effort only after an owner's current Change and clears it to the provider default", async () => {
    const nonOwner = fixture({ owner: false });
    expect((await nonOwner.set("bots.newBotEffort", "high")).status).toBe(403);
    expect(nonOwner.saved).toEqual([]);

    const fx = fixture();
    fx.cfg.newBots = { effort: "medium" };
    const found = JSON.parse(String((await fx.host.handle({ action: "find", query: "new bot effort" }, fx.turn)).body.text));
    expect(found.map((entry: { id: string }) => entry.id)).toContain("bots.newBotEffort");
    const got = JSON.parse(String((await fx.host.handle({ action: "get", id: "bots.newBotEffort" }, fx.turn)).body.text));
    expect(got).toMatchObject({ tier: "confirm", value: "medium", change: expect.stringContaining("Change/Cancel") });
    expect((await fx.set("bots.newBotEffort", "turbo")).status).toBe(400);
    expect(fx.cards()).toEqual([]);

    const cancelled = fx.set("bots.newBotEffort", "high");
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(1));
    const first = fx.cards()[0]!.card;
    expect(first).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: expect.stringContaining("medium") } });
    expect(fx.saved).toEqual([]);
    fx.answer(String(first.requestId), "deny");
    expect((await cancelled).status).toBe(409);
    expect(fx.saved).toEqual([]);

    const stale = fx.set("bots.newBotEffort", "high");
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(2));
    fx.cfg.newBots = { effort: "low" };
    fx.answer(String(fx.cards()[1]!.card.requestId), "allow");
    expect((await stale).body.error).toContain("changed while the card was waiting");
    expect(fx.saved).toEqual([]);

    const approved = fx.set("bots.newBotEffort", "high");
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(3));
    const third = fx.cards()[2]!.card;
    expect(fx.answer(String(third.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    expect(fx.saved).toEqual([]);
    fx.answer(String(third.requestId), "allow");
    expect((await approved).status).toBe(200);
    expect(fx.saved).toEqual([{ newBots: { effort: "high" } }]);
    expect(await fx.host.undo({ threadId: fx.turn.threadId, requestId: String(third.requestId) })).toMatchObject({ state: "invalid" });

    const cleared = fx.set("bots.newBotEffort", "null");
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(4));
    expect(fx.cards()[3]!.card.appSettingRequest.after).toContain("provider default");
    fx.answer(String(fx.cards()[3]!.card.requestId), "allow");
    expect((await cleared).status).toBe(200);
    expect(fx.saved[1]).toEqual({ newBots: { effort: null } });
    const after = JSON.parse(String((await fx.host.handle({ action: "get", id: "bots.newBotEffort" }, fx.turn)).body.text));
    expect(after.value).toBe("provider default");
  });

  it("changes the run card only after owner review, refusing an absent window value and a stale card", async () => {
    const fx = fixture();
    expect((await fx.set("appearance.runCard", false)).status).toBe(409);
    expect(fx.cards()).toEqual([]);
    fx.windowValues.set("appearance.runCard", true);
    const found = JSON.parse(String((await fx.host.handle({ action: "find", query: "run card" }, fx.turn)).body.text));
    expect(found.map((entry: { id: string }) => entry.id)).toContain("appearance.runCard");
    const got = JSON.parse(String((await fx.host.handle({ action: "get", id: "appearance.runCard" }, fx.turn)).body.text));
    expect(got).toMatchObject({ tier: "confirm", value: "shown", change: "set shows the user a Change/Cancel card and waits" });
    expect((await fx.set("appearance.runCard", "not a boolean")).status).toBe(400);

    const cancelled = fx.set("appearance.runCard", false);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(1));
    const first = fx.cards()[0]!.card;
    expect(first).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: "Hide the card that follows each run; currently shown" } });
    fx.answer(String(first.requestId), "deny");
    expect((await cancelled).status).toBe(409);
    expect(fx.windowWrites).toEqual([]);

    const stale = fx.set("appearance.runCard", false);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(2));
    fx.windowValues.set("appearance.runCard", false);
    fx.answer(String(fx.cards()[1]!.card.requestId), "allow");
    expect((await stale).body.error).toContain("changed while the card was waiting");
    expect(fx.windowWrites).toEqual([]);

    fx.windowValues.set("appearance.runCard", true);
    const approved = fx.set("appearance.runCard", false);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(3));
    const third = fx.cards()[2]!.card;
    expect(fx.answer(String(third.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    expect(fx.windowWrites).toEqual([]);
    fx.answer(String(third.requestId), "allow");
    expect((await approved).status).toBe(200);
    expect(fx.windowWrites).toEqual([{ id: "appearance.runCard", value: false }]);
    expect(fx.windowValues.get("appearance.runCard")).toBe(false);
    expect(await fx.host.undo({ threadId: fx.turn.threadId, requestId: String(third.requestId) })).toMatchObject({ state: "invalid" });
  });

  it("changes tool-call visibility only after owner Change and rejects a stale card", async () => {
    const fx = fixture();
    const found = JSON.parse(String((await fx.host.handle({ action: "find", query: "show tool calls" }, fx.turn)).body.text));
    expect(found.map((entry: { id: string }) => entry.id)).toContain("appearance.toolCalls");
    const get = () => fx.host.handle({ action: "get", id: "appearance.toolCalls" }, fx.turn);
    expect(JSON.parse(String((await get()).body.text))).toMatchObject({ tier: "confirm", value: "hidden", change: "set shows the user a Change/Cancel card and waits" });
    expect((await fx.set("appearance.toolCalls", "yes")).status).toBe(400);

    const cancelled = fx.set("appearance.toolCalls", "true");
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(1));
    const first = fx.cards()[0]!.card;
    expect(first).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: "Show tool calls in conversations; currently hidden" } });
    fx.answer(String(first.requestId), "deny");
    expect((await cancelled).status).toBe(409);
    expect(fx.saved).toEqual([]);

    const stale = fx.set("appearance.toolCalls", true);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(2));
    fx.cfg.features = { showToolCalls: true };
    fx.answer(String(fx.cards()[1]!.card.requestId), "allow");
    expect((await stale).body.error).toContain("changed while the card was waiting");
    expect(fx.saved).toEqual([]);
    fx.cfg.features = { showToolCalls: false };

    const approved = fx.set("appearance.toolCalls", true);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(3));
    const third = fx.cards()[2]!.card;
    expect(fx.answer(String(third.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    expect(fx.saved).toEqual([]);
    fx.answer(String(third.requestId), "allow");
    expect((await approved).status).toBe(200);
    expect(fx.saved).toEqual([{ features: { showToolCalls: true } }]);
    expect(JSON.parse(String((await get()).body.text))).toMatchObject({ value: "shown" });
    expect(await fx.host.undo({ threadId: fx.turn.threadId, requestId: String(third.requestId) })).toMatchObject({ state: "invalid" });

    const hidden = fx.set("appearance.toolCalls", false);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(4));
    const fourth = fx.cards()[3]!.card;
    expect(fourth.appSettingRequest.after).toBe("Hide tool calls in conversations; currently shown");
    fx.answer(String(fourth.requestId), "allow");
    expect((await hidden).status).toBe(200);
    expect(fx.saved.at(-1)).toEqual({ features: { showToolCalls: false } });
    expect(JSON.parse(String((await get()).body.text))).toMatchObject({ value: "hidden" });

    const nonOwner = fixture({ owner: false });
    expect((await nonOwner.set("appearance.toolCalls", false)).status).toBe(403);
    expect(nonOwner.saved).toEqual([]);
  });

  it("changes skill authoring only after owner Change and rechecks its review effect", async () => {
    const fx = fixture();
    fx.cfg.features = { skillReview: true };
    const found = JSON.parse(String((await fx.host.handle({ action: "find", query: "write skills" }, fx.turn)).body.text));
    expect(found.map((entry: { id: string }) => entry.id)).toContain("bots.skillAuthoring");
    const get = () => fx.host.handle({ action: "get", id: "bots.skillAuthoring" }, fx.turn);
    expect(JSON.parse(String((await get()).body.text))).toMatchObject({ tier: "confirm", value: "on" });
    expect((await fx.set("bots.skillAuthoring", "off")).status).toBe(400);

    const cancelled = fx.set("bots.skillAuthoring", "false");
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(1));
    const first = fx.cards()[0]!.card;
    expect(first).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: "Stop bots drafting skills and pause automatic skill review; currently on" } });
    fx.answer(String(first.requestId), "deny");
    expect((await cancelled).status).toBe(409);
    expect(fx.saved).toEqual([]);

    const staleReview = fx.set("bots.skillAuthoring", false);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(2));
    fx.cfg.features = { skillReview: false };
    fx.answer(String(fx.cards()[1]!.card.requestId), "allow");
    expect((await staleReview).body.error).toContain("changed while the card was waiting");
    expect(fx.saved).toEqual([]);
    fx.cfg.features = { skillReview: true };

    const staleToggle = fx.set("bots.skillAuthoring", false);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(3));
    fx.cfg.features = { skillAuthoring: false, skillReview: true };
    fx.answer(String(fx.cards()[2]!.card.requestId), "allow");
    expect((await staleToggle).body.error).toContain("changed while the card was waiting");
    expect(fx.saved).toEqual([]);
    fx.cfg.features = { skillReview: true };

    const approved = fx.set("bots.skillAuthoring", false);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(4));
    const fourth = fx.cards()[3]!.card;
    expect(fx.answer(String(fourth.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    expect(fx.saved).toEqual([]);
    fx.answer(String(fourth.requestId), "allow");
    expect((await approved).status).toBe(200);
    expect(fx.saved).toEqual([{ features: { skillAuthoring: false } }]);
    expect(JSON.parse(String((await get()).body.text))).toMatchObject({ value: "off" });
    expect(await fx.host.undo({ threadId: fx.turn.threadId, requestId: String(fourth.requestId) })).toMatchObject({ state: "invalid" });

    const resume = fixture();
    resume.cfg.features = { skillAuthoring: false, skillReview: true };
    const enabled = resume.set("bots.skillAuthoring", true);
    await vi.waitFor(() => expect(resume.cards()).toHaveLength(1));
    const card = resume.cards()[0]!.card;
    expect(card.appSettingRequest.after).toBe("Let bots draft skills for your review and allow automatic skill review again; currently off");
    resume.answer(String(card.requestId), "allow");
    expect((await enabled).status).toBe(200);
    expect(resume.saved).toEqual([{ features: { skillAuthoring: true } }]);

    const nonOwner = fixture({ owner: false });
    expect((await nonOwner.set("bots.skillAuthoring", false)).status).toBe(403);
    expect(nonOwner.saved).toEqual([]);
  });

  it("keeps the approved cache window and bot overrides while refusing stale keep-warm cards", async () => {
    const fx = fixture();
    const get = () => fx.host.handle({ action: "get", id: "bots.keepWarm" }, fx.turn);
    expect(JSON.parse(String((await get()).body.text))).toMatchObject({ tier: "confirm", value: '{"enabled":false,"windowMinutes":180}', help: expect.stringContaining("including bots explicitly set to On") });
    fx.cfg.cacheKeepWarm = { enabled: false, windowMinutes: 120 };
    fx.bots[1]!.cacheKeepWarm = false;
    const found = JSON.parse(String((await fx.host.handle({ action: "find", query: "keep warm" }, fx.turn)).body.text));
    expect(found.map((entry: { id: string }) => entry.id)).toContain("bots.keepWarm");
    expect((await fx.set("bots.keepWarm", { enabled: "true" })).status).toBe(400);
    expect((await fx.set("bots.keepWarm", { enabled: true, windowMinutes: 14 })).status).toBe(400);

    const cancelled = fx.set("bots.keepWarm", { enabled: true });
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(1));
    const first = fx.cards()[0]!.card;
    expect(first).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: expect.stringContaining("place default from off to on and shared window from 120 to 120 minutes") } });
    expect(first.appSettingRequest.after).toContain("Each ping spends a few tokens");
    expect(first.appSettingRequest.after).toContain("per-bot on/off choices stay unchanged");
    fx.answer(String(first.requestId), "deny");
    expect((await cancelled).status).toBe(409);
    expect(fx.saved).toEqual([]);

    const stale = fx.set("bots.keepWarm", { enabled: true });
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(2));
    fx.cfg.cacheKeepWarm = { enabled: false, windowMinutes: 360 };
    fx.answer(String(fx.cards()[1]!.card.requestId), "allow");
    expect((await stale).body.error).toContain("changed while the card was waiting");
    expect(fx.saved).toEqual([]);
    fx.cfg.cacheKeepWarm = { enabled: false, windowMinutes: 120 };

    const approved = fx.set("bots.keepWarm", '{"enabled":true}');
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(3));
    const third = fx.cards()[2]!.card;
    expect(fx.answer(String(third.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    expect(fx.saved).toEqual([]);
    fx.answer(String(third.requestId), "allow");
    expect((await approved).status).toBe(200);
    expect(fx.saved).toEqual([{ cacheKeepWarm: { enabled: true, windowMinutes: 120 } }]);
    expect(fx.bots[1]!.cacheKeepWarm).toBe(false);
    expect(await fx.host.undo({ threadId: fx.turn.threadId, requestId: String(third.requestId) })).toMatchObject({ state: "invalid" });

    const disabled = fx.set("bots.keepWarm", { enabled: false, windowMinutes: 60 });
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(4));
    const fourth = fx.cards()[3]!.card;
    expect(fourth.appSettingRequest.after).toContain("place default from on to off and shared window from 120 to 60 minutes");
    fx.answer(String(fourth.requestId), "allow");
    expect((await disabled).status).toBe(200);
    expect(fx.saved.at(-1)).toEqual({ cacheKeepWarm: { enabled: false, windowMinutes: 60 } });
    expect(JSON.parse(String((await get()).body.text))).toMatchObject({ value: '{"enabled":false,"windowMinutes":60}' });

    fx.bots[1]!.cacheKeepWarm = true;
    const sharedWindow = fx.set("bots.keepWarm", { enabled: false, windowMinutes: 1440 });
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(5));
    const fifth = fx.cards()[4]!.card;
    expect(fifth.appSettingRequest.after).toContain("place default from off to off and shared window from 60 to 1440 minutes");
    expect(fifth.appSettingRequest.after).toContain("including bots explicitly set to On, use that window after a successful turn");
    fx.answer(String(fifth.requestId), "allow");
    expect((await sharedWindow).status).toBe(200);
    expect(fx.saved.at(-1)).toEqual({ cacheKeepWarm: { enabled: false, windowMinutes: 1440 } });
    expect(fx.bots[1]!.cacheKeepWarm).toBe(true);

    const nonOwner = fixture({ owner: false });
    expect((await nonOwner.set("bots.keepWarm", { enabled: true })).status).toBe(403);
    expect(nonOwner.saved).toEqual([]);
  });

  it("changes the event-log cap only after owner review and warns that trimming cannot be undone", async () => {
    const fx = fixture();
    const get = () => fx.host.handle({ action: "get", id: "threads.eventLogMaxBytes" }, fx.turn);
    const found = JSON.parse(String((await fx.host.handle({ action: "find", query: "event log size" }, fx.turn)).body.text));
    expect(found.map((entry: { id: string }) => entry.id)).toContain("threads.eventLogMaxBytes");
    expect(JSON.parse(String((await get()).body.text))).toMatchObject({ tier: "confirm", value: "no limit", allowed: expect.stringContaining("null for no limit") });
    expect((await fx.set("threads.eventLogMaxBytes", 262_143)).status).toBe(400);
    expect((await fx.set("threads.eventLogMaxBytes", 4 * 1024 ** 3 + 1)).status).toBe(400);
    expect((await fx.set("threads.eventLogMaxBytes", "unknown")).status).toBe(400);
    expect(fx.saved).toEqual([]);

    const cancelled = fx.set("threads.eventLogMaxBytes", 1_048_576);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(1));
    const first = fx.cards()[0]!.card;
    expect(first).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: expect.stringContaining("no limit to 1048576 bytes") } });
    expect(first.appSettingRequest.after).toContain("permanently trim older event and native log entries");
    fx.answer(String(first.requestId), "deny");
    expect((await cancelled).status).toBe(409);
    expect(fx.saved).toEqual([]);

    const stale = fx.set("threads.eventLogMaxBytes", 1_048_576);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(2));
    fx.cfg.threads = { maxConcurrentPerBot: 3, eventLogRetentionDays: 30, eventLogMaxBytes: 2_097_152 };
    fx.answer(String(fx.cards()[1]!.card.requestId), "allow");
    expect((await stale).body.error).toContain("changed while the card was waiting");
    expect(fx.saved).toEqual([]);
    delete fx.cfg.threads.eventLogMaxBytes;

    const approved = fx.set("threads.eventLogMaxBytes", 1_048_576);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(3));
    const third = fx.cards()[2]!.card;
    expect(fx.answer(String(third.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    expect(fx.saved).toEqual([]);
    fx.answer(String(third.requestId), "allow");
    expect((await approved).status).toBe(200);
    expect(fx.saved).toEqual([{ threads: { eventLogMaxBytes: 1_048_576 } }]);
    expect(JSON.parse(String((await get()).body.text))).toMatchObject({ value: "1048576 bytes" });
    expect(await fx.host.undo({ threadId: fx.turn.threadId, requestId: String(third.requestId) })).toMatchObject({ state: "invalid" });

    const cleared = fx.set("threads.eventLogMaxBytes", null);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(4));
    const fourth = fx.cards()[3]!.card;
    expect(fourth.appSettingRequest.after).toContain("previously trimmed entries cannot be restored");
    fx.answer(String(fourth.requestId), "allow");
    expect((await cleared).status).toBe(200);
    expect(fx.saved.at(-1)).toEqual({ threads: { eventLogMaxBytes: null } });
    expect(JSON.parse(String((await get()).body.text))).toMatchObject({ value: "no limit" });

    const nonOwner = fixture({ owner: false });
    expect((await nonOwner.set("threads.eventLogMaxBytes", 1_048_576)).status).toBe(403);
    expect(nonOwner.saved).toEqual([]);
  });

  it("changes learned-skill sharing only after owner review of the live mode", async () => {
    const fx = fixture();
    fx.cfg.features = { skillsLibrary: true };
    expect((await fx.set("bots.shareLearnedSkills", "always")).status).toBe(400);
    const first = fx.set("bots.shareLearnedSkills", "auto");
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(1));
    const cancelled = fx.cards()[0]!.card;
    expect(cancelled).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", settingId: "bots.shareLearnedSkills" } });
    expect(cancelled.subtitle).toContain("eligible bots in the same department under visibility checks; currently ask");
    expect(fx.answer(String(cancelled.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    fx.answer(String(cancelled.requestId), "deny");
    expect((await first).status).toBe(409);
    expect(fx.saved).toEqual([]);

    const stale = fx.set("bots.shareLearnedSkills", "auto");
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(2));
    fx.cfg.features.shareLearnedSkills = "off";
    fx.answer(String(fx.cards()[1]!.card.requestId), "allow");
    expect((await stale).body.error).toContain("changed while the card was waiting");
    expect(fx.saved).toEqual([]);

    const disabled = fx.set("bots.shareLearnedSkills", "auto");
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(3));
    fx.cfg.features.skillsLibrary = false;
    fx.answer(String(fx.cards()[2]!.card.requestId), "allow");
    expect((await disabled).body.error).toContain("skills library");
    expect(fx.saved).toEqual([]);

    fx.cfg.features.skillsLibrary = true;
    const noAuthoring = fx.set("bots.shareLearnedSkills", "auto");
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(4));
    fx.cfg.features.skillAuthoring = false;
    fx.answer(String(fx.cards()[3]!.card.requestId), "allow");
    expect((await noAuthoring).body.error).toContain("skill authoring");
    expect(fx.saved).toEqual([]);

    fx.cfg.features.skillAuthoring = true;
    const approved = fx.set("bots.shareLearnedSkills", "auto");
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(5));
    const requestId = String(fx.cards()[4]!.card.requestId);
    fx.answer(requestId, "allow");
    expect((await approved).status).toBe(200);
    expect(fx.saved).toEqual([{ features: { shareLearnedSkills: "auto" } }]);
    expect(fx.cfg.features).toMatchObject({ skillsLibrary: true, skillAuthoring: true, shareLearnedSkills: "auto" });
    expect(await fx.host.undo({ threadId: fx.turn.threadId, requestId })).toMatchObject({ state: "invalid" });
  });

  it("reads effective skill review state and permits owner-approved disabling of a dormant setting", async () => {
    const fx = fixture();
    const defaultRead = JSON.parse(String((await fx.host.handle({ action: "get", id: "bots.skillReview" }, fx.turn)).body.text));
    expect(JSON.parse(defaultRead.value)).toEqual({ enabled: false, steps: 10 });
    fx.cfg.features = { skillAuthoring: false, skillReview: true, skillReviewSteps: 7, showToolCalls: true };
    const found = JSON.parse(String((await fx.host.handle({ action: "find", query: "skill review" }, fx.turn)).body.text));
    expect(found).toContainEqual(expect.objectContaining({ id: "bots.skillReview", tier: "confirm" }));
    const got = JSON.parse(String((await fx.host.handle({ action: "get", id: "bots.skillReview" }, fx.turn)).body.text));
    expect(JSON.parse(got.value)).toEqual({ enabled: false, steps: 7, pausedUntilAuthoringOn: true });
    expect(got).toMatchObject({ allowed: expect.stringContaining("3-100"), help: expect.stringContaining("create or update learned skills") });
    for (const value of [{ enabled: "true" }, { enabled: false, steps: 2 }, { enabled: false, steps: 101 }, { enabled: false, steps: 7.5 }, { enabled: false, extra: true }]) {
      expect((await fx.set("bots.skillReview", value)).status).toBe(400);
    }
    expect((await fx.set("bots.skillReview", { enabled: true })).body.error).toContain("Turn on bot skill authoring");
    expect(fx.saved).toEqual([]);
    expect(fx.cards()).toEqual([]);

    const disabling = fx.set("bots.skillReview", { enabled: false });
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(1));
    const card = fx.cards()[0]!.card;
    expect(card).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: expect.stringContaining("pausedUntilAuthoringOn") } });
    fx.answer(String(card.requestId), "allow");
    expect((await disabling).status).toBe(200);
    expect(fx.saved).toEqual([{ features: { skillReview: false } }]);
    expect(fx.cfg.features).toEqual({ skillAuthoring: false, skillReview: false, skillReviewSteps: 7, showToolCalls: true });
    expect(JSON.parse(JSON.parse(String((await fx.host.handle({ action: "get", id: "bots.skillReview" }, fx.turn)).body.text)).value)).toEqual({ enabled: false, steps: 7 });
    expect(await fx.host.undo({ threadId: fx.turn.threadId, requestId: String(card.requestId) })).toMatchObject({ state: "invalid" });
    expect((await fixture({ owner: false }).set("bots.skillReview", { enabled: false })).status).toBe(403);
    expect((await fixture({ guest: true }).set("bots.skillReview", { enabled: false })).status).toBe(403);
  });

  it("holds skill review changes for owner Change and rejects Cancel or stale approval", async () => {
    const fx = fixture();
    fx.cfg.features = { skillAuthoring: true, skillReview: false, skillReviewSteps: 8, showToolCalls: true };
    const change = { enabled: true, steps: 11 };
    const cancelled = fx.set("bots.skillReview", change);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(1));
    const first = fx.cards()[0]!.card;
    expect(first.appSettingRequest).toMatchObject({ tier: "confirm", after: expect.stringContaining("create or update learned skills") });
    expect(fx.saved).toEqual([]);
    fx.answer(String(first.requestId), "deny");
    expect((await cancelled).status).toBe(409);

    const staleThreshold = fx.set("bots.skillReview", change);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(2));
    fx.cfg.features.skillReviewSteps = 9;
    fx.answer(String(fx.cards()[1]!.card.requestId), "allow");
    expect((await staleThreshold).body.error).toContain("changed while the card was waiting");
    expect(fx.saved).toEqual([]);

    const staleMode = fx.set("bots.skillReview", change);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(3));
    fx.cfg.features.skillReview = true;
    fx.answer(String(fx.cards()[2]!.card.requestId), "allow");
    expect((await staleMode).body.error).toContain("changed while the card was waiting");
    expect(fx.saved).toEqual([]);
    fx.cfg.features.skillReview = false;

    const staleAuthoring = fx.set("bots.skillReview", change);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(4));
    fx.cfg.features.skillAuthoring = false;
    fx.answer(String(fx.cards()[3]!.card.requestId), "allow");
    expect((await staleAuthoring).body.error).toContain("Turn on bot skill authoring");
    expect(fx.saved).toEqual([]);
    fx.cfg.features.skillAuthoring = true;

    const approved = fx.set("bots.skillReview", change);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(5));
    const card = fx.cards()[4]!.card;
    expect(fx.answer(String(card.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    expect(fx.saved).toEqual([]);
    fx.answer(String(card.requestId), "allow");
    expect((await approved).status).toBe(200);
    expect(fx.saved).toEqual([{ features: { skillReview: true, skillReviewSteps: 11 } }]);
    expect(fx.cfg.features).toEqual({ skillAuthoring: true, skillReview: true, skillReviewSteps: 11, showToolCalls: true });
    expect(await fx.host.undo({ threadId: fx.turn.threadId, requestId: String(card.requestId) })).toMatchObject({ state: "invalid" });
  });

  it("changes saved computer steps only after owner Change and keeps other features", async () => {
    const fx = fixture();
    fx.cfg.features = { showToolCalls: true };
    const found = JSON.parse(String((await fx.host.handle({ action: "find", query: "saved steps" }, fx.turn)).body.text));
    expect(found).toContainEqual(expect.objectContaining({ id: "desktops.savedSteps", tier: "confirm" }));
    const got = JSON.parse(String((await fx.host.handle({ action: "get", id: "desktops.savedSteps" }, fx.turn)).body.text));
    expect(JSON.parse(got.value)).toEqual({ enabled: true, availableHere: true });
    expect(got.help).toContain("existing saved steps stay stored");
    for (const invalid of [1, "maybe", { enabled: false }]) expect((await fx.set("desktops.savedSteps", invalid)).status).toBe(400);
    expect(fx.cards()).toEqual([]);

    const cancelled = fx.set("desktops.savedSteps", false);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(1));
    const first = fx.cards()[0]!.card;
    expect(first).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: expect.stringContaining("existing saved steps stay stored") } });
    expect(fx.saved).toEqual([]);
    fx.answer(String(first.requestId), "deny");
    expect((await cancelled).status).toBe(409);

    const stale = fx.set("desktops.savedSteps", false);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(2));
    fx.cfg.features.savedSteps = false;
    fx.answer(String(fx.cards()[1]!.card.requestId), "allow");
    expect((await stale).body.error).toContain("changed while the card was waiting");
    expect(fx.saved).toEqual([]);
    fx.cfg.features.savedSteps = true;

    const approved = fx.set("desktops.savedSteps", false);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(3));
    const card = fx.cards()[2]!.card;
    expect(fx.answer(String(card.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    expect(fx.saved).toEqual([]);
    fx.answer(String(card.requestId), "allow");
    expect((await approved).status).toBe(200);
    expect(fx.saved).toEqual([{ features: { savedSteps: false } }]);
    expect(fx.cfg.features).toEqual({ showToolCalls: true, savedSteps: false });
    expect(await fx.host.undo({ threadId: fx.turn.threadId, requestId: String(card.requestId) })).toMatchObject({ state: "invalid" });

    const enabled = fx.set("desktops.savedSteps", true);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(4));
    fx.answer(String(fx.cards()[3]!.card.requestId), "allow");
    expect((await enabled).status).toBe(200);
    expect(fx.saved[1]).toEqual({ features: { savedSteps: true } });
    for (const blocked of [fixture({ owner: false }), fixture({ guest: true })]) {
      expect((await blocked.set("desktops.savedSteps", true)).status).toBe(403);
      expect(blocked.saved).toEqual([]);
    }
  });

  it("reports unavailable saved steps and refuses enabling when support disappears", async () => {
    const fx = fixture({ savedStepsHere: false });
    fx.cfg.features = { savedSteps: true, showToolCalls: true };
    const got = JSON.parse(String((await fx.host.handle({ action: "get", id: "desktops.savedSteps" }, fx.turn)).body.text));
    expect(JSON.parse(got.value)).toEqual({ enabled: false, availableHere: false, savedOn: true });
    expect((await fx.set("desktops.savedSteps", true)).body.error).toContain("cannot run on this computer");
    expect(fx.cards()).toEqual([]);
    expect(fx.saved).toEqual([]);

    const stale = fx.set("desktops.savedSteps", false);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(1));
    fx.savedStepsHere.value = true;
    fx.answer(String(fx.cards()[0]!.card.requestId), "allow");
    expect((await stale).body.error).toContain("changed while the card was waiting");
    expect(fx.saved).toEqual([]);

    fx.savedStepsHere.value = false;
    const disabling = fx.set("desktops.savedSteps", false);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(2));
    fx.answer(String(fx.cards()[1]!.card.requestId), "allow");
    expect((await disabling).status).toBe(200);
    expect(fx.saved).toEqual([{ features: { savedSteps: false } }]);
    expect(fx.cfg.features).toEqual({ savedSteps: false, showToolCalls: true });

    fx.savedStepsHere.value = true;
    const enabling = fx.set("desktops.savedSteps", true);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(3));
    fx.savedStepsHere.value = false;
    fx.answer(String(fx.cards()[2]!.card.requestId), "allow");
    expect((await enabling).body.error).toContain("cannot run on this computer");
    expect(fx.saved).toHaveLength(1);
  });

  it("changes the stored sidebar-thread choice only after a live owner's review", async () => {
    const fx = fixture();
    fx.windowValues.set("appearance.showThreads", false);
    const found = JSON.parse(String((await fx.host.handle({ action: "find", query: "show threads" }, fx.turn)).body.text));
    expect(found).toEqual(expect.arrayContaining([expect.objectContaining({ id: "appearance.showThreads", tier: "confirm", value: "false" })]));
    const got = JSON.parse(String((await fx.host.handle({ action: "get", id: "appearance.showThreads" }, fx.turn)).body.text));
    expect(got).toMatchObject({ value: "false", help: expect.stringContaining("Advanced mode") });
    expect((await fx.set("appearance.showThreads", "yes")).status).toBe(400);
    expect((await fx.set("appearance.showThreads", false)).status).toBe(409);
    expect(fx.windowWrites).toEqual([]);

    const cancelled = fx.set("appearance.showThreads", true);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(1));
    const first = fx.cards()[0]!.card;
    expect(first).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: expect.stringContaining("Advanced mode") } });
    fx.answer(String(first.requestId), "deny");
    expect((await cancelled).status).toBe(409);
    expect(fx.windowWrites).toEqual([]);

    const stale = fx.set("appearance.showThreads", true);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(2));
    fx.windowValues.set("appearance.showThreads", true);
    fx.answer(String(fx.cards()[1]!.card.requestId), "allow");
    expect((await stale).status).toBe(409);
    expect(fx.windowWrites).toEqual([]);

    fx.windowValues.set("appearance.showThreads", false);
    const disconnected = fx.set("appearance.showThreads", true);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(3));
    fx.windowValues.delete("appearance.showThreads");
    fx.answer(String(fx.cards()[2]!.card.requestId), "allow");
    expect((await disconnected).status).toBe(409);
    expect(fx.windowWrites).toEqual([]);

    fx.windowValues.set("appearance.showThreads", false);
    const approved = fx.set("appearance.showThreads", true);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(4));
    const fourth = fx.cards()[3]!.card;
    expect(fx.answer(String(fourth.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    expect(fx.windowWrites).toEqual([]);
    fx.answer(String(fourth.requestId), "allow");
    expect((await approved).status).toBe(200);
    expect(fx.windowWrites).toEqual([{ id: "appearance.showThreads", value: true }]);
    expect(await fx.host.undo({ threadId: fx.turn.threadId, requestId: String(fourth.requestId) })).toMatchObject({ state: "invalid" });

    const closed = fixture({ window: false });
    expect((await closed.set("appearance.showThreads", true)).status).toBe(409);
    expect(closed.cards()).toEqual([]);
    expect(closed.windowWrites).toEqual([]);
    const guest = fixture({ owner: false });
    guest.windowValues.set("appearance.showThreads", false);
    expect((await guest.set("appearance.showThreads", true)).status).toBe(403);
    expect(guest.windowWrites).toEqual([]);
  });

  it("changes coloured message bubbles only after a live owner's review", async () => {
    const fx = fixture();
    fx.windowValues.set("appearance.userBubbles", true);
    const found = JSON.parse(String((await fx.host.handle({ action: "find", query: "message colour" }, fx.turn)).body.text));
    expect(found).toEqual(expect.arrayContaining([expect.objectContaining({ id: "appearance.userBubbles", tier: "confirm", value: expect.stringContaining("saved on for Simple and Advanced") })]));
    const got = JSON.parse(String((await fx.host.handle({ action: "get", id: "appearance.userBubbles" }, fx.turn)).body.text));
    expect(got).toMatchObject({ value: expect.stringContaining("Raw keeps its fixed styling"), help: expect.stringContaining("off uses normal theme bubbles") });
    expect(got.help).toContain("ordinary bots stay coloured and the main bot stays dark");
    expect((await fx.set("appearance.userBubbles", "no")).status).toBe(400);
    const sameOn = await fx.set("appearance.userBubbles", true);
    expect(sameOn.status).toBe(409);
    expect(sameOn.body.error).toContain("saved Simple/Advanced colour choice is already on");
    expect(sameOn.body.error).toContain("Raw keeps its fixed styling");
    expect(fx.windowWrites).toEqual([]);

    const cancelled = fx.set("appearance.userBubbles", false);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(1));
    const first = fx.cards()[0]!.card;
    expect(first).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: expect.stringContaining("normal theme message bubbles for Simple and Advanced") } });
    expect(first.appSettingRequest.after).toContain("Raw keeps its fixed styling");
    fx.answer(String(first.requestId), "deny");
    expect((await cancelled).status).toBe(409);
    expect(fx.windowWrites).toEqual([]);

    const stale = fx.set("appearance.userBubbles", false);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(2));
    fx.windowValues.set("appearance.userBubbles", false);
    fx.answer(String(fx.cards()[1]!.card.requestId), "allow");
    expect((await stale).status).toBe(409);
    expect(fx.windowWrites).toEqual([]);

    fx.windowValues.set("appearance.userBubbles", true);
    const disconnected = fx.set("appearance.userBubbles", false);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(3));
    fx.windowValues.delete("appearance.userBubbles");
    fx.answer(String(fx.cards()[2]!.card.requestId), "allow");
    expect((await disconnected).status).toBe(409);
    expect(fx.windowWrites).toEqual([]);

    fx.windowValues.set("appearance.userBubbles", true);
    const approved = fx.set("appearance.userBubbles", false);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(4));
    const fourth = fx.cards()[3]!.card;
    expect(fx.answer(String(fourth.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    expect(fx.windowWrites).toEqual([]);
    fx.answer(String(fourth.requestId), "allow");
    expect((await approved).status).toBe(200);
    expect(fx.windowWrites).toEqual([{ id: "appearance.userBubbles", value: false }]);
    expect(fx.windowValues.get("appearance.skin")).toBe("daylight");
    expect(await fx.host.undo({ threadId: fx.turn.threadId, requestId: String(fourth.requestId) })).toMatchObject({ state: "invalid" });
    const sameOff = await fx.set("appearance.userBubbles", false);
    expect(sameOff.body.error).toContain("saved Simple/Advanced colour choice is already off");
    expect(sameOff.body.error).toContain("Raw keeps its fixed styling");

    const enable = fx.set("appearance.userBubbles", true);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(5));
    const fifth = fx.cards()[4]!.card;
    expect(fifth.appSettingRequest.after).toContain("bot-coloured message bubbles for Simple and Advanced");
    expect(fifth.appSettingRequest.after).toContain("Raw keeps its fixed styling");
    fx.answer(String(fifth.requestId), "deny");
    expect((await enable).status).toBe(409);
    expect(fx.windowWrites).toEqual([{ id: "appearance.userBubbles", value: false }]);

    const closed = fixture({ window: false });
    expect((await closed.set("appearance.userBubbles", false)).status).toBe(409);
    expect(closed.cards()).toEqual([]);
    expect(closed.windowWrites).toEqual([]);
    const guest = fixture({ owner: false });
    guest.windowValues.set("appearance.userBubbles", true);
    expect((await guest.set("appearance.userBubbles", false)).status).toBe(403);
    expect(guest.windowWrites).toEqual([]);
  });

  it("changes the notification feed only after the owner's live window approval", async () => {
    const fx = fixture();
    fx.windowValues.set("general.notificationFeed", false);
    const found = JSON.parse(String((await fx.host.handle({ action: "find", query: "notification feed" }, fx.turn)).body.text));
    expect(found).toEqual(expect.arrayContaining([expect.objectContaining({ id: "general.notificationFeed", tier: "confirm", value: "false" })]));
    const got = JSON.parse(String((await fx.host.handle({ action: "get", id: "general.notificationFeed" }, fx.turn)).body.text));
    expect(got).toMatchObject({ value: "false", allowed: "true or false" });
    expect((await fx.set("general.notificationFeed", "maybe")).status).toBe(400);
    expect(fx.windowWrites).toEqual([]);

    const cancelled = fx.set("general.notificationFeed", true);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(1));
    const first = fx.cards()[0]!.card;
    expect(first).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: expect.stringContaining("currently off") } });
    expect(fx.windowWrites).toEqual([]);
    fx.answer(String(first.requestId), "deny");
    expect((await cancelled).status).toBe(409);

    const stale = fx.set("general.notificationFeed", true);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(2));
    fx.windowValues.set("general.notificationFeed", true);
    fx.answer(String(fx.cards()[1]!.card.requestId), "allow");
    expect((await stale).body.error).toContain("already on");
    expect(fx.windowWrites).toEqual([]);

    fx.windowValues.set("general.notificationFeed", false);
    const disappeared = fx.set("general.notificationFeed", true);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(3));
    fx.windowValues.delete("general.notificationFeed");
    fx.answer(String(fx.cards()[2]!.card.requestId), "allow");
    expect((await disappeared).body.error).toContain("Open mymausbot");
    expect(fx.windowWrites).toEqual([]);

    const closed = fixture({ window: false });
    expect((await closed.set("general.notificationFeed", true)).status).toBe(409);
    expect(closed.cards()).toEqual([]);
    const guest = fixture({ owner: false });
    guest.windowValues.set("general.notificationFeed", false);
    expect((await guest.set("general.notificationFeed", true)).status).toBe(403);
    expect(guest.windowWrites).toEqual([]);

    fx.windowValues.set("general.notificationFeed", false);
    const approved = fx.set("general.notificationFeed", true);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(4));
    const fourth = fx.cards()[3]!.card;
    expect(fx.answer(String(fourth.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    expect(fx.windowWrites).toEqual([]);
    fx.answer(String(fourth.requestId), "allow");
    expect((await approved).status).toBe(200);
    expect(fx.windowWrites).toEqual([{ id: "general.notificationFeed", value: true }]);
    expect(fx.windowValues.get("general.notificationFeed")).toBe(true);
    expect(await fx.host.undo({ threadId: fx.turn.threadId, requestId: String(fourth.requestId) })).toMatchObject({ state: "invalid" });
  });

  it("changes saved sidebar tools layout only after owner approval for a live window", async () => {
    const fx = fixture();
    fx.windowValues.set("appearance.toolsLayout", "rows");
    const found = JSON.parse(String((await fx.host.handle({ action: "find", query: "tools layout" }, fx.turn)).body.text));
    expect(found).toEqual(expect.arrayContaining([expect.objectContaining({ id: "appearance.toolsLayout", tier: "confirm", value: expect.stringContaining("saved rows") })]));
    const got = JSON.parse(String((await fx.host.handle({ action: "get", id: "appearance.toolsLayout" }, fx.turn)).body.text));
    expect(got).toMatchObject({ allowed: "rows or toolbar", help: expect.stringContaining("Advanced mode with the sidebar expanded"), value: expect.stringContaining("Simple, Raw, and icon-only") });
    expect((await fx.set("appearance.toolsLayout", "icons")).status).toBe(400);
    const same = await fx.set("appearance.toolsLayout", "rows");
    expect(same.body.error).toContain("already rows");
    expect(same.body.error).toContain("Simple, Raw, and icon-only");
    expect(fx.windowWrites).toEqual([]);

    const cancelled = fx.set("appearance.toolsLayout", "toolbar");
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(1));
    const first = fx.cards()[0]!.card;
    expect(first).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: expect.stringContaining("toolbar icons for sidebar tools in Advanced with expanded sidebar") } });
    expect(first.appSettingRequest.after).toContain("Simple, Raw, and icon-only");
    fx.answer(String(first.requestId), "deny");
    expect((await cancelled).status).toBe(409);
    expect(fx.windowWrites).toEqual([]);

    const stale = fx.set("appearance.toolsLayout", "toolbar");
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(2));
    fx.windowValues.set("appearance.toolsLayout", "toolbar");
    fx.answer(String(fx.cards()[1]!.card.requestId), "allow");
    expect((await stale).body.error).toContain("already toolbar");
    expect(fx.windowWrites).toEqual([]);

    fx.windowValues.set("appearance.toolsLayout", "rows");
    const disconnected = fx.set("appearance.toolsLayout", "toolbar");
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(3));
    fx.windowValues.delete("appearance.toolsLayout");
    fx.answer(String(fx.cards()[2]!.card.requestId), "allow");
    expect((await disconnected).body.error).toContain("Open mymausbot");
    expect(fx.windowWrites).toEqual([]);

    const closed = fixture({ window: false });
    expect((await closed.set("appearance.toolsLayout", "toolbar")).status).toBe(409);
    expect(closed.cards()).toEqual([]);
    const guest = fixture({ owner: false });
    guest.windowValues.set("appearance.toolsLayout", "rows");
    expect((await guest.set("appearance.toolsLayout", "toolbar")).status).toBe(403);
    expect(guest.windowWrites).toEqual([]);

    fx.windowValues.set("appearance.toolsLayout", "rows");
    const approved = fx.set("appearance.toolsLayout", "toolbar");
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(4));
    const fourth = fx.cards()[3]!.card;
    expect(fx.answer(String(fourth.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    expect(fx.windowWrites).toEqual([]);
    fx.answer(String(fourth.requestId), "allow");
    expect((await approved).status).toBe(200);
    expect(fx.windowWrites).toEqual([{ id: "appearance.toolsLayout", value: "toolbar" }]);
    expect(await fx.host.undo({ threadId: fx.turn.threadId, requestId: String(fourth.requestId) })).toMatchObject({ state: "invalid" });

    const back = fx.set("appearance.toolsLayout", "rows");
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(5));
    expect(fx.cards()[4]!.card.appSettingRequest.after).toContain("Save rows for sidebar tools in Advanced with expanded sidebar");
    fx.answer(String(fx.cards()[4]!.card.requestId), "deny");
    expect((await back).status).toBe(409);
    expect(fx.windowWrites).toEqual([{ id: "appearance.toolsLayout", value: "toolbar" }]);
  });

  it("shows only the place's helper after owner Change and rejects a stale or ambiguous target", async () => {
    const fx = fixture();
    fx.bots[0]!.defaultBot = { person: "other@example.test" };
    fx.bots[1]!.defaultBot = {};
    fx.bots[1]!.sidebarHidden = true;
    const found = JSON.parse(String((await fx.host.handle({ action: "find", query: "show helper" }, fx.turn)).body.text));
    expect(found.map((entry: { id: string }) => entry.id)).toContain("sidebar.showHelper");
    const got = JSON.parse(String((await fx.host.handle({ action: "get", id: "sidebar.showHelper" }, fx.turn)).body.text));
    expect(got).toMatchObject({ tier: "confirm", value: "hidden" });

    const cancelled = fx.set("sidebar.showHelper", true);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(1));
    const first = fx.cards()[0]!.card;
    expect(first).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: expect.stringContaining("Clive") } });
    expect(fx.helperCalls).toEqual([]);
    fx.answer(String(first.requestId), "deny");
    expect((await cancelled).status).toBe(409);
    expect(fx.bots[1]!.sidebarHidden).toBe(true);

    const stale = fx.set("sidebar.showHelper", true);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(2));
    fx.bots[0]!.name = "Clive";
    fx.bots[1]!.defaultBot = { person: "other@example.test" };
    fx.bots[0]!.defaultBot = {};
    fx.answer(String(fx.cards()[1]!.card.requestId), "allow");
    expect((await stale).body.error).toContain("changed while the card was waiting");
    expect(fx.helperCalls).toEqual([]);

    fx.bots[1]!.defaultBot = {};
    expect((await fx.set("sidebar.showHelper", true)).status).toBe(409);
    expect(fx.helperCalls).toEqual([]);
    fx.bots[0]!.defaultBot = { person: "other@example.test" };

    const approved = fx.set("sidebar.showHelper", true);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(3));
    const third = fx.cards()[2]!.card;
    expect(fx.answer(String(third.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    expect(fx.helperCalls).toEqual([]);
    fx.answer(String(third.requestId), "allow");
    expect((await approved).status).toBe(200);
    expect(fx.helperCalls).toEqual([{ botId: "clive", shown: true }]);
    expect(fx.bots[1]!.sidebarHidden).toBe(false);
    expect(await fx.host.undo({ threadId: fx.turn.threadId, requestId: String(third.requestId) })).toMatchObject({ state: "invalid" });
  });

  it("archives and restores only the approved live bot, retaining chats and refusing unsafe targets", async () => {
    const fx = fixture();
    const value = { botId: "clive", archived: true };
    const found = JSON.parse(String((await fx.host.handle({ action: "find", query: "archive bot" }, fx.turn)).body.text));
    expect(found.map((entry: { id: string }) => entry.id)).toContain("bots.archived");
    expect((await fx.set("bots.archived", { ...value, archived: "true" })).status).toBe(400);
    expect((await fx.set("bots.archived", { botId: "missing", archived: true })).status).toBe(409);
    fx.bots[1]!.defaultBot = {};
    expect((await fx.set("bots.archived", value)).body.error).toContain("sidebar.showHelper");
    fx.bots[1]!.defaultBot = undefined;
    fx.bots[0]!.hidden = true;
    expect((await fx.set("bots.archived", value)).body.error).toContain("last active bot");
    fx.bots[0]!.hidden = false;
    fx.bots[1]!.movedTo = { team: { id: "t", name: "Team" }, state: "moved", at: 1 };
    expect((await fx.set("bots.archived", value)).body.error).toContain("moved to another computer");
    fx.bots[1]!.movedTo = undefined;
    expect(fx.archiveCalls).toEqual([]);

    const cancelled = fx.set("bots.archived", value);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(1));
    const first = fx.cards()[0]!.card;
    expect(first).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: expect.stringContaining("clive") } });
    fx.answer(String(first.requestId), "deny");
    expect((await cancelled).status).toBe(409);
    expect(fx.archiveCalls).toEqual([]);

    const stale = fx.set("bots.archived", value);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(2));
    fx.bots[1]!.chiefOfStaff = true;
    fx.answer(String(fx.cards()[1]!.card.requestId), "allow");
    expect((await stale).body.error).toContain("changed while the card was waiting");
    expect(fx.archiveCalls).toEqual([]);

    const approved = fx.set("bots.archived", value);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(3));
    const third = fx.cards()[2]!.card;
    expect(third.appSettingRequest.after).toContain("ending its Chief of Staff role");
    expect(fx.answer(String(third.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    expect(fx.archiveCalls).toEqual([]);
    fx.answer(String(third.requestId), "allow");
    expect((await approved).status).toBe(200);
    expect(fx.archiveCalls).toEqual([{ botId: "clive", archived: true, demoteChief: true }]);
    expect(fx.bots[1]).toMatchObject({ hidden: true, chiefOfStaff: false });
    expect(await fx.host.undo({ threadId: fx.turn.threadId, requestId: String(third.requestId) })).toMatchObject({ state: "invalid" });
    const got = JSON.parse(String((await fx.host.handle({ action: "get", id: "bots.archived" }, fx.turn)).body.text));
    expect(got).toMatchObject({ tier: "confirm", value: 'clive: "Clive"' });

    const restored = fx.set("bots.archived", { botId: "clive", archived: false });
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(4));
    fx.answer(String(fx.cards()[3]!.card.requestId), "allow");
    expect((await restored).status).toBe(200);
    expect(fx.archiveCalls[1]).toEqual({ botId: "clive", archived: false, demoteChief: false });
    expect(fx.bots[1]).toMatchObject({ hidden: false, chiefOfStaff: false });
  });

  it("changes one bot colour only after owner Change and refuses stale or invalid requests", async () => {
    const fx = fixture();
    const value = { botId: "clive", color: "teal" };
    const got = JSON.parse(String((await fx.host.handle({ action: "get", id: "bots.color" }, fx.turn)).body.text));
    expect(got).toMatchObject({ tier: "confirm", value: expect.stringContaining("clive: \"Clive\" (#00f)") });
    expect((await fx.set("bots.color", { botId: "clive", color: "#123456" })).status).toBe(400);
    expect((await fx.set("bots.color", { botId: "missing", color: "teal" })).status).toBe(409);
    expect(fx.cards()).toEqual([]);

    const cancelled = fx.set("bots.color", JSON.stringify(value));
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(1));
    const first = fx.cards()[0]!.card;
    expect(first).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: 'Change "Clive" from #00f to teal' } });
    expect(fx.colorCalls).toEqual([]);
    fx.answer(String(first.requestId), "deny");
    expect((await cancelled).status).toBe(409);

    const stale = fx.set("bots.color", value);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(2));
    fx.bots[1]!.color = "purple";
    fx.answer(String(fx.cards()[1]!.card.requestId), "allow");
    expect((await stale).body.error).toContain("changed while the card was waiting");
    expect(fx.colorCalls).toEqual([]);

    const approved = fx.set("bots.color", value);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(3));
    const third = fx.cards()[2]!.card;
    expect(fx.answer(String(third.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    expect(fx.colorCalls).toEqual([]);
    fx.answer(String(third.requestId), "allow");
    expect((await approved).status).toBe(200);
    expect(fx.colorCalls).toEqual([{ botId: "clive", color: "teal" }]);
    expect(fx.bots[1]!.color).toBe("teal");
    expect(await fx.host.undo({ threadId: fx.turn.threadId, requestId: String(third.requestId) })).toMatchObject({ state: "invalid" });
  });

  it("renames only after owner Change and refuses Cancel, stale cards and invalid names", async () => {
    const fx = fixture();
    const value = { botId: "clive", name: "   River   " };
    const got = JSON.parse(String((await fx.host.handle({ action: "get", id: "bots.name" }, fx.turn)).body.text));
    expect(got).toMatchObject({ tier: "confirm", value: expect.stringContaining("clive: \"Clive\"") });
    for (const name of ["", "two\nlines", "x".repeat(101)]) {
      expect((await fx.set("bots.name", { botId: "clive", name })).status).toBe(400);
    }
    expect((await fx.set("bots.name", { botId: "missing", name: "River" })).status).toBe(409);
    expect(fx.cards()).toEqual([]);
    expect(fx.renameCalls).toEqual([]);

    const cancelled = fx.set("bots.name", JSON.stringify(value));
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(1));
    const first = fx.cards()[0]!.card;
    expect(first).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: 'Rename "Clive" to "River"' } });
    expect(fx.renameCalls).toEqual([]);
    fx.answer(String(first.requestId), "deny");
    expect((await cancelled).status).toBe(409);
    expect(fx.bots[1]!.name).toBe("Clive");

    const stale = fx.set("bots.name", value);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(2));
    fx.bots[1]!.name = "Changed elsewhere";
    fx.answer(String(fx.cards()[1]!.card.requestId), "allow");
    expect((await stale).body.error).toContain("changed while the card was waiting");
    expect(fx.renameCalls).toEqual([]);

    const approved = fx.set("bots.name", value);
    await vi.waitFor(() => expect(fx.cards()).toHaveLength(3));
    const third = fx.cards()[2]!.card;
    expect(fx.answer(String(third.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    expect(fx.renameCalls).toEqual([]);
    fx.answer(String(third.requestId), "allow");
    expect((await approved).status).toBe(200);
    expect(fx.renameCalls).toEqual([{ botId: "clive", name: "River" }]);
    expect(fx.bots[1]!.name).toBe("River");
    expect(await fx.host.undo({ threadId: fx.turn.threadId, requestId: String(third.requestId) })).toMatchObject({ state: "invalid" });
  });

  it("keeps a proposed proxy private until the owner approves, and leaves Cancel and unauthorized answers unchanged", async () => {
    const { host, set, cfg, cards, turn, saved, answer, dataDir, notified } = fixture();
    const proxy = "socks5://proxy.example:1080";
    for (const invalid of ["http://proxy.example:8080", "socks5://user:pass@proxy.example:1080"]) {
      const refused = await set("desktops.browserProxy", invalid);
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused)).not.toContain("proxy.example");
    }
    const cancelled = set("desktops.browserProxy", proxy);
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    const first = cards()[0]!.card;
    expect(first).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { before: "", after: "set", tier: "confirm" } });
    expect(saved).toEqual([]);
    expect(answer(String(first.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    expect(saved).toEqual([]);
    expect(answer(String(first.requestId), "deny").sent).toMatchObject({ status: 200, body: { outcome: "rejected" } });
    expect((await cancelled).body.error).toContain("cancelled");
    expect(cfg.browserEngine?.egress?.proxy).toBeUndefined();

    const pending = set("desktops.browserProxy", proxy);
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    const second = cards()[1]!.card;
    expect(saved).toEqual([]);
    expect(answer(String(second.requestId), "allow").sent).toMatchObject({ status: 200, body: { outcome: "allowed-once" } });
    const applied = await pending;
    expect(applied).toMatchObject({ status: 200, body: { text: "Changed Browser proxy from not set to set." } });
    expect(saved).toEqual([{ browserEngine: { egress: { proxy } } }]);
    expect(await host.undo({ threadId: turn.threadId, requestId: String(second.requestId) })).toMatchObject({ state: "invalid", error: "This change can't be undone here." });
    const read = await host.handle({ action: "get", id: "desktops.browserProxy" }, turn);
    const found = await host.handle({ action: "find", query: "browser proxy" }, turn);
    expect(JSON.parse(String(read.body.text))).toMatchObject({ value: "set", tier: "confirm" });
    await flushDecisionLog(dataDir);
    expect(JSON.stringify({ first, second, notified, reply: applied.body, read: read.body, found: found.body, decisions: readDecisions(dataDir, 10) })).not.toContain("proxy.example");
  });

  it("waits for owner approval before replacing or clearing an existing proxy", async () => {
    const { set, cfg, cards, answer, saved } = fixture();
    const old = "socks5://old.example:1080";
    const next = "socks5://new.example:1080";
    cfg.browserEngine = { egress: { proxy: old } };
    const denied = set("desktops.browserProxy", next);
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]!.card.appSettingRequest).toMatchObject({ before: "set", after: "set", tier: "confirm" });
    expect(cfg.browserEngine.egress?.proxy).toBe(old);
    answer(String(cards()[0]!.card.requestId), "deny");
    expect((await denied).status).toBe(409);
    expect(cfg.browserEngine.egress?.proxy).toBe(old);
    expect(saved).toEqual([]);

    const replaced = set("desktops.browserProxy", next);
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    expect(cfg.browserEngine.egress?.proxy).toBe(old);
    answer(String(cards()[1]!.card.requestId), "allow");
    expect((await replaced).status).toBe(200);
    expect(cfg.browserEngine.egress?.proxy).toBe(next);

    const cleared = set("desktops.browserProxy", "");
    await vi.waitFor(() => expect(cards()).toHaveLength(3));
    expect(cards()[2]!.card.appSettingRequest).toMatchObject({ before: "set", after: "", tier: "confirm" });
    expect(cfg.browserEngine.egress?.proxy).toBe(next);
    answer(String(cards()[2]!.card.requestId), "allow");
    expect((await cleared).body.text).toBe("Changed Browser proxy from set to not set.");
    expect(cfg.browserEngine.egress?.proxy).toBe("");
    expect(saved).toEqual([{ browserEngine: { egress: { proxy: next } } }, { browserEngine: { egress: { proxy: "" } } }]);
    expect(JSON.stringify(cards())).not.toContain(".example");
  });

  it("sends only the selected provider field when effective config has external credentials", async () => {
    const { cfg, entries, saved } = fixture();
    for (const section of ["anthropic", "xai", "groq", "meta", "openaiCompat", "tts"] as const) {
      Object.assign(cfg, { [section]: { key: `fixture-${section}-key` } });
    }
    for (const [id, value, patch] of [
      ["providers.anthropic.url", "https://anthropic.example", { anthropic: { url: "https://anthropic.example" } }],
      ["providers.xai.url", "https://xai.example", { xai: { url: "https://xai.example" } }],
      ["providers.groq.url", "https://groq.example", { groq: { url: "https://groq.example" } }],
      ["providers.meta.url", "https://meta.example", { meta: { url: "https://meta.example" } }],
      ["providers.openaiCompat.url", "https://compat.example", { openaiCompat: { url: "https://compat.example" } }],
      ["providers.openaiCompat.model", "fixture-model", { openaiCompat: { model: "fixture-model" } }],
      ["voice.baseUrl", "https://voice.example", { tts: { baseUrl: "https://voice.example" } }],
    ] as const) {
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry || entry.tier !== "confirm") throw new Error(`missing ${id}`);
      expect(await entry.write(value)).toBeNull();
      expect(saved.at(-1), id).toEqual(patch);
    }
  });
  it("always shows a Change/Cancel card, applies on an owner's Allow, and refuses a second open card", async () => {
    const { set, cards, answer, saved, dataDir } = fixture();
    const pending = set("providers.anthropic.url", "https://proxy.example/v1");
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    const card = cards()[0]!.card;
    expect(card).toMatchObject({ title: "Change Anthropic address?", options: ["Change", "Cancel"], fixedOptions: true, appSettingRequest: { tier: "confirm", before: "https://api.anthropic.com", after: "https://proxy.example/v1" } });
    expect(saved).toEqual([]);
    const second = await set("providers.xai.url", "https://other.example");
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("already waiting");
    const shell = answer(String(card.requestId), "allow", false);
    expect(shell.sent).toMatchObject({ status: 403 });
    expect(saved).toEqual([]);
    const owner = answer(String(card.requestId), "allow");
    expect(owner.sent).toMatchObject({ status: 200, body: { ok: true, outcome: "allowed-once" } });
    const result = await pending;
    expect(result.status).toBe(200);
    expect(result.body.text).toContain("Changed Anthropic address from https://api.anthropic.com to https://proxy.example/v1");
    expect(saved).toEqual([{ anthropic: { url: "https://proxy.example/v1" } }]);
    expect(cards()[0]!.card.answered).toBe("allow");
    await flushDecisionLog(dataDir);
    expect(readDecisions(dataDir, 10).map((row) => row.decision)).toEqual(["card-shown", "user-approved"]);
  });

  it("Cancel refuses with a line telling the bot not to retry, and the user sees the failure of a refused write", async () => {
    const { set, cards, answer, saved } = fixture();
    const pending = set("providers.anthropic.url", "https://proxy.example/v1");
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(answer(String(cards()[0]!.card.requestId), "deny").sent).toMatchObject({ status: 200, body: { outcome: "rejected" } });
    const result = await pending;
    expect(result.status).toBe(409);
    expect(result.body.error).toContain("cancelled");
    expect(result.body.error).toContain("Do not retry");
    expect(saved).toEqual([]);
    const refused = set("providers.anthropic.url", "https://refused.example");
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    answer(String(cards()[1]!.card.requestId), "allow");
    expect((await refused).body.error).toContain("the provider refused it");
  });

  it("one approved Change stays single while its write is pending, even if the turn stops", async () => {
    const { set, cards, answer, saved, entries } = fixture();
    const entry = entries.find((candidate) => candidate.id === "providers.anthropic.url");
    if (!entry || entry.tier !== "confirm") throw new Error("missing provider setting");
    const write = entry.write;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    entry.write = async (value) => { await gate; return write(value); };
    const stop = new AbortController();
    const pending = set("providers.anthropic.url", "https://proxy.example/v1", "gen-1", stop.signal);
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    const requestId = String(cards()[0]!.card.requestId);
    expect(answer(requestId, "allow").sent).toMatchObject({ status: 200, body: { outcome: "allowed-once" } });
    expect(answer(requestId, "allow").sent).toMatchObject({ status: 200, body: { alreadySettled: true } });
    stop.abort();
    release();
    expect((await pending).status).toBe(200);
    expect(saved).toEqual([{ anthropic: { url: "https://proxy.example/v1" } }]);
  });

  it("times out, patches the card as unavailable, and refuses the write", async () => {
    vi.useFakeTimers();
    const { set, cards, saved } = fixture();
    const pending = set("providers.anthropic.url", "https://proxy.example/v1");
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result.status).toBe(409);
    expect(result.body.error).toContain("Nobody answered");
    expect(cards()[0]!.card).toMatchObject({ answered: "unavailable", dismissed: true });
    expect(saved).toEqual([]);
  });
});

describe("a stopped turn", () => {
  it("closes the waiting card at once as unavailable, tells the bot nothing changed, and a later tap changes nothing", async () => {
    const { set, cards, answer, saved, turn } = fixture();
    const stop = new AbortController();
    const pending = set("providers.anthropic.url", "https://proxy.example/v1", turn.generation, stop.signal);
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    stop.abort();
    const result = await pending;
    expect(result).toMatchObject({ status: 409, body: { error: expect.stringMatching(/^This turn was stopped, so the "Anthropic address" card was closed and nothing changed\./) } });
    expect(cards()[0]!.card).toMatchObject({ answered: "unavailable", dismissed: true });
    expect(answer(String(cards()[0]!.card.requestId), "allow").sent).toMatchObject({ status: 200, body: { outcome: "unavailable" } });
    expect(saved).toEqual([]);
    expect((await set("providers.anthropic.url", "https://proxy.example/v1", turn.generation, stop.signal)).status).toBe(409);
    expect(cards()).toHaveLength(1);
  });
});

describe("AI engines", () => {
  const pendingEngine = async (fx: ReturnType<typeof fixture>, change: unknown, ended?: AbortSignal) => {
    const pending = fx.set("engines", JSON.stringify(change), fx.turn.generation, ended);
    await vi.waitFor(() => expect(fx.cards().filter((message) => !message.card.answered)).toHaveLength(1));
    return { pending, card: fx.cards().at(-1)!.card };
  };

  it("finds and lists engine ids without saved keys", async () => {
    const { host, turn } = fixture();
    const found = JSON.parse(String((await host.handle({ action: "find", query: "add ollama engine" }, turn)).body.text));
    expect(found[0].id).toBe("engines");
    const got = JSON.parse(String((await host.handle({ action: "get", id: "engines" }, turn)).body.text));
    expect(got).toMatchObject({ tier: "confirm", value: "claude: Claude (removed only in Settings); openai-compat-gw: Gateway at https://gw.example/v1" });
    expect(JSON.stringify({ found, got })).not.toContain(GATEWAY_KEY);
  });

  it("refuses inline secrets and missing saved keys before a card or write", async () => {
    const fx = fixture();
    for (const field of ["key", "apiKey", "token"]) {
      const result = await fx.set("engines", JSON.stringify({ kind: "openai-compat", name: "Proxy", url: "https://proxy.example/v1", [field]: OPENAI_KEY }));
      expect(result.status).toBe(400);
      expect(result.body.error).toContain("Never put a key or token in the value");
    }
    const missing = await fx.set("engines", JSON.stringify({ kind: "openai-compat", name: "Proxy", url: "https://proxy.example/v1", keyFrom: "mistralApiKey" }));
    expect(missing).toMatchObject({ status: 409, body: { error: expect.stringContaining("not saved yet") } });
    expect(fx.cards()).toEqual([]);
    expect(fx.engineCalls).toEqual([]);
  });

  it("adds only after owner Change, resolves keyFrom at approval, and keeps the key out of visible records", async () => {
    const fx = fixture();
    const { pending, card } = await pendingEngine(fx, { kind: "openai-compat", name: "Proxy", url: "https://proxy.example/v1", keyFrom: "openaiApiKey" });
    expect(card).toMatchObject({ title: "Change AI engines?", subtitle: expect.stringContaining("saved OpenAI API key"), options: ["Change", "Cancel"],
      appSettingRequest: { settingId: "engines", tier: "confirm" } });
    expect(card.appSettingRequest).not.toHaveProperty("before");
    expect(fx.answer(String(card.requestId), "allow", false).sent).toMatchObject({ status: 403 });
    expect(fx.engineCalls).toEqual([]);
    fx.cfg.openai!.key = "sk-rotated-fixture";
    fx.answer(String(card.requestId), "allow");
    expect((await pending).body.text).toMatch(/^Done: Add the engine "Proxy"/);
    expect(fx.engineCalls).toEqual([{ add: "openai-compat", body: { displayName: "Proxy", url: "https://proxy.example/v1", key: "sk-rotated-fixture" } }]);
    await expect(fx.host.undo({ threadId: fx.turn.threadId, requestId: String(card.requestId) })).resolves.toMatchObject({ state: "invalid" });
    await flushDecisionLog(fx.dataDir);
    expect(JSON.stringify([card, fx.messages, readDecisions(fx.dataDir, 20)])).not.toContain(OPENAI_KEY);
    expect(JSON.stringify([card, fx.messages, readDecisions(fx.dataDir, 20)])).not.toContain("sk-rotated-fixture");
  });

  it("refuses removal of built-in, unknown and chosen engines, and rechecks a changed target after the card", async () => {
    const fx = fixture({ chosen: ["openai-compat-gw"] });
    expect((await fx.set("engines", JSON.stringify({ kind: "remove", instanceId: "unknown" }))).body.error).toContain("No engine has the id");
    expect((await fx.set("engines", JSON.stringify({ kind: "remove", instanceId: "claude" }))).body.error).toContain("removed only by the user");
    expect((await fx.set("engines", JSON.stringify({ kind: "remove", instanceId: "openai-compat-gw" }))).body.error).toContain("use Gateway");
    expect(fx.cards()).toEqual([]);
    fx.chosen.clear();
    const cancelled = await pendingEngine(fx, { kind: "remove", instanceId: "openai-compat-gw" });
    fx.answer(String(cancelled.card.requestId), "deny");
    expect((await cancelled.pending).status).toBe(409);
    expect(fx.engineCalls).toEqual([]);
    const changed = await pendingEngine(fx, { kind: "remove", instanceId: "openai-compat-gw" });
    fx.cfg.instances!["openai-compat-gw"]!.config = { key: GATEWAY_KEY, url: "https://changed.example/v1" };
    fx.answer(String(changed.card.requestId), "allow");
    expect((await changed.pending).body.error).toContain("changed while the card was waiting");
    expect(fx.engineCalls).toEqual([]);
  });

  it("keeps non-owner and guest turns away from engine details and writes", async () => {
    for (const options of [{ owner: false }, { guest: true }]) {
      const fx = fixture(options);
      expect((await fx.host.handle({ action: "get", id: "engines" }, fx.turn)).status).toBe(403);
      expect((await fx.set("engines", JSON.stringify({ kind: "ollama", url: "http://127.0.0.1:11434" }))).status).toBe(403);
      expect(fx.cards()).toEqual([]);
      expect(fx.engineCalls).toEqual([]);
    }
  });

  it("keeps a write's outcome after Stop lands during an approved route call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fx = fixture({ engineGate: gate });
    const stop = new AbortController();
    const { pending, card } = await pendingEngine(fx, { kind: "ollama", url: "http://127.0.0.1:11434" }, stop.signal);
    fx.answer(String(card.requestId), "allow");
    expect(fx.engineCalls).toHaveLength(1);
    stop.abort();
    release();
    expect(await pending).toMatchObject({ status: 200, body: { text: expect.stringMatching(/^Done: Add the engine "Ollama"/) } });
  });
});

describe("secret tier", () => {
  it("never takes a value, posts the secret card instead, and shows keys only as set or not set", async () => {
    const { host, set, credentialCards, messages, turn, dataDir } = fixture();
    const withValue = await set("keys.openaiApiKey", OPENAI_KEY);
    expect(withValue.status).toBe(400);
    expect(credentialCards).toEqual([]);
    const carded = await set("keys.openaiApiKey");
    expect(carded.status).toBe(200);
    expect(credentialCards).toEqual([{ credentialId: "openaiApiKey", reason: undefined }]);
    const got = await host.handle({ action: "get", id: "keys.openaiApiKey" }, turn);
    expect(JSON.parse(String(got.body.text))).toMatchObject({ tier: "secret", value: "set" });
    const found = await host.handle({ action: "find", query: "anthropic key" }, turn);
    expect(JSON.parse(String(found.body.text))).toContainEqual(expect.objectContaining({ id: "keys.anthropicApiKey", value: "not set" }));
    await flushDecisionLog(dataDir);
    const everything = JSON.stringify([withValue, carded, got, found, messages, readDecisions(dataDir, 10)]);
    expect(everything).not.toContain(OPENAI_KEY);
  });
});

describe("owner-only tier", () => {
  it("explains and refuses with where to change it, approval modes included", async () => {
    const { host, set, turn } = fixture();
    const got = await host.handle({ action: "get", id: "bots.approvalModes" }, turn);
    expect(JSON.parse(String(got.body.text))).toMatchObject({ tier: "owner-only", value: "Kiwi: full; Clive: ask", change: "only the owner, in a bot's Settings" });
    const refused = await set("bots.approvalModes", { kiwi: "full" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain("a bot's Settings");
    expect((await set("remote.access", "tunnel")).status).toBe(403);
  });
});
