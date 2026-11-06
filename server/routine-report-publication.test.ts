import { describe, expect, it, vi } from "vitest";
import { dispatchRoutineReportTurn, routineReportPublicationPrompt, routineReportTurnPrompt, type RoutineReportPublicationContext, type RoutineReportTurnContext } from "./routine-report-publication.ts";

const original = '[Scheduled routine "Daily report" — do this now:]\nTrigger id: report-routine\nCollect the report and reply.';

function context(): RoutineReportPublicationContext {
  return {
    run: { id: "run-1", routineId: "report-routine", botId: "producer", target: "bot", runOn: "maus", status: "running", triggerSource: "schedule" },
    routine: { id: "report-routine", name: "X 每日 AI 动态", prompt: "Collect the report and reply.", botId: "producer",
      target: "bot", runOn: "maus", enabled: true },
    bot: { id: "producer", toolScope: { allow: ["mcp:agents:mini_app_report"] } },
    apps: [{ slug: "x-ai-digest", status: "active", shippedTemplateKind: "x_ai_digest", publisherBotIds: ["producer"], reportBoundToProducer: true }],
    localEnabled: true, writeAllowed: true,
  };
}

describe("installed report reminder for a local Routine turn", () => {
  it.each([
    ["X 每日 AI 动态", "x-ai-digest-included-1", "x_ai_digest"],
    ["AI 早报（新闻版 + 开源版）", "github-activity", "github_activity"],
  ] as const)("keeps the original %s task while requesting its authorized edition", (name, slug, kind) => {
    const input = context();
    input.routine!.name = name;
    input.apps = [{ slug, status: "active", shippedTemplateKind: kind, publisherBotIds: ["producer"], reportBoundToProducer: true }];
    const prompt = routineReportPublicationPrompt(original, input);
    expect(prompt.startsWith(`${original}\n\n`)).toBe(true);
    expect(prompt).toContain(`mini_app_report with action "publish", kind "${kind}"`);
    expect(prompt).toContain(`installed ${slug} report`);
    expect(prompt).toContain("Omit editionKey");
    expect(prompt).toContain("never invent items");
    expect(prompt).toContain("Keep the normal reply");
    expect(routineReportPublicationPrompt(prompt, input)).toBe(prompt);
    expect(input.routine!.prompt).toBe("Collect the report and reply.");
  });

  it("keeps the prompt unchanged without the current installed app and producer grant", () => {
    const missing = context(); missing.apps = [];
    const archived = context(); archived.apps = [{ ...archived.apps[0]!, status: "archived" }];
    const revoked = context(); revoked.apps = [{ ...revoked.apps[0]!, publisherBotIds: [] }];
    const other = context(); other.apps = [{ ...other.apps[0]!, publisherBotIds: ["another-bot"] }];
    const wrongKind = context(); wrongKind.apps = [{ ...wrongKind.apps[0]!, shippedTemplateKind: "github_activity" }];
    const wrongBinding = context(); wrongBinding.apps = [{ ...wrongBinding.apps[0]!, reportBoundToProducer: false }];
    const ambiguous = context(); ambiguous.apps = [ambiguous.apps[0]!, ambiguous.apps[0]!];
    for (const input of [missing, archived, revoked, other, wrongKind, wrongBinding, ambiguous]) {
      expect(routineReportPublicationPrompt(original, input)).toBe(original);
    }
  });

  it("keeps nonlocal, inactive, wrong-producer and denied turns unchanged", () => {
    const nonlocal = context(); nonlocal.localEnabled = false;
    const cloud = context(); cloud.run!.runOn = "cloud";
    const cloudRoutine = context(); cloudRoutine.routine!.runOn = "cloud";
    const room = context(); room.run!.target = "room-goal";
    const roomRoutine = context(); roomRoutine.routine!.target = "room-goal";
    const disabled = context(); disabled.routine!.enabled = false;
    const deleted = context(); deleted.routine = null;
    const waiting = context(); waiting.run!.status = "waiting";
    const differentRun = context(); differentRun.run!.routineId = "other-routine";
    const wrongProducer = context(); wrongProducer.run!.botId = "another-bot";
    const wrongBot = context(); wrongBot.bot!.id = "another-bot";
    const missingBot = context(); missingBot.bot = null;
    const readOnly = context(); readOnly.writeAllowed = false;
    const readOnlyRun = context(); readOnlyRun.run!.access = "read-and-draft";
    const readOnlyRoutine = context(); readOnlyRoutine.routine!.access = "read-and-draft";
    const webhook = context(); webhook.run!.triggerSource = "webhook";
    const appEvent = context(); appEvent.run!.eventSource = "app";
    const denied = context(); denied.bot!.toolScope = { deny: ["mcp:agents:mini_app_report"] };
    const otherTool = context(); otherTool.bot!.toolScope = { allow: ["mcp:agents:mini_app_info"] };
    const explicit = context(); explicit.routine!.prompt = "Use mini_app_report for x_ai_digest.";
    const unrelated = context(); unrelated.routine!.name = "Check my inbox";
    for (const input of [nonlocal, cloud, cloudRoutine, room, roomRoutine, disabled, deleted, waiting, differentRun,
      wrongProducer, wrongBot, missingBot, readOnly, readOnlyRun, readOnlyRoutine, webhook, appEvent, denied, otherTool, explicit, unrelated]) {
      expect(routineReportPublicationPrompt(original, input)).toBe(original);
    }
  });

  it("reads the current Routine and report binding at dispatch, retaining the original prompt when access disappears", async () => {
    const input = context();
    const reportAppsForBot = vi.fn(async () => input.apps);
    const routines = { runForThread: vi.fn(() => input.run), listRoutines: vi.fn(() => [input.routine!]) };
    const current = { routines, botForId: () => input.bot, reportAppsForBot,
      localEnabled: () => true, writeAllowed: () => true, stopped: () => false };
    const added = await routineReportTurnPrompt(original, "producer", "run-thread", current);
    expect(added).toContain('kind "x_ai_digest"');
    expect(reportAppsForBot).toHaveBeenCalledExactlyOnceWith("producer");
    const startTurn = vi.fn(async (_prompt: string) => {});
    await dispatchRoutineReportTurn(original, "producer", "run-thread", current, startTurn);
    expect(startTurn).toHaveBeenCalledExactlyOnceWith(added);
    input.apps = [{ ...input.apps[0]!, reportBoundToProducer: false }];
    expect(await routineReportTurnPrompt(original, "producer", "run-thread", current)).toBe(original);
    input.apps = [{ ...input.apps[0]!, reportBoundToProducer: true }];
    input.routine!.enabled = false;
    expect(await routineReportTurnPrompt(original, "producer", "run-thread", current)).toBe(original);
    reportAppsForBot.mockRejectedValueOnce(new Error("unavailable"));
    input.routine!.enabled = true;
    expect(await routineReportTurnPrompt(original, "producer", "run-thread", current)).toBe(original);
    reportAppsForBot.mockClear();
    expect(await routineReportTurnPrompt(original, "another-bot", "run-thread", current)).toBe(original);
    expect(reportAppsForBot).not.toHaveBeenCalled();
  });

  it("does not start a cancelled, replaced or shut-down run after report lookup resolves", async () => {
    for (const change of ["cancel", "replace", "shutdown"] as const) {
      const input = context();
      let stopped = false;
      let resolveApps!: (apps: RoutineReportPublicationContext["apps"]) => void;
      const reportAppsForBot = vi.fn(() => new Promise<RoutineReportPublicationContext["apps"]>((resolve) => { resolveApps = resolve; }));
      const current: RoutineReportTurnContext = {
        routines: { runForThread: () => input.run ? { ...input.run } : null, listRoutines: () => [{ ...input.routine! }] },
        botForId: () => input.bot ? { ...input.bot } : null, reportAppsForBot,
        localEnabled: () => true, writeAllowed: () => true, stopped: () => stopped,
      };
      const startTurn = vi.fn(async (_prompt: string) => {});
      const pending = dispatchRoutineReportTurn(original, "producer", "run-thread", current, startTurn);
      expect(reportAppsForBot, change).toHaveBeenCalledExactlyOnceWith("producer");
      if (change === "cancel") input.run!.status = "cancelled";
      if (change === "replace") input.run!.id = "run-2";
      if (change === "shutdown") stopped = true;
      resolveApps(input.apps);
      await pending;
      expect(startTurn, change).not.toHaveBeenCalled();
    }
  });

  it("rechecks the current run, routine, bot and write fence after the lookup", async () => {
    for (const change of ["run-fence", "routine-fence", "scope-revoked", "write-fence"] as const) {
      const input = context();
      let writeAllowed = true;
      let resolveApps!: (apps: RoutineReportPublicationContext["apps"]) => void;
      const reportAppsForBot = vi.fn(() => new Promise<RoutineReportPublicationContext["apps"]>((resolve) => { resolveApps = resolve; }));
      const current: RoutineReportTurnContext = {
        routines: { runForThread: () => input.run ? { ...input.run } : null, listRoutines: () => [{ ...input.routine! }] },
        botForId: () => input.bot ? { ...input.bot } : null, reportAppsForBot,
        localEnabled: () => true, writeAllowed: () => writeAllowed, stopped: () => false,
      };
      const pending = routineReportTurnPrompt(original, "producer", "run-thread", current);
      expect(reportAppsForBot, change).toHaveBeenCalledOnce();
      if (change === "run-fence") input.run!.access = "read-and-draft";
      if (change === "routine-fence") input.routine!.access = "read-and-draft";
      if (change === "scope-revoked") input.bot!.toolScope = { deny: ["mcp:agents:mini_app_report"] };
      if (change === "write-fence") writeAllowed = false;
      resolveApps(input.apps);
      expect(await pending, change).toBe(original);
    }
  });
});
