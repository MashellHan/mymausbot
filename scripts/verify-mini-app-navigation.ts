import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { mountPreview } from "./testing/preview-fixture.ts";
import { launchMiniAppsFixture } from "../server/testing/mini-apps-fixture.ts";
import { createBookkeepingPublish, suggestedBookkeepingColumns } from "../shared/bookkeeping-mini-app.ts";
import type { MiniAppMutationResult } from "../shared/mini-apps.ts";
import type { ReportSourceResult } from "../shared/report-mini-app.ts";

assert.deepEqual(process.argv.slice(2), ["--check"]);
const root = fileURLToPath(new URL("..", import.meta.url));
const evidence = process.env.OMB_MINI_APP_NAV_EVIDENCE ?? join(root, ".impeccable", "review", "mini-app-navigation");
mkdirSync(evidence, { recursive: true });
const previewOptions = (url: string, bot: { id: string; activeTaskId: string }, route: string) =>
  mountPreview({ info: { url } }, { entry: "/scripts/testing/mini-apps-preview.tsx", route,
    title: "Synthetic Mini Apps navigation", logLevel: "warn",
    extraRoutes: [{ path: "/__mini-app-fixture", handler: (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: bot.id, threadId: bot.activeTaskId }));
    } }],
  });

async function capture(mode: "empty" | "installed", dataDir: string, previewUrl: string) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const log = join(evidence, `${mode}-smoke.log`);
  const child = spawn(electron as unknown as string,
    [join(root, "scripts/testing/mini-app-navigation-ui-smoke.mjs"), mode, dataDir, previewUrl, evidence],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", (part) => { output += String(part); });
  child.stderr!.on("data", (part) => { output += String(part); });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 180_000);
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status) => resolve(status ?? 1));
  });
  clearTimeout(timeout);
  writeFileSync(log, output);
  assert.equal(code, 0, `${mode} renderer smoke failed: ${output.slice(-3000)}`);
  return JSON.parse(readFileSync(join(evidence, `${mode}-result.json`), "utf8"));
}

const empty = await launchVerificationServer();
let emptyPreview: Awaited<ReturnType<typeof mountPreview>> | undefined;
try {
  const { bot } = await runControlOmb(["new-bot", "--name", "Synthetic Mini Apps", "--url", empty.info.url]) as {
    bot: { id: string; activeTaskId: string };
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(empty.info.url + path, { method, headers: { "content-type": "application/json", origin: empty.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  await api("POST", "/api/routines", { name: "Synthetic report producer", prompt: "Publish only synthetic report data.",
    botId: bot.id, enabled: true, schedule: { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86_400_000 } });
  assert.deepEqual((await api("GET", "/api/mini-apps")).apps, []);
  emptyPreview = await previewOptions(empty.info.url, bot, "/__mini-app-nav-empty.html");
  await capture("empty", empty.info.dataDir, emptyPreview.previewUrl);
} finally {
  await emptyPreview?.close();
  await empty.close();
}

const full = await launchMiniAppsFixture();
let fullPreview: Awaited<ReturnType<typeof mountPreview>> | undefined;
try {
  const { api, bot, dataset, installed } = full;
  await api("POST", `/api/mini-apps/${installed.app.id}/archive`, { requestKey: "hide-fixture-template", expectedRevision: installed.app.revision });
  const table = dataset.tables.find((candidate) => candidate.name === "ledger_master")!;
  const bookkeeping = createBookkeepingPublish({ dataset, table, columns: suggestedBookkeepingColumns(table),
    html: readFileSync(join(root, "examples/mini-apps/bookkeeping/index.html"), "utf8"),
    requestKey: "nav-bookkeeping", title: "Bookkeeping" });
  await api<MiniAppMutationResult>("POST", "/api/mini-apps", { ...bookkeeping, shippedTemplateKind: "bookkeeping" }, 201);
  const routine = (await api<{ routine: { id: string } }>("POST", "/api/routines", {
    name: "Synthetic report producer", prompt: "Publish only synthetic report data.", botId: bot.id, enabled: true,
    schedule: { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86_400_000 },
  }, 201)).routine;
  for (const kind of ["x_ai_digest", "github_activity"] as const) {
    const source = await api<ReportSourceResult>("POST", "/api/mini-apps/report-source", { kind, routineId: routine.id });
    await api<MiniAppMutationResult>("POST", "/api/mini-apps",
      { ...source.publication, publisherBotIds: [source.producerBotId], shippedTemplateKind: kind }, 201);
  }
  for (const kind of ["agent-team", "usage"] as const) {
    await api<MiniAppMutationResult>("POST", "/api/mini-apps", {
      requestKey: `nav-${kind}`, expectedRevision: 0, slug: kind,
      title: kind === "usage" ? "Usage" : "Agent Team", description: `Synthetic ${kind} preview`,
      html: "<!doctype html><title>Desktop view</title>", bindings: [], publisherBotIds: [], dashboardKind: kind,
    }, 201);
  }
  const inventory = await api<{ apps: Array<{ slug: string; status: string }> }>("GET", "/api/mini-apps");
  assert.deepEqual(inventory.apps.filter((app) => app.status === "active").map((app) => app.slug).sort(),
    ["agent-team", "bookkeeping", "github-activity", "usage", "x-ai-digest"]);
  fullPreview = await previewOptions(full.url, bot, "/__mini-app-nav-installed.html");
  await capture("installed", full.dataDir, fullPreview.previewUrl);
} finally {
  await fullPreview?.close();
  await full.close();
}
console.log(JSON.stringify({ passed: true, evidence, phases: ["empty", "installed"] }));
