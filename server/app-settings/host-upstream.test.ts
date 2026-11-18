import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import { flushDecisionLog } from "../decision-log.ts";
import type { BotRecord } from "../store.ts";
import { createAppSettings } from "./host.ts";
import { createSettingsRegistry } from "./registry.ts";

const OPENAI_KEY = "sk-live-9f8e7d6c5b4a3210";
const GATEWAY_KEY = "sk-gateway-0a1b2c3d";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await flushDecisionLog(dir);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function fixture(options: { owner?: boolean; guest?: boolean; group?: boolean; window?: boolean; pictureRefusal?: string; patchRefusal?: string; automated?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "app-settings-"));
  dirs.push(dataDir);
  const bots: BotRecord[] = [
    { id: "kiwi", name: "Kiwi", color: "green", threadId: "t-kiwi", approvalMode: "full", section: "Sales", modelSelection: { instanceId: "claude", model: "opus" } } as unknown as BotRecord,
    { id: "clive", name: "Clive", color: "blue", threadId: "t-clive", approvalMode: "ask", modelSelection: { instanceId: "claude", model: "sonnet" }, assignedSkills: ["notes"] } as unknown as BotRecord,
  ];
  const cfg = { language: "en", rooms: { turnTimeoutMinutes: 30 }, mcp: {}, threads: { maxConcurrentPerBot: 3 }, openai: { key: OPENAI_KEY }, anthropic: { url: "https://api.anthropic.com" },
    instances: { "openai-compat-gw": { driver: "openai-compat", displayName: "Gateway", config: { key: GATEWAY_KEY, url: "https://gw.example/v1" } } } } as unknown as AppConfig;
  const engineCalls: unknown[] = [];
  const engines = [{ instanceId: "claude", name: "Claude", working: true }, { instanceId: "openai-compat-gw", name: "Gateway", working: true }];
  const botPatches: Array<{ botId: string; body: Record<string, unknown> }> = [];
  const routeCalls: unknown[] = [];
  const saved: Record<string, unknown>[] = [];
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
  };
  const credentialCards: Record<string, unknown>[] = [];
  const pictureFiles: { taken: string[]; discarded: string[] } = { taken: [], discarded: [] };
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
    patchBot: async (botId, body) => { if (options.patchRefusal) return options.patchRefusal; botPatches.push({ botId, body }); Object.assign(bots.find((bot) => bot.id === botId)!, body); return null; },
    call: async (route, method, path, body) => { routeCalls.push({ route, method, path, body }); return null; },
    read: async (_route, path) => (path === "/api/skills-library" ? { skills: [{ name: "notes", enabled: false, everyBot: false }] } : null),
    paused: () => [],
    pinBot: async (botId, pinned) => { (bots.find((bot) => bot.id === botId) as { pinned?: boolean }).pinned = pinned || undefined; return null; },
    groupBots: async (name, botIds) => { for (const bot of bots) if (botIds.includes(bot.id)) (bot as { section?: string }).section = name || undefined; return null; },
    savedStepsHere: () => false,
    engineChosen: () => false,
    renameBot: async () => "not used by this fixture",
    colorBot: async () => "not used by this fixture",
    archiveBot: async () => "not used by this fixture",
    showHelper: async () => "not used by this fixture",
    credentials: () => cfg,
    window: {
      read: (id) => windowValues.get(id),
      write: (id, value) => { if (!windowValues.size) return "Open MausBot on this computer first."; windowValues.set(id, value); return null; },
    },
    engines: () => engines,
    addEngine: async (path, body) => {
      engineCalls.push({ add: path, body });
      const instanceId = `openai-compat-${engines.length}`;
      engines.push({ instanceId, name: String(body.displayName), working: true });
      (cfg.instances as Record<string, unknown>)[instanceId] = { driver: "openai-compat", displayName: body.displayName, config: { url: body.url, key: body.key } };
      return null;
    },
    removeEngine: async (instanceId) => { engineCalls.push({ remove: instanceId }); engines.splice(engines.findIndex((engine) => engine.instanceId === instanceId), 1); return null; },
  });
  const host = createAppSettings({
    store: store as never, dataDir, entries,
    turnOwner: () => (options.owner === false ? null : "owner"),
    guestDriven: () => options.guest === true,
    automated: () => options.automated === true,
    requestCredential: async (_bot, _threadId, body) => { credentialCards.push(body); return { status: 201, body: { messageId: "secret-1", label: "OpenAI API key" } }; },
    connectorThread: () => ({ group: options.group ? { id: "g", name: "Room" } as never : undefined }),
    activeGroupTurnForBot: () => null,
    notify: () => undefined,
    language: () => undefined,
    pictures: {
      take: async (_turn, path) => {
        pictureFiles.taken.push(path);
        return options.pictureRefusal ? { refusal: options.pictureRefusal } : { avatarUrl: `/api/attachments/stored-${pictureFiles.taken.length}.png` };
      },
      discard: (avatarUrl) => { pictureFiles.discarded.push(avatarUrl); },
    },
  });
  const turn = { botId: "kiwi", threadId: "t-kiwi", generation: "gen-1" };
  const set = (id: string, value?: unknown, generation = turn.generation) => host.handle({ action: "set", id, ...(value === undefined ? {} : { value }) }, { ...turn, generation });
  const cards = () => messages.filter((message) => message.card?.appSettingRequest);
  /** Undo on the newest applied card. */
  const undo = () => host.undo({ threadId: turn.threadId, requestId: String(cards().at(-1)!.card.requestId) });
  return { host, cfg, saved, messages, cards, credentialCards, windowValues, bots, turn, set, undo, dataDir, engineCalls, botPatches, routeCalls, engines, pictureFiles };
}

describe("upstream app_settings additions", () => {
  const MASCOT = { avatarUrl: null, avatarCrop: "mascot", avatarZoom: 1, avatarFocusX: 0.5, avatarFocusY: 0.5 };

  it("names real places only: find falls back to where a thing is, places lists them all", async () => {
    const { host, turn } = fixture();
    const owner = await host.handle({ action: "get", id: "phone.pairing" }, turn);
    expect(JSON.parse(String(owner.body.text))).toMatchObject({ where: "Settings → Phone & devices → Pair a phone", change: "only the person, in Settings → Phone & devices → Pair a phone" });
    const none = await host.handle({ action: "find", query: "invoice" }, turn);
    expect(none.body.text).toMatch(/^No setting you can change matches "invoice"\. Where the person finds it in the app: Settings → Plan & billing/);
    expect((await host.handle({ action: "places", query: "spending" }, turn)).body.text).toMatch(/^Settings → Spending \(shown in Advanced mode only/);
    const every = String((await host.handle({ action: "places" }, turn)).body.text).split("\n");
    expect(every[0]).toMatch(/^Settings opens from/);
    expect(every).toContain("Settings → AI → Other services");
    expect(every.join("\n")).not.toMatch(/API keys|Computers\b/);
  });

  it("refuses a local server already added at the same address, so Settings never lists it twice", async () => {
    const fx = fixture();
    Object.assign(fx.cfg.instances!, { "openai-compat-2": {
      driver: "openai-compat", displayName: "LM Studio", config: { url: "http://127.0.0.1:1234/v1", key: "lm-studio", catalog: "lmstudio" },
    } });
    const again = await fx.set("engines", JSON.stringify({ kind: "lmstudio", url: "http://127.0.0.1:1234/v1/" }));
    expect(again).toMatchObject({ status: 409, body: { error: "\"LM Studio\" at http://127.0.0.1:1234/v1 is already an engine (openai-compat-2). Use that one; do not add it again." } });
    expect(fx.engineCalls).toHaveLength(0);
    expect(fx.cards()).toHaveLength(0);
  });

  it("explains and refuses with where to change it: sign-in, logins, pairing, backups, the domain", async () => {
    const { host, set, turn, cards, saved, routeCalls } = fixture();
    const got = await host.handle({ action: "get", id: "vault.logins" }, turn);
    expect(JSON.parse(String(got.body.text))).toMatchObject({ tier: "owner-only", change: "only the owner, in Settings → Vault" });
    for (const id of ["cloud.account", "vault.logins", "phone.pairing", "data.backups", "people.signIn", "remote.domain", "remote.httpsAddress"]) {
      const refused = await set(id, "on");
      expect(refused.status, id).toBe(403);
      expect(refused.body.error, id).toMatch(/ is changed only by the (person|owner), in Settings → .+; do not try another way\.$/);
    }
    expect([cards(), saved, routeCalls]).toEqual([[], [], []]);
  });

  it("turns a way in to this computer on with Undo, but leaves turning one off to the person", async () => {
    const fx = fixture();
    fx.windowValues.set("remote.relay", false);
    const on = await fx.set("remote.relay", "true");
    expect(on.body.text).toMatch(/^Done: Let your paired phones reach this computer from anywhere, through MausBot's relay\./);
    expect(fx.windowValues.get("remote.relay")).toBe(true);
    const off = await fx.set("remote.relay", false);
    expect(off).toMatchObject({ status: 409, body: { error: "Turning off Reach from anywhere is changed only by the person, in Settings → Phone & devices → How your phone reaches this computer → Anywhere, through MausBot (only in the desktop app, on this computer's own page). Tell them where in one line; do not try another way." } });
    expect(fx.windowValues.get("remote.relay")).toBe(true);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.windowValues.get("remote.relay")).toBe(false);
  });

  it("gives a bot the stored picture in a circle, with Undo back to its mascot face", async () => {
    const fx = fixture();
    const done = await fx.set("bots.picture", JSON.stringify({ botId: "clive", path: "/work/clive.png" }));
    expect(done.body.text).toBe("Done: Give Clive the picture clive.png. Bot picture now: Kiwi: mascot face; Clive: /api/attachments/stored-1.png. The user can undo it from the card in the conversation.");
    expect(fx.pictureFiles.taken).toEqual(["/work/clive.png"]);
    expect(fx.botPatches).toEqual([{ botId: "clive", body: { avatarUrl: "/api/attachments/stored-1.png", avatarCrop: "circle", avatarZoom: 1, avatarFocusX: 0.5, avatarFocusY: 0.5 } }]);
    expect(fx.cards()[0]!.card).toMatchObject({ subtitle: "Give Clive the picture clive.png", appSettingRequest: { settingId: "bots.picture", after: "Give Clive the picture clive.png" } });
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.botPatches[1]).toEqual({ botId: "clive", body: { ...MASCOT, avatarUrl: null } });
  });

  it("keeps a bot's own crop, takes a picture off with an empty path, and Undo puts the earlier picture back", async () => {
    const fx = fixture();
    Object.assign(fx.bots[0]!, { avatarUrl: "/api/attachments/earlier.webp", avatarCrop: "rounded", avatarZoom: 2 });
    await fx.set("bots.picture", { botId: "kiwi", path: "new.gif" });
    expect(fx.botPatches[0]!.body).toMatchObject({ avatarUrl: "/api/attachments/stored-1.png", avatarCrop: "rounded", avatarZoom: 1 });
    const off = await fx.set("bots.picture", { botId: "kiwi", path: "" });
    expect(off.body.text).toMatch(/^Done: Take Kiwi's picture off; it shows its mascot face again\./);
    expect(fx.botPatches[1]!.body).toEqual(MASCOT);
    expect(fx.pictureFiles.taken).toEqual(["new.gif"]);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.botPatches[2]!.body).toEqual({ avatarUrl: "/api/attachments/stored-1.png", avatarCrop: "rounded", avatarZoom: 1, avatarFocusX: 0.5, avatarFocusY: 0.5 });
    expect(await fx.set("bots.picture", { botId: "clive", path: "" })).toMatchObject({ status: 409, body: { error: "Clive has no picture; it already shows its mascot face." } });
  });

  it("sets and takes off the person's photo through the config route, with Undo", async () => {
    const fx = fixture();
    const done = await fx.set("profile.photo", { path: "/work/me.jpg" });
    expect(done.body.text).toMatch(/^Done: Make me\.jpg your photo\. Your photo now: \/api\/attachments\/stored-1\.png\./);
    expect(fx.saved).toEqual([{ profile: { avatarUrl: "/api/attachments/stored-1.png" } }]);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.saved[1]).toEqual({ profile: { avatarUrl: "" } });
    expect(await fx.set("profile.photo", { path: "" })).toMatchObject({ status: 409, body: { error: "The person has no photo to take off." } });
  });

  it("stores nothing when the turn may not change settings, the bot is unknown or the file is refused", async () => {
    const notOwner = fixture({ owner: false });
    expect((await notOwner.set("bots.picture", { botId: "kiwi", path: "a.png" })).status).toBe(403);
    expect((await notOwner.set("profile.photo", { path: "a.png" })).status).toBe(403);
    expect(notOwner.pictureFiles.taken).toEqual([]);

    const fx = fixture({ pictureRefusal: "a.png is not a PNG, JPEG, GIF or WebP picture." });
    expect(await fx.set("bots.picture", { botId: "nobody", path: "a.png" })).toMatchObject({ status: 409, body: { error: "No bot has the id nobody. Use list_bots for the ids." } });
    expect(await fx.set("bots.picture", { botId: "kiwi", path: "a.png" })).toEqual({ status: 400, body: { error: "a.png is not a PNG, JPEG, GIF or WebP picture." } });
    expect(await fx.set("bots.picture", { botId: "kiwi", avatarUrl: "/api/attachments/x.png" })).toMatchObject({ status: 400 });
    expect([fx.botPatches, fx.saved, fx.cards()]).toEqual([[], [], []]);
  });

  it("takes back the stored copy when the route refuses the change", async () => {
    const fx = fixture({ patchRefusal: "avatarUrl must reference an existing stored image" });
    expect(await fx.set("bots.picture", { botId: "kiwi", path: "a.png" })).toEqual({ status: 409, body: { error: "avatarUrl must reference an existing stored image" } });
    expect(fx.pictureFiles.discarded).toEqual(["/api/attachments/stored-1.png"]);
    expect(fx.cards()).toEqual([]);
  });

  it("never takes a key or token in a value", async () => {
    const fx = fixture();
    for (const [id, value] of [["bots.settings", { botId: "kiwi", apiKey: OPENAI_KEY }], ["ai.routing", { enabled: true, openrouterKey: OPENAI_KEY }], ["ai.images", { key: OPENAI_KEY }]] as const) {
      const refused = await fx.set(id, JSON.stringify(value));
      expect(refused.status, id).toBe(400);
      expect(refused.body.error, id).toContain("Never put a key or token in the value");
    }
    expect(fx.cards()).toEqual([]);
    expect(JSON.stringify(fx.messages)).not.toContain(OPENAI_KEY);
  });

  it("picks a custom decision endpoint with Undo, but never sets its address", async () => {
    const { set, saved } = fixture();
    expect((await set("ai.routing", JSON.stringify({ provider: "custom", customModel: "m-1", customApi: "decisions" }))).status).toBe(200);
    expect(saved).toEqual([{ decider: { provider: "custom", customModel: "m-1", customApi: "decisions" } }]);
    expect((await set("ai.routing", JSON.stringify({ customBaseUrl: "https://elsewhere.example.com" }))).status).toBe(400);
    expect(saved).toHaveLength(1);
  });

  it("a browser profile is added naming whose browser it uses, never removed by a bot, and Undo takes the new one away", async () => {
    const fx = fixture();
    (fx.cfg as { browserProfiles?: unknown }).browserProfiles = [{ id: "work", name: "Work" }];
    expect((await fx.set("desktops.browserProfiles", JSON.stringify([]))).body.error).toMatch(/^Removing the browser profile "Work" deletes its saved logins/);
    expect(fx.cards()).toEqual([]);
    await fx.set("desktops.browserProfiles", JSON.stringify([{ id: "work", name: "Work" }, { name: "Mine", browser: "chrome" }]));
    expect(fx.cards()[0]!.card.subtitle).toBe("Browser profiles: add the profile \"Mine\" on your own running Chrome, with its logins");
    expect(fx.saved).toEqual([{ browserProfiles: [{ id: "work", name: "Work" }, { id: expect.stringMatching(/^profile-[0-9a-f]{32}$/), name: "Mine", browser: "chrome" }], expectedBrowserProfiles: [{ id: "work", name: "Work" }] }]);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.saved.at(-1)).toMatchObject({ browserProfiles: [{ id: "work", name: "Work" }] });
  });

  it("other bot settings name each change, and Undo restores each field as the bot ran on it", async () => {
    const fx = fixture();
    await fx.set("bots.settings", JSON.stringify({ botId: "kiwi", memoryEnabled: false, computer: "local" }));
    expect(fx.cards()[0]!.card.subtitle).toBe("Kiwi: memory off; computer use this computer's own desktop, as you");
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.botPatches).toEqual([{ botId: "kiwi", body: { memoryEnabled: false, computer: "local" } }, { botId: "kiwi", body: { memoryEnabled: true, computer: null } }]);
  });

  it("never keeps a bot on this computer from a routine or other automation, the owner's own included", async () => {
    const fx = fixture({ automated: true });
    const refused = await fx.set("bots.settings", JSON.stringify({ botId: "kiwi", computer: "local" }));
    expect(refused.status).toBe(403);
    expect(String(refused.body.error)).toContain("A routine or automation can't keep a bot on this computer. Nothing changed");
    expect(String(refused.body.error)).toContain("This computer under “Where Kiwi works” in Bot's screen");
    expect(fx.botPatches).toEqual([]);
    expect(fx.cards()).toEqual([]);
    // Other settings, and another place, still change from an automation as before.
    expect((await fx.set("bots.settings", JSON.stringify({ botId: "kiwi", computer: "vm" }))).status).toBe(200);
    expect(fx.botPatches).toEqual([{ botId: "kiwi", body: { computer: "vm" } }]);
  });

  it("turns one bot's tool groups off and on by name, keeps the rest as they were, and Undo puts the list back", async () => {
    const fx = fixture();
    (fx.bots.find((bot) => bot.id === "kiwi") as { toolsOff?: string[] }).toolsOff = ["images"];
    await fx.set("bots.tools", JSON.stringify({ botId: "kiwi", turnOff: ["pages", "meetings"] }));
    expect(fx.cards()[0]!.card.subtitle).toBe("Kiwi: turn off Pages and apps, Meetings");
    await fx.set("bots.tools", JSON.stringify({ botId: "kiwi", turnOn: ["images"] }));
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.botPatches).toEqual([
      { botId: "kiwi", body: { toolsOff: ["meetings", "pages", "images"] } },
      { botId: "kiwi", body: { toolsOff: ["meetings", "pages"] } },
      { botId: "kiwi", body: { toolsOff: ["meetings", "pages", "images"] } },
    ]);
    expect((await fx.set("bots.tools", JSON.stringify({ botId: "kiwi", turnOff: ["browser"] }))).status).toBe(400);
    expect((await fx.set("bots.tools", JSON.stringify({ botId: "kiwi", turnOff: ["data"], turnOn: ["data"] }))).status).toBe(400);
    expect((await fx.set("bots.tools", JSON.stringify({ botId: "kiwi" }))).status).toBe(400);
  });

  it("a bot's library skills are set from the full list, and Undo gives back the earlier list", async () => {
    const fx = fixture();
    await fx.set("bots.skills", JSON.stringify({ botId: "clive", skills: [] }));
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.routeCalls).toEqual([
      { route: "skills", method: "PUT", path: "/api/bots/clive/skills-library", body: { skills: [] } },
      { route: "skills", method: "PUT", path: "/api/bots/clive/skills-library", body: { skills: ["notes"] } },
    ]);
  });
});
