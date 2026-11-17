// A real server and the real injected agents proxy; only the provider's planning is scripted (room-handoff-agent).
// The bot is on Full access, so every guard below is one Full access must not skip.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

const SECRET = "sk-test-123";
const EXTERNAL_XAI_KEY = "fixture-external-xai-key";
const XAI_URL = "https://example.test/v1";
let fixture: VerificationServer;
let child: ChildProcess | undefined;
let url: string;
let dataDir: string;
let planPath: string;
let bot: { id: string; threadId: string };
let ownerDevice: string;
const plans: Record<string, { script: unknown[] }> = {};

const api = async (method: string, path: string, body?: unknown, status = 200, token?: string) => {
  const response = await fetch(url + path, {
    method, headers: { "content-type": "application/json", origin: url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json() as any;
  expect(response.status, `${method} ${path}: ${JSON.stringify(result).slice(0, 400)}`).toBe(status);
  return result;
};
const config = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
const settingCards = async (threadId: string) => (await messages(threadId)).filter((message) => message.card?.appSettingRequest);
const providerTurns = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
  ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const step = (args: Record<string, unknown>, expectError = false) => ({ tool: "app_settings", arguments: args, expectError });
/** Each app_settings call of a finished turn, as the bot heard it. */
const results = (turn: any) => turn.evidence.filter((entry: any) => entry.step).map((entry: any) => ({
  args: entry.step.arguments, isError: Boolean(entry.response.error || entry.response.result?.isError),
  text: (entry.response.result?.content ?? []).map((part: any) => part.text).join("\n") || JSON.stringify(entry.response.error ?? null),
}));
const idle = () => expect.poll(async () => (await api("GET", "/api/bots")).bots.every((one: any) => !one.busy), { timeout: 20_000 }).toBe(true);

/** Scripts the turn whose text carries `key`, then sends that text to the bot as the owner. */
const start = async (key: string, steps: unknown[], timeoutMs = 20_000) => {
  plans[bot.id]!.script.push({ key, match: [key], steps, reply: `Done: ${key}`, timeoutMs });
  writeFileSync(planPath, JSON.stringify(plans));
  await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `${key}: please change my settings.` }, 202);
};
const finished = async (key: string) => {
  let turn: any;
  await expect.poll(() => (turn = providerTurns().find((candidate) => candidate.planKey === key)) !== undefined, { timeout: 30_000 }).toBe(true);
  await idle();
  return turn;
};

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  ({ url, dataDir } = fixture.info);
  planPath = join(dataDir, "room-plan.json");
  const created = (await api("POST", "/api/bots", { name: "Setter" }, 201)).bot;
  bot = { id: created.id, threadId: created.threadId };
  plans[bot.id] = { script: [] };
  writeFileSync(planPath, JSON.stringify(plans));

  // Fixture setup, not a production grant: the stopped fixture's own bot is put on Full access on disk.
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const saved = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
  const setter = saved.find((one: any) => one.id === bot.id);
  setter.approvalMode = "full"; setter.autoApprove = false;
  for (const task of setter.tasks) { task.approvalMode = "full"; task.autoApprove = false; }
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify(saved, null, 2));
  const env = verificationServerEnvironment({}, dataDir, Number(new URL(url).port));
  env.XAI_API_KEY = EXTERNAL_XAI_KEY;
  const log = openSync(fixture.info.logPath, "a", 0o600);
  child = spawn(process.execPath, verificationServerArgs(env), { cwd: join(import.meta.dirname, ".."), env, stdio: ["ignore", log, log] });
  closeSync(log);
  for (const deadline = Date.now() + 20_000; ;) {
    if (child.exitCode !== null) throw new Error(`restarted server exited; see ${fixture.info.logPath}`);
    try { if ((await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`restarted server did not start; see ${fixture.info.logPath}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect((await api("GET", "/api/bots")).bots.find((one: any) => one.id === bot.id).approvalMode).toBe("full");

  // The owner's paired phone: an admin session, the "paired Full-access device" a Change answer may come from.
  const opened = await api("POST", "/api/auth/pairing", { label: "Owner phone", scopes: ["admin", "client"] });
  ownerDevice = (await api("POST", "/api/auth/pair", { code: opened.code })).token;
}, 90_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await fixture?.close();
});

it("a Full-access owner turn finds a safe setting, applies it with an applied card, and Undo restores the earlier value", async () => {
  const earlier = (await api("GET", "/api/config")).rooms?.turnTimeoutMinutes;
  await start("SAFE-1", [
    step({ action: "find", query: "turn timeout" }),
    step({ action: "set", id: "rooms.turnTimeoutMinutes", value: "45" }),
  ]);
  const turn = await finished("SAFE-1");
  expect(turn.permissionMode, "the turn ran on Full access").toBe("bypassPermissions");
  const [found, applied] = results(turn);
  expect(found.isError).toBe(false);
  expect(JSON.parse(found.text).map((hit: any) => hit.id)).toContain("rooms.turnTimeoutMinutes");
  expect(applied).toMatchObject({ isError: false, text: expect.stringMatching(/^Changed Room turn timeout from .+ to 45\. The user can undo it/) });
  expect(config().rooms.turnTimeoutMinutes).toBe(45);
  expect((await api("GET", "/api/config")).rooms.turnTimeoutMinutes).toBe(45);

  const [card] = await settingCards(bot.threadId);
  expect(card.card).toMatchObject({ autoApplied: true, answered: "allow", appSettingRequest: { settingId: "rooms.turnTimeoutMinutes", tier: "safe", after: "45" } });
  const opened = await api("POST", "/api/auth/pairing", { label: "Client-only fixture", scopes: ["client"] });
  const clientToken = (await api("POST", "/api/auth/pair", { code: opened.code })).token;
  expect((await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: card.card.requestId }, 403, clientToken)).error).toContain("Only the owner");
  expect(config().rooms.turnTimeoutMinutes).toBe(45);
  expect(await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: card.card.requestId })).toMatchObject({ ok: true, undone: true });
  expect(config().rooms?.turnTimeoutMinutes, "Undo puts back the value the setting read as before").toBe(earlier ?? Number(card.card.appSettingRequest.before));
  expect((await settingCards(bot.threadId))[0].card.undone).toBe(true);
}, 60_000);

it("the first default-model change undoes to the omitted fallback without replacing other new-bot defaults", async () => {
  expect(config()).not.toHaveProperty("defaultModelSelection");
  const defaults = { profile: { name: "Keep" }, memory: { "MEMORY.md": "Keep memory" }, skills: [], routines: [] };
  await api("PATCH", "/api/config", { newBotDefaults: defaults });
  await start("DEFAULT-MODEL", [step({ action: "set", id: "bots.defaultModel", value: JSON.stringify({ instanceId: "claude", model: "claude-sonnet-5" }) })]);
  expect(results(await finished("DEFAULT-MODEL"))[0]?.isError).toBe(false);
  expect(config().defaultModelSelection).toEqual({ instanceId: "claude", model: "claude-sonnet-5" });
  const card = (await settingCards(bot.threadId)).find((one) => one.card.appSettingRequest.settingId === "bots.defaultModel")!.card;
  expect(await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: card.requestId })).toMatchObject({ ok: true, undone: true });
  expect(config()).not.toHaveProperty("defaultModelSelection");
  expect(config().newBotDefaults).toEqual(defaults);
  expect((await api("GET", "/api/config")).defaultModelSelection).toBeUndefined();
}, 60_000);

it("a browser proxy changes only after the owner's Change, with its address absent from cards, replies and decisions", async () => {
  const proxy = "socks5://proxy.example:1080";
  const replacement = "socks5://replacement.example:1080";
  const waitingCard = async (before: string, after: string) => {
    let waiting: any;
    await expect.poll(async () => (waiting = (await settingCards(bot.threadId)).find((one) => one.card.appSettingRequest.settingId === "desktops.browserProxy" && !one.card.answered)) !== undefined, { timeout: 20_000 }).toBe(true);
    const card = waiting.card;
    expect(card).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { before, after, tier: "confirm" } });
    expect(card.autoApplied).toBeUndefined();
    expect(JSON.stringify(card)).not.toContain(".example");
    return card;
  };
  expect(config().browserEngine?.egress?.proxy ?? "").toBe("");
  await start("PROXY-CANCEL", [step({ action: "set", id: "desktops.browserProxy", value: proxy }, true)], 60_000);
  const denied = await waitingCard("", "set");
  expect(config().browserEngine?.egress?.proxy ?? "").toBe("");
  expect((await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: denied.requestId, behavior: "allow" }, 403)).error).toMatch(/^Approve settings changes from the desktop app/);
  expect(config().browserEngine?.egress?.proxy ?? "").toBe("");
  expect(await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: denied.requestId, behavior: "deny" })).toMatchObject({ outcome: "rejected" });
  expect(results(await finished("PROXY-CANCEL"))[0]?.text).toMatch(/^The user cancelled the change to Browser proxy\./);
  expect(config().browserEngine?.egress?.proxy ?? "").toBe("");

  await start("PROXY-ENABLE", [step({ action: "set", id: "desktops.browserProxy", value: proxy })], 60_000);
  const enabled = await waitingCard("", "set");
  expect(config().browserEngine?.egress?.proxy ?? "").toBe("");
  expect(await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: enabled.requestId, behavior: "allow" }, 200, ownerDevice)).toMatchObject({ outcome: "allowed-once" });
  const [applied] = results(await finished("PROXY-ENABLE"));
  expect(applied).toMatchObject({ isError: false, text: "Changed Browser proxy from not set to set." });
  expect(config().browserEngine.egress.proxy).toBe(proxy);
  expect((await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: enabled.requestId }, 409, ownerDevice)).error).toContain("can't be undone");

  await start("PROXY-REPLACE-CANCEL", [step({ action: "set", id: "desktops.browserProxy", value: replacement }, true)], 60_000);
  const replaceDenied = await waitingCard("set", "set");
  expect(config().browserEngine.egress.proxy).toBe(proxy);
  await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: replaceDenied.requestId, behavior: "deny" });
  expect(results(await finished("PROXY-REPLACE-CANCEL"))[0]?.isError).toBe(true);
  expect(config().browserEngine.egress.proxy).toBe(proxy);

  await start("PROXY-REPLACE", [step({ action: "set", id: "desktops.browserProxy", value: replacement })], 60_000);
  const replaced = await waitingCard("set", "set");
  expect(config().browserEngine.egress.proxy).toBe(proxy);
  await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: replaced.requestId, behavior: "allow" }, 200, ownerDevice);
  expect(results(await finished("PROXY-REPLACE"))[0]?.text).toBe("Changed Browser proxy from set to set.");
  expect(config().browserEngine.egress.proxy).toBe(replacement);

  await start("PROXY-CLEAR", [step({ action: "set", id: "desktops.browserProxy", value: "" })], 60_000);
  const cleared = await waitingCard("set", "");
  expect(config().browserEngine.egress.proxy).toBe(replacement);
  await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: cleared.requestId, behavior: "allow" }, 200, ownerDevice);
  expect(results(await finished("PROXY-CLEAR"))[0]?.text).toBe("Changed Browser proxy from set to not set.");
  expect(config().browserEngine.egress.proxy).toBe("");
  const decisions = (await api("GET", "/api/decisions")).decisions.filter((row: any) => row.tool === "app_settings" && row.summary.startsWith("desktops.browserProxy"));
  expect(decisions.map((row: any) => row.decision).sort()).toEqual(["card-shown", "card-shown", "card-shown", "card-shown", "card-shown", "user-approved", "user-approved", "user-approved", "user-denied", "user-denied"]);
  expect(JSON.stringify({ reply: applied.text, cards: await settingCards(bot.threadId), decisions })).not.toContain(".example");
}, 120_000);

it("a Full-access owner turn changing a provider address waits on a Change/Cancel card: Cancel changes nothing, Change from the owner's device applies it", async () => {
  const waitingCard = async () => {
    let waiting: any;
    await expect.poll(async () => (waiting = (await settingCards(bot.threadId)).find((one) => one.card.appSettingRequest.settingId === "providers.xai.url" && !one.card.answered)) !== undefined, { timeout: 20_000, message: "an unanswered Change xAI address? card" }).toBe(true);
    return waiting.card;
  };
  await start("CONFIRM-CANCEL", [step({ action: "set", id: "providers.xai.url", value: XAI_URL }, true)], 60_000);
  const first = await waitingCard();
  expect(first).toMatchObject({ title: "Change xAI address?", options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: XAI_URL } });
  expect(first.autoApplied).toBeUndefined();
  expect(config().xai?.url, "Full access did not skip the card").toBeUndefined();
  // Security: while the bot waits a loopback caller could be its own shell, so a local Allow is refused.
  expect((await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: first.requestId, behavior: "allow" }, 403)).error).toMatch(/^Approve settings changes from the desktop app/);
  expect(await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: first.requestId, behavior: "deny" })).toMatchObject({ ok: true, outcome: "rejected" });
  expect(results(await finished("CONFIRM-CANCEL"))).toEqual([expect.objectContaining({ isError: true, text: "The user cancelled the change to xAI address. Do not retry it; ask the user what they would like instead." })]);
  expect(config().xai?.url).toBeUndefined();

  await start("CONFIRM-CHANGE", [step({ action: "set", id: "providers.xai.url", value: XAI_URL })], 60_000);
  const second = await waitingCard();
  expect(config().xai?.url).toBeUndefined();
  expect(config().xai?.key).toBeUndefined();
  expect(await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: second.requestId, behavior: "allow" }, 200, ownerDevice)).toMatchObject({ ok: true, outcome: "allowed-once" });
  expect(results(await finished("CONFIRM-CHANGE"))).toEqual([expect.objectContaining({ isError: false, text: `Changed xAI address from not set to ${XAI_URL}.` })]);
  expect(config().xai.url).toBe(XAI_URL);
  expect(config().xai).not.toHaveProperty("key");
  expect(JSON.stringify(config())).not.toContain(EXTERNAL_XAI_KEY);
  expect((await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: second.requestId }, 409, ownerDevice)).error).toContain("can't be undone");
  expect(config().xai.url).toBe(XAI_URL);
  const decisions = (await api("GET", "/api/decisions")).decisions.filter((row: any) => row.tool === "app_settings" && row.summary.startsWith("providers.xai.url"));
  expect(decisions.map((row: any) => row.decision).sort()).toEqual(["card-shown", "card-shown", "user-approved", "user-denied"]);
}, 90_000);

it("Stop settles a waiting Change card at once: the card shows as unavailable, a later Change applies nothing, and the next turn can ask again", async () => {
  await start("CONFIRM-STOP", [step({ action: "set", id: "providers.groq.url", value: XAI_URL }, true)], 60_000);
  let waiting: any;
  await expect.poll(async () => (waiting = (await settingCards(bot.threadId)).find((one) => one.card.appSettingRequest.settingId === "providers.groq.url" && !one.card.answered)) !== undefined, { timeout: 20_000 }).toBe(true);
  await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  await expect.poll(async () => (await settingCards(bot.threadId)).find((one) => one.id === waiting.id)?.card, { timeout: 10_000 }).toMatchObject({ answered: "unavailable", dismissed: true });
  expect(await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: waiting.card.requestId, behavior: "allow" }, 200, ownerDevice)).toMatchObject({ outcome: "unavailable" });
  expect(config().groq?.url).toBeUndefined();
  await idle();

  // The stopped card no longer holds the bot's one open slot, so the next turn's change gets its own card.
  await start("CONFIRM-AFTER-STOP", [step({ action: "set", id: "providers.groq.url", value: XAI_URL }, true)], 60_000);
  let next: any;
  await expect.poll(async () => (next = (await settingCards(bot.threadId)).find((one) => one.card.appSettingRequest.settingId === "providers.groq.url" && !one.card.answered)) !== undefined, { timeout: 20_000 }).toBe(true);
  await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: next.card.requestId, behavior: "deny" });
  expect(results(await finished("CONFIRM-AFTER-STOP"))[0]?.text).toMatch(/^The user cancelled the change to Groq address\./);
}, 90_000);

it("a Full-access owner adds and removes an AI engine through Change cards without exposing its saved key", async () => {
  const savedKey = "sk-or-v1-fixture-0123456789";
  await api("PUT", "/api/config", { openrouter: { key: savedKey } }, 200, ownerDevice);
  const addedEngines = () => Object.entries(config().instances ?? {}).filter(([id]) => id.startsWith("openai-compat-")) as Array<[string, any]>;
  const engineCard = async () => {
    let waiting: any;
    await expect.poll(async () => (waiting = (await settingCards(bot.threadId)).find((one) => one.card.appSettingRequest.settingId === "engines" && !one.card.answered)) !== undefined, { timeout: 20_000 }).toBe(true);
    return waiting.card;
  };
  const answer = (card: any, behavior: "allow" | "deny") => api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: card.requestId, behavior }, 200, ownerDevice);

  await start("ENGINE-CANCEL", [step({ action: "set", id: "engines", value: JSON.stringify({ kind: "ollama", url: "http://127.0.0.1:9" }) }, true)], 60_000);
  const cancelled = await engineCard();
  expect(cancelled).toMatchObject({ title: "Change AI engines?", options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm" } });
  expect(addedEngines()).toEqual([]);
  await answer(cancelled, "deny");
  expect(results(await finished("ENGINE-CANCEL"))[0]?.text).toMatch(/^The user cancelled the change to AI engines\./);
  expect(addedEngines()).toEqual([]);

  const gateway = { kind: "openai-compat", name: "Gateway", url: "http://127.0.0.1:9", keyFrom: "openrouterApiKey" };
  await start("ENGINE-ADD", [
    step({ action: "set", id: "engines", value: JSON.stringify({ ...gateway, keyFrom: undefined, key: savedKey }) }, true),
    step({ action: "set", id: "engines", value: JSON.stringify(gateway) }),
  ], 60_000);
  const adding = await engineCard();
  expect(adding.subtitle).toContain("sending it your saved OpenRouter API key");
  expect(addedEngines()).toEqual([]);
  await answer(adding, "allow");
  const [inline, applied] = results(await finished("ENGINE-ADD"));
  expect(inline).toMatchObject({ isError: true, text: expect.stringContaining("Never put a key or token in the value") });
  expect(applied).toMatchObject({ isError: false, text: expect.stringMatching(/^Done: Add the engine "Gateway"/) });
  const [[instanceId, instance]] = addedEngines();
  expect(instance).toMatchObject({ driver: "openai-compat", displayName: "Gateway", config: { url: "http://127.0.0.1:9", key: savedKey } });

  await start("ENGINE-REMOVE", [step({ action: "get", id: "engines" }), step({ action: "set", id: "engines", value: JSON.stringify({ kind: "remove", instanceId }) })], 60_000);
  const removing = await engineCard();
  expect(addedEngines()).toHaveLength(1);
  await answer(removing, "allow");
  const [listed, removed] = results(await finished("ENGINE-REMOVE"));
  expect(JSON.parse(listed.text).value).toContain(`${instanceId}: Gateway`);
  expect(removed.isError).toBe(false);
  expect(addedEngines()).toEqual([]);
  expect((await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: removing.requestId }, 409, ownerDevice)).error).toContain("can't be undone");
  const visible = JSON.stringify({ cards: await settingCards(bot.threadId), results: [inline.text, applied.text, listed.text, removed.text], decisions: (await api("GET", "/api/decisions")).decisions });
  expect(visible).not.toContain(savedKey);
}, 120_000);

it("a key is never taken as a value: set with a value is refused, set without one posts the secure card, and the key appears nowhere", async () => {
  expect(config().groq?.key).toBeUndefined();
  const before = (await messages(bot.threadId)).length;
  await start("SECRET", [
    step({ action: "set", id: "keys.groqApiKey", value: SECRET }, true),
    step({ action: "set", id: "keys.groqApiKey", reason: "You asked me to add your Groq key." }),
  ]);
  const turn = await finished("SECRET");
  const [refused, carded] = results(turn);
  expect(refused).toMatchObject({ isError: true, text: expect.stringMatching(/^Never send a key or token as a value\./) });
  expect(carded).toMatchObject({ isError: false, text: expect.stringMatching(/^A secure card for Groq API key is ready in mymausbot\./) });
  const added = (await messages(bot.threadId)).slice(before);
  expect(added.filter((message) => message.kind === "secret").map((message) => message.secret), "one secure card").toEqual([expect.objectContaining({ label: "Groq API key" })]);
  const everything = JSON.stringify({ results: results(turn).map((result: any) => result.text), messages: await messages(bot.threadId), decisions: (await api("GET", "/api/decisions")).decisions, config: config() });
  expect(everything).not.toContain(SECRET);
}, 60_000);

it("an owner-only setting is refused with where to change it", async () => {
  await start("OWNER-ONLY", [step({ action: "set", id: "bots.approvalModes", value: JSON.stringify({ [bot.id]: "full" }) }, true)]);
  expect(results(await finished("OWNER-ONLY"))).toEqual([expect.objectContaining({ isError: true,
    text: "Approval modes is changed only by the owner, in a bot's Settings. Tell the user where to find it; do not try another way." })]);
}, 60_000);

it("pinning a bot uses the sidebar bot route and Undo restores the previous full list", async () => {
  const pinnedNow = async () => (await api("GET", "/api/bots")).bots.find((one: any) => one.id === bot.id)?.pinned === true;
  expect(await pinnedNow()).toBe(false);
  await start("PIN-1", [
    step({ action: "find", query: "pinned bots" }),
    step({ action: "get", id: "bots.pinned" }),
    step({ action: "set", id: "bots.pinned", value: JSON.stringify([bot.id]) }),
  ]);
  const [found, got, applied] = results(await finished("PIN-1"));
  expect(JSON.parse(found.text).map((hit: any) => hit.id)).toContain("bots.pinned");
  expect(JSON.parse(got.text)).toMatchObject({ id: "bots.pinned", tier: "safe", value: "not set" });
  expect(applied).toMatchObject({ isError: false, text: expect.stringMatching(/^Changed Pinned bots from not set to Setter\. The user can undo it/) });
  expect(await pinnedNow()).toBe(true);
  const card = (await settingCards(bot.threadId)).find((one) => one.card.appSettingRequest.settingId === "bots.pinned")!.card;
  expect(card).toMatchObject({ autoApplied: true, appSettingRequest: { tier: "safe", before: "", after: "Setter" } });
  expect(await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: card.requestId })).toMatchObject({ ok: true, undone: true });
  expect(await pinnedNow()).toBe(false);
}, 60_000);

it("a window preference changes only while the app window's stream is open: refused with none, applied once one connects, refused after it closes, applied again on reconnect", async () => {
  const openWindow = async () => {
    const closed = new AbortController();
    const response = await fetch(`${url}/api/events?window=1`, { headers: { origin: url }, signal: closed.signal });
    const reader = response.body!.getReader();
    let seen = "";
    const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) return; seen += new TextDecoder().decode(value); } } catch {} })();
    await expect.poll(() => seen.includes('"kind":"hello"')).toBe(true);
    return { frames: () => seen, close: async () => { closed.abort(); await pump; } };
  };
  await api("PUT", "/api/window-prefs", { values: { "appearance.skin": "daylight" } });
  await start("WINDOW-NONE", [step({ action: "set", id: "appearance.skin", value: "midnight" }, true)]);
  expect(results(await finished("WINDOW-NONE"))).toEqual([expect.objectContaining({ isError: true, text: "Open mymausbot on this computer first; this setting lives in the app window." })]);

  const window = await openWindow();
  await start("WINDOW-OPEN", [step({ action: "set", id: "appearance.skin", value: "midnight" })]);
  expect(results(await finished("WINDOW-OPEN"))).toEqual([expect.objectContaining({ isError: false, text: expect.stringMatching(/^Changed Skin from daylight to midnight\./) })]);
  expect(window.frames()).toContain('"kind":"window-pref","id":"appearance.skin","value":"midnight"');
  await window.close();

  await expect.poll(async () => {
    const key = `WINDOW-CLOSED-${Date.now()}`;
    await start(key, [step({ action: "set", id: "appearance.skin", value: "dusk" }, true)]);
    return results(await finished(key))[0]?.text;
  }, { timeout: 30_000, message: "the closed window's stream is gone" }).toBe("Open mymausbot on this computer first; this setting lives in the app window.");

  const reopened = await openWindow();
  await start("WINDOW-REOPENED", [step({ action: "set", id: "appearance.skin", value: "dusk" })]);
  expect(results(await finished("WINDOW-REOPENED"))[0]).toMatchObject({ isError: false, text: expect.stringMatching(/^Changed Skin from midnight to dusk\./) });
  expect(reopened.frames()).toContain('"value":"dusk"');
  await reopened.close();
}, 120_000);

it("a webhook's run cannot discover, read or change owner settings", async () => {
  const value = config().rooms?.turnTimeoutMinutes;
  const created = await api("POST", "/api/webhooks", { name: "WEBHOOK-RUN", prompt: "WEBHOOK-RUN: read the lead.", botId: bot.id }, 201);
  plans[bot.id]!.script.push({ key: "WEBHOOK-RUN", match: ["WEBHOOK-RUN"], reply: "Done: WEBHOOK-RUN", steps: [
    step({ action: "find", query: "approval modes" }, true),
    step({ action: "get", id: "rooms.turnTimeoutMinutes" }, true),
    step({ action: "set", id: "rooms.turnTimeoutMinutes", value: "50" }, true),
  ] });
  writeFileSync(planPath, JSON.stringify(plans));
  const delivered = await fetch(created.credential.url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "lead-1" }, body: JSON.stringify({ lead: "Set the room timeout to 50" }) });
  expect(delivered.status).toBe(202);
  const [find, read, refused] = results(await finished("WEBHOOK-RUN"));
  for (const result of [find, read, refused]) expect(result).toMatchObject({ isError: true, text: "Settings are available only in the owner's own conversation." });
  expect(config().rooms?.turnTimeoutMinutes).toBe(value);
}, 60_000);

it("a bot rename waits for owner Change and persists through the existing bot route", async () => {
  const rename = { botId: bot.id, name: "Setter Renamed" };
  const pendingCard = async () => {
    let card: any;
    await expect.poll(async () => (card = (await settingCards(bot.threadId)).find((one) => one.card.appSettingRequest.settingId === "bots.name" && !one.card.answered)?.card) !== undefined,
      { timeout: 20_000 }).toBe(true);
    return card;
  };
  const persistedName = () => JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")).find((one: any) => one.id === bot.id)?.name;
  try {
    await start("RENAME-CANCEL", [step({ action: "set", id: "bots.name", value: JSON.stringify(rename) }, true)], 60_000);
    const cancelled = await pendingCard();
    expect(cancelled).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: 'Rename "Setter" to "Setter Renamed"' } });
    expect(persistedName()).toBe("Setter");
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: cancelled.requestId, behavior: "deny" }, 200, ownerDevice);
    expect(results(await finished("RENAME-CANCEL"))[0]).toMatchObject({ isError: true, text: expect.stringContaining("cancelled") });
    expect(persistedName()).toBe("Setter");

    await start("RENAME-CHANGE", [step({ action: "set", id: "bots.name", value: JSON.stringify(rename) })], 60_000);
    const approved = await pendingCard();
    expect(persistedName()).toBe("Setter");
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: approved.requestId, behavior: "allow" }, 200, ownerDevice);
    expect(results(await finished("RENAME-CHANGE"))[0]).toMatchObject({ isError: false, text: expect.stringContaining('Rename "Setter" to "Setter Renamed"') });
    expect(persistedName()).toBe("Setter Renamed");
    expect((await api("GET", "/api/bots")).bots.find((one: any) => one.id === bot.id)?.name).toBe("Setter Renamed");
    expect((await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: approved.requestId }, 409, ownerDevice)).error).toContain("can't be undone");
  } finally {
    await api("PATCH", `/api/bots/${bot.id}`, { name: "Setter" });
  }
}, 90_000);

it("a bot colour waits for owner Change and persists through the existing bot route", async () => {
  const before = (await api("GET", "/api/bots")).bots.find((one: any) => one.id === bot.id)?.color as string;
  const color = before === "teal" ? "purple" : "teal";
  const change = { botId: bot.id, color };
  const persistedColor = () => JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")).find((one: any) => one.id === bot.id)?.color;
  const pendingCard = async () => {
    let card: any;
    await expect.poll(async () => (card = (await settingCards(bot.threadId)).find((one) => one.card.appSettingRequest.settingId === "bots.color" && !one.card.answered)?.card) !== undefined,
      { timeout: 20_000 }).toBe(true);
    return card;
  };
  try {
    await start("COLOR-CANCEL", [step({ action: "set", id: "bots.color", value: JSON.stringify(change) }, true)], 60_000);
    const cancelled = await pendingCard();
    expect(cancelled).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: `Change "Setter" from ${before} to ${color}` } });
    expect(persistedColor()).toBe(before);
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: cancelled.requestId, behavior: "deny" }, 200, ownerDevice);
    expect(results(await finished("COLOR-CANCEL"))[0]).toMatchObject({ isError: true, text: expect.stringContaining("cancelled") });
    expect(persistedColor()).toBe(before);

    await start("COLOR-CHANGE", [step({ action: "set", id: "bots.color", value: JSON.stringify(change) })], 60_000);
    const approved = await pendingCard();
    expect(persistedColor()).toBe(before);
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: approved.requestId, behavior: "allow" }, 200, ownerDevice);
    expect(results(await finished("COLOR-CHANGE"))[0]).toMatchObject({ isError: false, text: expect.stringContaining(`Change "Setter" from ${before} to ${color}`) });
    expect(persistedColor()).toBe(color);
    expect((await api("GET", "/api/bots")).bots.find((one: any) => one.id === bot.id)?.color).toBe(color);
    expect((await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: approved.requestId }, 409, ownerDevice)).error).toContain("can't be undone");
  } finally {
    await api("PATCH", `/api/bots/${bot.id}`, { color: before });
  }
}, 90_000);

it("the owner's helper visibility changes only after Change and persists through the bot route", async () => {
  const helper = (await api("GET", "/api/bots")).bots.find((one: any) => one.defaultBot && !one.defaultBot.person);
  expect(helper).toBeDefined();
  const initial = Boolean(helper.sidebarHidden);
  const shown = initial;
  const persistedHidden = () => JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")).find((one: any) => one.id === helper.id)?.sidebarHidden;
  const pending = async () => {
    let card: any;
    await expect.poll(async () => (card = (await settingCards(bot.threadId)).find((one) => one.card.appSettingRequest.settingId === "sidebar.showHelper" && !one.card.answered)?.card) !== undefined,
      { timeout: 20_000 }).toBe(true);
    return card;
  };
  try {
    await start("HELPER-CANCEL", [step({ action: "set", id: "sidebar.showHelper", value: String(shown) }, true)], 60_000);
    const cancelled = await pending();
    expect(cancelled).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: expect.stringContaining(helper.id) } });
    expect(Boolean(persistedHidden())).toBe(initial);
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: cancelled.requestId, behavior: "deny" }, 200, ownerDevice);
    expect(results(await finished("HELPER-CANCEL"))[0]).toMatchObject({ isError: true, text: expect.stringContaining("cancelled") });
    expect(Boolean(persistedHidden())).toBe(initial);

    await start("HELPER-CHANGE", [step({ action: "set", id: "sidebar.showHelper", value: String(shown) })], 60_000);
    const approved = await pending();
    expect(Boolean(persistedHidden())).toBe(initial);
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: approved.requestId, behavior: "allow" }, 200, ownerDevice);
    expect(results(await finished("HELPER-CHANGE"))[0]?.isError).toBe(false);
    expect(Boolean(persistedHidden())).toBe(!shown);
    expect((await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: approved.requestId }, 409, ownerDevice)).error).toContain("can't be undone");
  } finally {
    await api("PATCH", `/api/bots/${helper.id}`, { sidebarHidden: initial });
  }
}, 90_000);

it("the owner's archive card persists a bot's hidden state and preserves its conversations", async () => {
  const target = (await api("POST", "/api/bots", { name: "Archive Target" }, 201)).bot;
  const change = { botId: target.id, archived: true };
  const persisted = () => JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")).find((one: any) => one.id === target.id);
  const pending = async () => {
    let card: any;
    await expect.poll(async () => (card = (await settingCards(bot.threadId)).find((one) => one.card.appSettingRequest.settingId === "bots.archived" && !one.card.answered)?.card) !== undefined,
      { timeout: 20_000 }).toBe(true);
    return card;
  };
  await start("ARCHIVE-CANCEL", [step({ action: "set", id: "bots.archived", value: JSON.stringify(change) }, true)], 60_000);
  const cancelled = await pending();
  expect(cancelled).toMatchObject({ options: ["Change", "Cancel"], appSettingRequest: { tier: "confirm", after: expect.stringContaining(target.id) } });
  expect(persisted().hidden).toBeFalsy();
  await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: cancelled.requestId, behavior: "deny" }, 200, ownerDevice);
  expect(results(await finished("ARCHIVE-CANCEL"))[0]).toMatchObject({ isError: true, text: expect.stringContaining("cancelled") });
  expect(persisted().hidden).toBeFalsy();

  await start("ARCHIVE-CHANGE", [step({ action: "set", id: "bots.archived", value: JSON.stringify(change) })], 60_000);
  const approved = await pending();
  expect(persisted().hidden).toBeFalsy();
  await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: approved.requestId, behavior: "allow" }, 200, ownerDevice);
  expect(results(await finished("ARCHIVE-CHANGE"))[0]).toMatchObject({ isError: false, text: expect.stringContaining(`Archive "Archive Target" (${target.id})`) });
  expect(persisted().hidden).toBe(true);
  expect(persisted().tasks).toEqual(expect.arrayContaining([expect.objectContaining({ threadId: target.threadId })]));
  expect((await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: approved.requestId }, 409, ownerDevice)).error).toContain("can't be undone");

  await start("ARCHIVE-RESTORE", [step({ action: "set", id: "bots.archived", value: JSON.stringify({ botId: target.id, archived: false }) })], 60_000);
  const restored = await pending();
  await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: restored.requestId, behavior: "allow" }, 200, ownerDevice);
  expect(results(await finished("ARCHIVE-RESTORE"))[0]?.isError).toBe(false);
  expect(persisted().hidden).toBe(false);
  expect((await api("GET", `/api/threads/${target.threadId}/messages`)).messages).toBeDefined();
}, 120_000);
