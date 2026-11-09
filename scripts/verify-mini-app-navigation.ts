import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { mountPreview } from "./testing/preview-fixture.ts";
import type { MiniAppSummary } from "../shared/mini-apps.ts";

const metadataOnly = process.argv.includes("--metadata-only");
assert.deepEqual(process.argv.slice(2), metadataOnly ? ["--check", "--metadata-only"] : ["--check"]);
const root = fileURLToPath(new URL("..", import.meta.url));
const evidence = process.env.OMB_MINI_APP_NAV_EVIDENCE ?? join(root, ".impeccable", "review", "mini-app-navigation");
mkdirSync(evidence, { recursive: true });
const fixture = await launchVerificationServer();
let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
try {
  const { bot } = await runControlOmb(["new-bot", "--name", "Synthetic Mini Apps", "--url", fixture.info.url]) as {
    bot: { id: string; activeTaskId: string };
  };
  const inventory = async () => {
    const response = await fetch(fixture.info.url + "/api/mini-apps", { headers: { origin: fixture.info.url } });
    assert.equal(response.status, 200);
    return (await response.json() as { apps: MiniAppSummary[] }).apps;
  };
  assert.deepEqual(await inventory(), []);
  preview = await mountPreview(fixture, { entry: "/scripts/testing/mini-apps-preview.tsx", route: "/__mini-app-launcher.html",
    title: "Synthetic Mini Apps launcher", logLevel: "warn",
    extraRoutes: [{ path: "/__mini-app-fixture", handler: (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: bot.id, threadId: bot.activeTaskId }));
    } }],
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron as unknown as string,
    [join(root, "scripts/testing/mini-app-navigation-ui-smoke.mjs"), fixture.info.dataDir, preview.previewUrl, evidence,
      ...(metadataOnly ? ["--metadata-only"] : [])],
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
  writeFileSync(join(evidence, "launcher-smoke.log"), output);
  assert.equal(code, 0, `Launcher renderer failed: ${output.slice(-3000)}`);
  const result = JSON.parse(readFileSync(join(evidence, "launcher-result.json"), "utf8")) as { errors: string[] };
  assert.deepEqual(result.errors, []);
  const active = (await inventory()).filter((app) => app.status === "active");
  assert.equal(active.length, 5);
  assert.deepEqual(active.map((app) => app.dashboardIdentity ?? app.shippedTemplateKind).sort(),
    ["agent-team", "bookkeeping", "github_activity", "usage", "x_ai_digest"].sort());
  console.log(JSON.stringify({ passed: true, source: "isolated source Electron fixture", evidence, activeApps: active.length }));
} finally {
  await preview?.close();
  await fixture.close();
}
