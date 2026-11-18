import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import type { WindowPrefValue } from "../../shared/app-settings.ts";
import type { ModelSelection } from "../../shared/model-selection.ts";
import type { AppConfig } from "../config.ts";
import { flushDecisionLog } from "../decision-log.ts";
import { botDefaultModelSchema } from "../model-selection-schema.ts";
import { createWindowPrefs, WINDOW_PREFS_PATH } from "../routes/app-settings.ts";
import { callRoute } from "../routes/call-route.ts";
import type { BotRecord, Message } from "../store.ts";
import { createAppSettings } from "./host.ts";
import { createSettingsRegistry } from "./registry.ts";

type Mode = WindowPrefValue<"appearance.mode">;
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await flushDecisionLog(dir);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function fixture(initialMode: Mode = "raw", modelSelection: ModelSelection = { instanceId: "fixture-engine", model: "first" }) {
  const dataDir = mkdtempSync(join(tmpdir(), "settings-undo-"));
  dirs.push(dataDir);
  const bot = { id: "bot", name: "Fixture Bot", threadId: "thread", modelSelection } as BotRecord;
  const frames: Record<string, unknown>[] = [];
  const patches: Record<string, unknown>[] = [];
  const messages: Message[] = [];
  const window = createWindowPrefs({
    ownerOrAdmin: (auth) => auth.scopes.includes("admin"), windowOpen: () => true,
    broadcast: (frame) => frames.push(frame),
  });
  const reportMode = (mode: Mode) => callRoute(window.routes, {
    method: "PUT", path: WINDOW_PREFS_PATH, body: { values: { "appearance.mode": mode } },
    auth: { kind: "loopback", scopes: ["admin", "client"] },
  });
  expect(await reportMode(initialMode)).toMatchObject({ status: 200 });
  const unused = async () => { throw new Error("Unexpected fixture write"); };
  const entries = createSettingsRegistry({
    cfg: () => ({}) as AppConfig, bots: () => [bot], sections: () => [], credentials: () => ({}),
    paused: () => [], savedStepsHere: () => false, engineChosen: () => false, window,
    engines: () => [{ instanceId: "fixture-engine", name: "Fixture engine", working: true }],
    patchBot: async (id, patch) => {
      expect(id).toBe(bot.id);
      expect(patch.requireAvailableModel).toBe(true);
      patches.push(structuredClone(patch));
      bot.modelSelection = botDefaultModelSchema.parse(patch.modelSelection);
      return null;
    },
    saveConfig: unused, reorderBots: unused, groupBots: unused, pinBot: unused, call: unused, read: unused,
    renameBot: unused, colorBot: unused, archiveBot: unused, showHelper: unused, addEngine: unused, removeEngine: unused,
  });
  const host = createAppSettings({
    dataDir, entries,
    store: {
      bot: (id) => id === bot.id ? bot : null,
      appendMessage: (_, message) => {
        const row = { ...message, id: `m${messages.length}`, at: 1 };
        messages.push(row);
        return row;
      },
      messagesFor: () => messages,
      patchMessage: (_, id, patch) => {
        const row = messages.find((candidate) => candidate.id === id);
        return row ? Object.assign(row, patch) : null;
      },
      setActivity: () => null, setTaskActivity: () => null, taskByThread: () => undefined,
    },
    turnOwner: () => "owner", guestDriven: () => false, requestCredential: unused,
    connectorThread: () => null, activeGroupTurnForBot: () => null, notify: () => {}, language: () => "en",
  });
  const turn = { botId: bot.id, threadId: bot.threadId, generation: "fixture" };
  const set = (id: string, value: unknown) => host.handle({ action: "set", id, value }, turn);
  const find = (query: string) => host.handle({ action: "find", query }, turn);
  const undo = () => host.undo({ threadId: turn.threadId, requestId: messages.at(-1)!.card!.requestId! });
  return { set, find, undo, reportMode, bot, window, frames, patches, messages };
}

it("exposes only the canonical mode in discovery and restores Raw from the legacy Advanced card", async () => {
  const fx = await fixture();
  expect((await fx.set("appearance.advanced", "true")).status).toBe(200);
  expect(fx.window.read("appearance.mode")).toBe("advanced");
  expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
  expect(fx.window.read("appearance.mode")).toBe("raw");
  expect(fx.frames).toEqual([
    { kind: "window-pref", id: "appearance.mode", value: "advanced" },
    { kind: "window-pref", id: "appearance.mode", value: "raw" },
  ]);
  const found = await fx.find("advanced mode");
  const ids = JSON.parse(String(found.body.text)).map((entry: { id: string }) => entry.id);
  expect(ids).toContain("appearance.mode");
  expect(ids).not.toContain("appearance.advanced");
});

it("keeps Raw when the legacy setting is explicitly false", async () => {
  const fx = await fixture();
  expect((await fx.set("appearance.advanced", false)).status).toBe(200);
  expect(fx.window.read("appearance.mode")).toBe("raw");
  expect(fx.frames).toEqual([{ kind: "window-pref", id: "appearance.mode", value: "raw" }]);
});

it("rejects mode Undo after a later Raw choice even though both Raw and Simple read as false", async () => {
  const fx = await fixture("advanced");
  expect((await fx.set("appearance.advanced", false)).status).toBe(200);
  expect(fx.window.read("appearance.mode")).toBe("simple");
  expect(await fx.reportMode("raw")).toMatchObject({ status: 200 });
  expect(await fx.undo()).toMatchObject({ claimed: true, state: "invalid", status: 409, stale: true });
  expect(fx.frames).toHaveLength(1);
});

it.each([{ variant: "fast" }, { contextWindowTokens: 200_000 }])("restores a prior model selection with %o", async (override) => {
  const original = { instanceId: "fixture-engine", model: "first", ...override };
  const fx = await fixture("raw", original);
  const selection = { instanceId: "fixture-engine", model: "second", effort: "high" };
  expect((await fx.set("bots.model", { botId: "bot", ...selection })).status).toBe(200);
  expect(fx.bot.modelSelection).toEqual(selection);
  expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
  expect(fx.bot.modelSelection).toEqual(original);
  expect(fx.patches).toEqual([selection, original].map((modelSelection) => ({ modelSelection, requireAvailableModel: true })));
});

it.each([{ variant: "standard" }, { contextWindowTokens: 300_000 }])("rejects stale model Undo after a later %o edit", async (override) => {
  const fx = await fixture();
  expect((await fx.set("bots.model", { botId: "bot", instanceId: "fixture-engine", model: "second" })).status).toBe(200);
  fx.bot.modelSelection = { ...fx.bot.modelSelection, ...override };
  expect(await fx.undo()).toMatchObject({ claimed: true, state: "invalid", status: 409, stale: true });
  expect(fx.patches).toHaveLength(1);
});

it("accepts a bounded requested context and still rejects secret fields and conflicting reasoning controls", async () => {
  const fx = await fixture();
  const selection = { botId: "bot", instanceId: "fixture-engine", model: "second" };
  for (const invalid of [{ apiKey: "fixture-secret" }, { contextWindowTokens: 1 }, { variant: "fast", effort: "high" }]) {
    expect((await fx.set("bots.model", { ...selection, ...invalid })).status).toBe(400);
  }
  expect(fx.patches).toHaveLength(0);
  expect((await fx.set("bots.model", { ...selection, variant: "fast", contextWindowTokens: 200_000 })).status).toBe(200);
  expect(fx.bot.modelSelection).toEqual({ instanceId: "fixture-engine", model: "second", variant: "fast", contextWindowTokens: 200_000 });
});
