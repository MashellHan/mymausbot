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

function fixture(options: { owner?: boolean; guest?: boolean; group?: boolean; window?: boolean; pinFailureId?: string; chosen?: string[]; engineGate?: Promise<void> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "app-settings-"));
  dirs.push(dataDir);
  const bots: BotRecord[] = [
    { id: "kiwi", name: "Kiwi", color: "#0f0", threadId: "t-kiwi", approvalMode: "full", section: "Sales" } as unknown as BotRecord,
    { id: "clive", name: "Clive", color: "#00f", threadId: "t-clive", approvalMode: "ask" } as unknown as BotRecord,
  ];
  const cfg = { language: "en", rooms: { turnTimeoutMinutes: 30 }, mcp: {}, threads: { maxConcurrentPerBot: 3 }, openai: { key: OPENAI_KEY }, anthropic: { url: "https://api.anthropic.com" },
    instances: { "openai-compat-gw": { driver: "openai-compat", displayName: "Gateway", config: { key: GATEWAY_KEY, url: "https://gw.example/v1" } } } } as unknown as AppConfig;
  const saved: Record<string, unknown>[] = [];
  const pinCalls: Array<{ botId: string; pinned: boolean }> = [];
  const renameCalls: Array<{ botId: string; name: string }> = [];
  const colorCalls: Array<{ botId: string; color: string }> = [];
  const archiveCalls: Array<{ botId: string; archived: boolean; demoteChief: boolean }> = [];
  const helperCalls: Array<{ botId: string; shown: boolean }> = [];
  const engineCalls: unknown[] = [];
  const chosen = new Set(options.chosen ?? []);
  const messages: Array<Record<string, any>> = [];
  const windowValues = new Map<string, unknown>(options.window === false ? [] : [["appearance.skin", "daylight"]]);
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
      Object.assign(cfg, patch);
      return null;
    },
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
      write: (id, value) => { if (!windowValues.size) return "Open mymausbot on this computer first."; windowValues.set(id, value); return null; },
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
  return { host, cfg, saved, pinCalls, renameCalls, colorCalls, archiveCalls, helperCalls, engineCalls, chosen, messages, cards, credentialCards, notified, windowValues, bots, turn, set, answer, dataDir, entries };
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
