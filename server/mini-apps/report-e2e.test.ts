import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import type { MiniAppMutationResult } from "../../shared/mini-apps.ts";
import type { MiniAppNamedPage } from "../../shared/mini-app-data.ts";
import type { ReportSourceResult } from "../../shared/report-mini-app.ts";
import { runControlOmb } from "../../scripts/control-omb.ts";
import { callTool } from "../drivers/agents-call.ts";
import { createHarnessClient } from "../drivers/agents-client.ts";
import { launchMiniAppsFixture } from "../testing/mini-apps-fixture.ts";

const chinaDay = (timestamp: number) => new Date(timestamp + 8 * 60 * 60_000).toISOString().slice(0, 10);
const records = (page: MiniAppNamedPage) => page.rows.map((row) => Object.fromEntries(page.columns.map((column, index) => [column.name, row[index]])));
const xEdition = { reportSummary: "Synthetic selected X updates.", windowStartAt: "2026-11-04T00:00:00Z",
  windowEndAt: "2026-11-05T00:00:00Z", sourceAsOfAt: null, coverageStatus: "partial",
  coverageNote: "Selected public items; no archive or cross-day trend.", items: [{ category: "AI", title: "Synthetic model update",
    summary: "One selected source item.", whyItMatters: null, verificationNote: null, sourceLabel: "Example News",
    sourceUrl: "https://example.com/ai-update", sourcePublishedAt: null, attribution: "vendor" }] };
const githubEdition = { reportSummary: null, windowStartAt: null, windowEndAt: null, sourceAsOfAt: null,
  coverageStatus: "unknown", coverageNote: "Selected repositories, no verified local archive or cross-period trend.",
  items: [{ category: "Tools", title: "Synthetic repository", summary: "A selected open-source project.",
    sourceLabel: "GitHub", sourceUrl: "https://github.com/example/project", sourcePublishedAt: null,
    attribution: "curated", repoFullName: "example/project", repoStars: 100, weeklyStarIncrease: 12,
    signalSourceUrl: "https://github.com/trending?since=weekly", publicAdvisoryCount: 0,
    publicAdvisoryAsOfAt: "2026-11-05T00:00:00Z", selectionBasis: "GitHub Trending weekly selection" }] };

it("installs empty reports for one producer and keeps real Automation publications ordered and durable", async () => {
  const fixture = await launchMiniAppsFixture({ scripted: true });
  const { api, url, dataDir } = fixture;
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Report producer", "--url", url]) as {
      bot: { id: string; activeTaskId: string };
    };
    const routine = async (name: string) => (await api<{ routine: { id: string } }>("POST", "/api/routines", {
      name, prompt: `Publish the ${name} edition and keep the normal reply.`, botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86_400_000 },
    }, 201)).routine;
    const x = await routine("Daily X report"), github = await routine("GitHub report");
    await api("POST", "/api/mini-apps/report-source", { kind: "x_ai_digest", routineId: x.id }, 409);
    await api("PATCH", `/api/routines/${x.id}`, { enabled: true });
    await api("PATCH", `/api/routines/${github.id}`, { enabled: true });
    await api("POST", "/api/mini-apps/report-source", { kind: "x_ai_digest", routineId: x.id, botId: "forged" }, 400);
    const sourceX = await api<ReportSourceResult>("POST", "/api/mini-apps/report-source", { kind: "x_ai_digest", routineId: x.id });
    const sourceGithub = await api<ReportSourceResult>("POST", "/api/mini-apps/report-source", { kind: "github_activity", routineId: github.id });
    expect(sourceX).toMatchObject({ kind: "x_ai_digest", slug: "x-ai-digest", routineId: x.id, producerBotId: bot.id,
      nominalEditionKey: null, publication: { slug: "x-ai-digest", expectedRevision: 0 } });
    expect(sourceGithub.dataset.datasetId).toBe(sourceX.dataset.datasetId);
    expect(sourceX.publication.html).toContain("window.mausApp");
    const installedX = await api<MiniAppMutationResult>("POST", "/api/mini-apps",
      { ...sourceX.publication, publisherBotIds: [sourceX.producerBotId] }, 201);
    const installedGithub = await api<MiniAppMutationResult>("POST", "/api/mini-apps",
      { ...sourceGithub.publication, publisherBotIds: [sourceGithub.producerBotId] }, 201);
    const query = (id: string, queryId: string, parameters: Record<string, string> = {}) =>
      api<MiniAppNamedPage>("POST", `/api/mini-apps/${id}/query`, { queryId, parameters, expectedRevision: 1 });
    expect((await query(installedX.app.id, "current")).rows).toEqual([]);
    expect((await query(installedGithub.app.id, "history")).rows).toEqual([]);

    const planPath = join(dataDir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { script: [
      { key: "x-run", match: ["Routine \"Daily X report\""], repeat: true,
        steps: [{ tool: "mini_app_report", arguments: { action: "publish", kind: "x_ai_digest", edition: xEdition } }],
        reply: "Published the X report and kept this routine's normal reply." },
      { key: "github-run", match: ["Routine \"GitHub report\""], repeat: true,
        steps: [{ tool: "mini_app_report", arguments: { action: "publish", kind: "github_activity", edition: githubEdition } }],
        reply: "Published the GitHub report and kept this routine's normal reply." },
    ] } }));
    const runNow = async (id: string) => (await api<{ run: { id: string; scheduledFor: number } }>("POST", `/api/routines/${id}/run`, undefined, 201)).run;
    const settled = async (id: string) => {
      await expect.poll(async () => (await api<{ runs: Array<{ id: string; status: string }> }>("GET", "/api/routines"))
        .runs.find((entry) => entry.id === id)?.status, { timeout: 60_000, interval: 100 }).toMatch(/completed|failed/);
      const state = (await api<{ runs: Array<{ id: string; status: string; report?: { state: string } }> }>("GET", "/api/routines"))
        .runs.find((entry) => entry.id === id);
      expect(state).toMatchObject({ status: "completed", report: { state: "posted" } });
    };
    const first = await runNow(x.id);
    await settled(first.id);
    const day = chinaDay(first.scheduledFor);
    expect(records(await query(installedX.app.id, "current"))[0]).toMatchObject({ editionKey: day,
      reportSummary: "Synthetic selected X updates.", coverageStatus: "partial", sourceAsOfAt: null });
    const beforeRetry = (await api<{ data: Array<{ revision: number }> }>("GET", `/api/mini-apps/${installedX.app.id}/state`)).data[0]!.revision;
    const retry = await runNow(x.id);
    await settled(retry.id);
    expect(chinaDay(retry.scheduledFor)).toBe(day);
    expect((await api<{ data: Array<{ revision: number }> }>("GET", `/api/mini-apps/${installedX.app.id}/state`)).data[0]!.revision).toBe(beforeRetry);
    const githubRun = await runNow(github.id);
    await settled(githubRun.id);
    expect(records(await query(installedGithub.app.id, "current"))[0]).toMatchObject({ editionKey: chinaDay(githubRun.scheduledFor),
      coverageStatus: "unknown", reportSummary: null });

    const tool = async (args: Record<string, unknown>) => {
      const current = await fixture.mint("agents", bot.id, bot.activeTaskId);
      return callTool("mini_app_report", args, { botId: bot.id, threadId: bot.activeTaskId, depth: 0,
        externalRuntime: false, sharedComputers: false, client: createHarnessClient(url, current.token) });
    };
    const repeated = await tool({ action: "publish", kind: "x_ai_digest", edition: { ...xEdition, editionKey: day } });
    expect(repeated.isError, repeated.text).not.toBe(true);
    expect(JSON.parse(repeated.text)).toMatchObject({ editionKey: day, replayed: true });
    const conflict = await tool({ action: "publish", kind: "x_ai_digest", edition: { ...xEdition, editionKey: day, reportSummary: "Changed" } });
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toContain("different content");
    const earlier = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const backfill = await tool({ action: "publish", kind: "x_ai_digest", edition: { ...xEdition, editionKey: earlier } });
    expect(backfill.isError).not.toBe(true);
    expect(records(await query(installedX.app.id, "history")).map((row) => row.editionKey)).toEqual([day, earlier]);
    expect(records(await query(installedX.app.id, "current"))[0]?.editionKey).toBe(day);

    const token = (await fixture.mint("agents", bot.id, bot.activeTaskId)).token;
    await api("PATCH", `/api/bots/${bot.id}`, { toolScope: { deny: ["mcp:agents:mini_app_report"] } });
    await api("POST", "/api/internal/mini-apps/report", { action: "publish", kind: "x_ai_digest",
      edition: { ...xEdition, editionKey: day } }, 403, { authorization: `Bearer ${token}` });
    await api("PATCH", `/api/bots/${bot.id}`, { toolScope: null });
    const lines = (await api<{ messages: Array<{ text?: string }> }>("GET", `/api/threads/${bot.activeTaskId}/messages?limit=200`)).messages;
    expect(JSON.stringify(lines)).toContain("normal reply");
    await fixture.restart();
    await api("POST", "/api/internal/mini-apps/report", { action: "prepare", kind: "x_ai_digest" }, 401,
      { authorization: `Bearer ${token}` });
    expect(records(await query(installedX.app.id, "history")).map((row) => row.editionKey)).toEqual([day, earlier]);
    expect(records(await query(installedGithub.app.id, "current"))[0]?.editionKey).toBe(chinaDay(githubRun.scheduledFor));
    const evidence = readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { planKey?: string; evidence?: unknown[] });
    expect(evidence.filter((entry) => entry.planKey === "x-run")).toHaveLength(2);
    expect(evidence.filter((entry) => entry.planKey === "github-run")).toHaveLength(1);
  } finally {
    console.info(JSON.stringify({ logPath: fixture.logPath }));
    await fixture.close();
  }
}, 180_000);
