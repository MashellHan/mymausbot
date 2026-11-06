import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../../scripts/control-omb.ts";
import { createBookkeepingPublish, suggestedBookkeepingColumns } from "../../shared/bookkeeping-mini-app.ts";
import type { MiniAppDataset, MiniAppDefaultsResult, MiniAppDocument, MiniAppMutationResult } from "../../shared/mini-apps.ts";
import { waitForExit } from "./cleanup.ts";

const CAPABILITY_KEY = "isolated-mini-apps-fixture-capability";
export const SYNTHETIC_LEDGER_SQL = `CREATE TABLE ledger_master AS SELECT * FROM (VALUES
  ('Food', '2026-04-01', '-12.34', 'Card', 'Daily', 'CNY', 'Lunch'),
  ('Food', '2026-04-02', '-0.10', 'Card', 'Daily', 'CNY', 'Tea'),
  ('Food', '2026-04-02', '-0.10', 'Card', 'Daily', 'CNY', 'Tea'),
  ('Transfer', '2026-04-03', '25.00', 'Card', 'Daily', 'CNY', 'Inflow'),
  ('Travel', '2026-04-04', '-8.50', 'Card', 'Daily', 'USD', 'Ticket'),
  ('Unknown', '2026-04-04', '-1.00', 'Unprovided', 'Daily', NULL, 'Missing currency'),
  ('Unknown', '2026-04-04', '-2.00', 'Unprovided', 'Daily', '', 'Blank currency'),
  ('Unknown', 'bad-date', '-3.00', 'Card', 'Daily', 'CNY', 'Undated'),
  ('Unknown', '2026-04-04', 'bad-amount', 'Card', 'Daily', 'CNY', 'Invalid amount'),
  ('Unknown', '2026-04-04', '1.005', 'Card', 'Daily', 'CNY', 'Unrepresentable amount')
) AS records("分类", "时间", "金额", "账户", "账本", "货币", "备注")`;

export async function launchMiniAppsFixture({ scripted = false, defaultApps = false }: { scripted?: boolean; defaultApps?: boolean } = {}) {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined,
    scripted ? { scripted: true } : undefined);
  let server: ChildProcess | undefined;
  const { url, dataDir, logPath } = fixture.info;
  const api = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown, expected = 200, headers: Record<string, string> = {}): Promise<T> => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
    const text = await response.text();
    if (response.status !== expected) throw new Error(`${method} ${path}: expected ${expected}, got ${response.status}: ${text.slice(0, 1000)}`);
    return text ? JSON.parse(text) as T : {} as T;
  };
  const restart = async () => {
    await waitForExit(server ?? fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    const providerHome = join(dataDir, "providers", "fixture-home");
    mkdirSync(providerHome, { recursive: true });
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), OMB_TEST_INTERNAL_CAPABILITY_KEY: CAPABILITY_KEY,
        HOME: providerHome, USERPROFILE: providerHome, HERMES_HOME: join(providerHome, ".hermes"),
        APPDATA: join(providerHome, "AppData", "Roaming"), LOCALAPPDATA: join(providerHome, "AppData", "Local"),
        XDG_CONFIG_HOME: join(providerHome, ".config"), XDG_DATA_HOME: join(providerHome, ".local", "share"), XDG_CACHE_HOME: join(providerHome, ".cache") },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Mini App fixture exited: ${readFileSync(logPath, "utf8").slice(-5000)}`);
      try {
        const response = await fetch(url + "/api/health", { headers: { origin: url }, signal: AbortSignal.timeout(500) });
        const health = await response.json() as { app?: string; pid?: number };
        if (response.ok && health.app === "openmausbot" && health.pid === server.pid) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Mini App fixture did not start: ${readFileSync(logPath, "utf8").slice(-5000)}`);
  };
  const close = async () => {
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  };
  try {
    await restart();
    const { bot } = await runControlOmb(["new-bot", "--name", "Bookkeeping fixture", "--url", url]) as { bot: { id: string; activeTaskId: string } };
    const mint = (kind: "data" | "agents", botId = bot.id, threadId = bot.activeTaskId) => api<{ token: string }>("POST", "/api/testing/internal-capability", { botId, threadId, kind }, 201, { "x-openmausbot-test-capability": CAPABILITY_KEY });
    const dataCall = async (name: string, args: Record<string, unknown>) => {
      const dataToken = (await mint("data")).token;
      const { result } = await api<{ result: { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: unknown } }>("POST", "/api/internal/data/mcp", { method: "tools/call", params: { name, arguments: args } }, 200, { authorization: `Bearer ${dataToken}` });
      if (result.isError) throw new Error(`Data fixture ${name}: ${JSON.stringify(result)}`);
      return result.structuredContent;
    };
    await dataCall("data_sql", { sql: SYNTHETIC_LEDGER_SQL });
    const html = readFileSync(new URL("../../examples/mini-apps/bookkeeping/index.html", import.meta.url), "utf8");
    const defaults = defaultApps ? await api<MiniAppDefaultsResult>("POST", "/api/mini-apps/defaults", { bookkeepingHtml: html }) : null;
    const { dataset } = await api<{ dataset: MiniAppDataset }>("POST", "/api/mini-apps/sources", { botId: bot.id });
    const table = dataset.tables.find((candidate) => candidate.name === "ledger_master")!;
    const publication = { ...createBookkeepingPublish({ dataset, table, columns: suggestedBookkeepingColumns(table),
      html,
      publisherBotId: bot.id, requestKey: "fixture-install", title: "Bookkeeping", slug: "fixture-bookkeeping" }),
      shippedTemplateKind: "bookkeeping" as const };
    const included = defaults?.apps.find((app) => app.shippedTemplateKind === "bookkeeping");
    const installed = included ? { app: included, replayed: false } : await api<MiniAppMutationResult>("POST", "/api/mini-apps", publication, 201);
    return { ...fixture.info, pid: server!.pid!, bot, dataset, publication, installed, defaults, api, dataCall, mint, close,
      document: () => api<MiniAppDocument>("GET", `/api/mini-apps/${installed.app.id}`),
      restart,
    };
  } catch (error) { await close(); throw error; }
}
