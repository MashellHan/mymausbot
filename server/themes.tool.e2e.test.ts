// "Make this picture my chat background" through the real server and the real injected agents proxy, with only the
// provider's planning scripted (room-handoff-agent): the picture the person attached reaches the engine as a path,
// add_theme_asset takes it (this turn, an earlier turn by name, or with no path at all) with no theme worn yet, and one
// set_theme wears it with the card and Undo. A HEIC photo, a tag naming a file outside the store, and an attachment
// belonging to another thread are refused.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { readRegistry, writeRegistry } from "./testing/registry.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.from([0, 0, 0, 0]), Buffer.from("mif1heic"), Buffer.alloc(64)]);

let fixture: VerificationServer;
let child: ChildProcess | undefined;
let url: string;
let dataDir: string;
let planPath: string;
let bot: { id: string; threadId: string };
let otherBot: { id: string; threadId: string };
const plans: Record<string, { script: unknown[] }> = {};

const api = async (method: string, path: string, body?: unknown, raw?: { bytes: Buffer; type: string }) => {
  const response = await fetch(url + path, {
    method, headers: { "content-type": raw?.type ?? "application/json", origin: url },
    ...(raw ? { body: raw.bytes } : body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
};
const providerTurns = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
  ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const step = (args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ tool: "app_settings", arguments: args, ...extra });
const results = (turn: any) => turn.evidence.filter((entry: any) => entry.step).map((entry: any) => ({
  isError: Boolean(entry.response.error || entry.response.result?.isError),
  text: (entry.response.result?.content ?? []).map((part: any) => part.text).join("\n") || JSON.stringify(entry.response.error ?? null),
}));
const promptOf = (turn: any) => JSON.stringify(turn.prompt);
const run = async (key: string, text: string, steps: unknown[], targetBot = bot) => {
  plans[targetBot.id]!.script.push({ key, match: [key], steps, reply: `Done: ${key}`, timeoutMs: 20_000 });
  writeFileSync(planPath, JSON.stringify(plans));
  expect((await api("POST", `/api/bots/${targetBot.id}/messages`, { threadId: targetBot.threadId, text: `${key}: ${text}` })).status).toBe(202);
  let turn: any;
  await expect.poll(() => (turn = providerTurns().find((candidate) => candidate.planKey === key)) !== undefined, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await api("GET", "/api/bots")).body.bots.every((one: any) => !one.busy), { timeout: 20_000 }).toBe(true);
  return turn;
};

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  ({ url, dataDir } = fixture.info);
  planPath = join(dataDir, "room-plan.json");
  const created = (await api("POST", "/api/bots", { name: "Painter" })).body.bot;
  bot = { id: created.id, threadId: created.threadId };
  const otherCreated = (await api("POST", "/api/bots", { name: "Other" })).body.bot;
  otherBot = { id: otherCreated.id, threadId: otherCreated.threadId };
  plans[bot.id] = { script: [] };
  plans[otherBot.id] = { script: [] };
  writeFileSync(planPath, JSON.stringify(plans));
  // Fixture setup, not a production grant: the stopped fixture's own bots are put on Full access on disk.
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const saved = readRegistry(dataDir).bots;
  for (const candidate of saved.filter((one: any) => one.id === bot.id || one.id === otherBot.id)) {
    candidate.approvalMode = "full"; candidate.autoApprove = false;
    for (const task of candidate.tasks) { task.approvalMode = "full"; task.autoApprove = false; }
  }
  writeRegistry(dataDir, { bots: saved });
  const env = verificationServerEnvironment({}, dataDir, Number(new URL(url).port));
  const log = openSync(fixture.info.logPath, "a", 0o600);
  child = spawn(process.execPath, verificationServerArgs(env), { cwd: join(import.meta.dirname, ".."), env, stdio: ["ignore", log, log] });
  closeSync(log);
  for (const deadline = Date.now() + hostTimeout(20_000); ;) {
    if (child.exitCode !== null) throw new Error(`restarted server exited; see ${fixture.info.logPath}`);
    try { if ((await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`restarted server did not start; see ${fixture.info.logPath}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}, 90_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await fixture?.close();
});

it("a picture attached in the chat becomes the chat background in two calls, with the card and Undo", async () => {
  const uploaded = await api("POST", "/api/attachments", undefined, { bytes: PNG, type: "image/png" });
  expect(uploaded.status).toBe(201);
  const path: string = uploaded.body.path;

  const first = await run("BG-1", `make this my chat background\n\n<attached-image path="${path}" name="Beach Day.png" />`, [
    step({ action: "add_theme_asset" }, { capture: { file: 'url\\("([^"]+)"\\)' } }),
    step({ action: "set_theme", id: "background", theme: JSON.stringify({ name: "Background", css: '[data-look="chat"] { background: url("{{file}}") center / cover; }' }) }),
  ]);
  expect(promptOf(first)).toContain('"type":"image"');
  const [added, worn] = results(first);
  expect(added).toMatchObject({ isError: false, text: expect.stringContaining('url("/api/theme-assets/background/beach-day.png")') });
  expect(worn.isError).toBe(false);
  const active = (await api("GET", "/api/themes/active")).body;
  expect(active).toMatchObject({ id: "background", theme: { css: expect.stringContaining("/api/theme-assets/background/beach-day.png") } });
  expect((await fetch(`${url}/api/theme-assets/background/beach-day.png`, { headers: { origin: url } })).status).toBe(200);

  const card = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).body.messages.filter((message: any) => message.card?.appSettingRequest).at(-1);
  expect(card.card.appSettingRequest).toMatchObject({ settingId: "appearance.theme", after: "Update the theme Background and wear it" });
  expect((await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: card.card.requestId })).body).toMatchObject({ ok: true, undone: true });
  expect((await api("GET", "/api/themes/active")).body.id).toBeNull();

  // A later turn names the earlier picture by the name it was attached under.
  const later = await run("BG-2", "use the beach picture I sent before", [step({ action: "add_theme_asset", id: "background", path: "Beach Day.png" })]);
  expect(results(later)[0]).toMatchObject({ isError: false, text: expect.stringContaining("Added to the theme Background") });
}, 120_000);

it("refuses a HEIC photo by name, a tag naming a file outside the store, and another thread's attachment", async () => {
  const heic = await api("POST", "/api/files?name=IMG_0042.HEIC", undefined, { bytes: HEIC, type: "image/heic" });
  expect(heic.status).toBe(201);
  const turn = await run("BG-3", `make this my background\n\n<attached-file path="${heic.body.path}" name="IMG_0042.HEIC" />`, [
    step({ action: "add_theme_asset" }, { expectError: true }),
  ]);
  expect(results(turn)[0].text).toMatch(/^That is a HEIC photo/);

  const secret = join(dataDir, "config.json");
  const forged = await run("BG-4", `use this\n\n<attached-image path="${secret}" name="config.png" />`, [
    step({ action: "add_theme_asset", path: secret }, { expectError: true }),
    step({ action: "add_theme_asset", path: "config.png" }, { expectError: true }),
  ]);
  expect(results(forged).map((result: any) => result.text)).toEqual([expect.stringContaining("not in your workspace"), expect.stringContaining("not in your workspace")]);

  // Another thread's attached file in the shared attachments store is invisible here.
  const otherUpload = await api("POST", "/api/attachments", undefined, { bytes: PNG, type: "image/png" });
  expect(otherUpload.status).toBe(201);
  const otherPath: string = otherUpload.body.path;
  await run("BG-5-OTHER", `remember this\n\n<attached-image path="${otherPath}" name="Other Thread.png" />`, [], otherBot);
  const crossThread = await run("BG-5", "use Other Thread.png", [
    step({ action: "add_theme_asset", path: otherPath }, { expectError: true }),
    step({ action: "add_theme_asset", path: "Other Thread.png" }, { expectError: true }),
  ]);
  expect(results(crossThread).map((result: any) => result.text)).toEqual([expect.stringContaining("not in your workspace"), expect.stringContaining("not in your workspace")]);

  // Edited/rewound inactive branch attachments stay invisible to both named and latest selection.
  const rewoundThread = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Branch Test" })).body.task.threadId as string;
  const oldUpload = await api("POST", "/api/attachments", undefined, { bytes: PNG, type: "image/png" });
  const activeUpload = await api("POST", "/api/attachments", undefined, { bytes: PNG, type: "image/png" });
  expect(oldUpload.status).toBe(201);
  expect(activeUpload.status).toBe(201);

  const runIn = async (key: string, threadId: string, text: string, steps: unknown[]) => {
    plans[bot.id]!.script.push({ key, match: [key], steps, reply: `Done: ${key}`, timeoutMs: 20_000 });
    writeFileSync(planPath, JSON.stringify(plans));
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: `${key}: ${text}` })).status).toBe(202);
    let turn: any;
    await expect.poll(() => (turn = providerTurns().find((candidate) => candidate.planKey === key)) !== undefined, { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await api("GET", "/api/bots")).body.bots.every((one: any) => !one.busy), { timeout: 20_000 }).toBe(true);
    return turn;
  };

  await runIn("BG-6-OLD", rewoundThread, `old\n\n<attached-image path="${oldUpload.body.path}" name="Old Branch.png" />`, []);
  const firstMsg = (await api("GET", `/api/threads/${rewoundThread}/messages?limit=50`)).body.messages.find((m: any) => m.role === "user");
  plans[bot.id]!.script.push({ key: "BG-6-EDIT", match: ["BG-6-EDIT"], steps: [], reply: "Branched", timeoutMs: 20_000 });
  writeFileSync(planPath, JSON.stringify(plans));
  const edited = await api("POST", `/api/bots/${bot.id}/messages/${firstMsg.id}/edit`, {
    threadId: rewoundThread,
    text: `BG-6-EDIT: replacement\n\n<attached-image path="${activeUpload.body.path}" name="100% #1?.png" />`,
  });
  expect(edited.status).toBe(202);
  await expect.poll(() => providerTurns().some((candidate) => candidate.planKey === "BG-6-EDIT"), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await api("GET", "/api/bots")).body.bots.every((one: any) => !one.busy), { timeout: 20_000 }).toBe(true);

  const branchCheck = await runIn("BG-6-CHECK", rewoundThread, "use the picture", [
    step({ action: "add_theme_asset", path: oldUpload.body.path }, { expectError: true }),
    step({ action: "add_theme_asset", path: "Old Branch.png" }, { expectError: true }),
    step({ action: "add_theme_asset" }),
    step({ action: "add_theme_asset", path: "100% #1?.png" }),
  ]);
  const branchResults = results(branchCheck);
  expect(branchResults[0].text).toContain("not in your workspace");
  expect(branchResults[1].text).toContain("not in your workspace");
  expect(branchResults[2]).toMatchObject({ isError: false, text: expect.stringContaining("/background/100-1") });
  expect(branchResults[3]).toMatchObject({ isError: false, text: expect.stringContaining("/background/100-1") });
}, 120_000);
