import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { canonicalJson, parsePackageDocument } from "../../shared/package-format.ts";
import { runControlOmb } from "../control-omb.ts";
import { request } from "../mcp-server.ts";
import { agentBrowser, sessionEnv, UI_TOOLS_DIR, type UiHandle } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURES = join(ROOT, "shared", "package-fixtures");
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const forced = process.env.OMB_UI_E2E === "1";
const enabled = forced || Boolean(binary);
const launchTimeout = forced && !binary ? 600_000 : 180_000;
if (!enabled) console.log("skipping org-library UI e2e: set OMB_UI_E2E=1 to install the pinned browser");

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ORG = "11111111-1111-4111-8111-111111111111";
const TEAM_ID = "22222222-2222-4222-8222-222222222222";
const LIBRARY_ID = "44444444-4444-4444-8444-444444444444";

/** A release as Admin serves it: parsed as a file, stamped, canonical bytes. */
function release(name: string) {
  const document: any = parsePackageDocument(JSON.parse(readFileSync(join(FIXTURES, name), "utf8")), { trust: "file" });
  document.package.publisher = { organization: "acme", name: "Acme Partners" };
  const bytes = canonicalJson(document);
  const pkg = document.package;
  return {
    bytes,
    sha256: sha(bytes),
    entry: (packageId: string) => ({
      packageId, ref: `acme/${pkg.id}`, name: pkg.name, tagline: pkg.tagline, kind: pkg.agents.length ? "team" : "library",
      publisher: { organizationId: "33333333-3333-4333-8333-333333333333", name: "Acme Partners", self: false },
      mode: pkg.agents.length ? "required" : "available", offAction: "keep",
      release: { version: pkg.release, sha256: sha(bytes), sizeBytes: Buffer.byteLength(bytes), formatVersion: 2, publishedAt: 1_700_000_000_000, notes: "" },
      withdrawnReleases: [],
      contents: { bots: pkg.agents.length, skills: pkg.skills?.entries.length ?? 0, presets: pkg.presets?.length ?? 0, rooms: pkg.rooms?.length ?? 0,
        routines: pkg.routines?.length ?? 0, connections: pkg.connections?.length ?? 0, botNames: pkg.agents.map((agent: any) => agent.name) },
      scanFindings: 0,
    }),
  };
}

describe("the organization library in the real renderer", () => {
  let child: ChildProcess | undefined;
  afterAll(async () => { await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }); });

  (enabled ? it : it.skip)("has no shelf without an organization, then adds a team and a skill with one click each", async () => {
    const key = randomBytes(32).toString("hex");
    let stdout = "";
    let stderr = "";
    let info: { ui: string; url: string; botId: string; dataDir: string; logPath: string };
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-omb.ts"), "ui", "launch", "--simple"], {
      cwd: ROOT, env: { ...process.env, OMB_TEST_ORG_LIBRARY_KEY: key }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", (error) => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info.ui); } catch { return false; }
    }, { timeout: launchTimeout, interval: 250 }).toBe(true);
    const browser = JSON.parse(readFileSync(info.ui, "utf8")) as UiHandle;
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const click = (name: string) => ui("click", "--name", name);
    const press = (keys: string) => ui("press", "--keys", keys);
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const api = (path: string, method = "GET", body?: unknown) => request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, info.url);
    const evidence = (name: string) => ui("screenshot", "--out", join(ROOT, ".omb-scratch", "verify-evidence", name));

    await click("New or share");
    await click("Templates");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Community templates");
    expect(await snapshot()).not.toContain("From Customer Co");
    await press("Escape");

    // Relay a catalog the way Electron does, with the files where it keeps them.
    const team = release("full-team.v2.json");
    const skills = release("library-only.v2.json");
    const blobs = join(info!.dataDir, "org-library", "blobs");
    mkdirSync(blobs, { recursive: true });
    for (const rel of [team, skills]) writeFileSync(join(blobs, `${rel.sha256}.json`), rel.bytes, { mode: 0o600 });
    const catalog = JSON.stringify({ format: "openmaus.org-library", version: 1, libraryVersion: 1, organization: { id: ORG, name: "Customer Co" },
      packages: [team.entry(TEAM_ID), skills.entry(LIBRARY_ID)] });
    const relayed = await fetch(`${info!.url}/api/testing/org-library`, {
      method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-org-library": key },
      body: JSON.stringify({ library: { adminOrigin: "https://admin.example.com", organizationId: ORG, organizationName: "Customer Co", digest: sha(catalog), catalog } }),
    });
    expect(relayed.status).toBe(200);

    await click("New or share");
    await click("Templates");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Packages Customer Co shares with you");
    let shelf = await snapshot();
    for (const line of ["From Customer Co", "Sales desk", "Recommended by Acme Partners", "Sales skills", "From Acme Partners"]) expect(shelf).toContain(line);
    await evidence("org-library-shelf.png");

    await click("Details of Sales desk");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Included skills (switched on)");
    expect(await snapshot()).toContain("Skills arrive switched on and routines paused");
    await evidence("org-library-preview.png");
    await click("Back to templates");

    await expect.poll(snapshot, { timeout: 10_000 }).toContain('button "Add Sales desk"');
    const beforeAddRead = await ui("snapshot");
    const beforeAdd = beforeAddRead.snapshot as string;
    expect(beforeAdd).toContain('dialog "Templates"');
    expect(beforeAdd).not.toContain('button "Back to templates"');
    await ui("eval", "--js", `(() => {
      const original = window.fetch.bind(window);
      window.__orgLibraryAdd = null;
      window.fetch = async (...args) => {
        const url = typeof args[0] === 'string' ? args[0] : args[0].url;
        if (new URL(url, location.href).pathname !== '/api/org-library/add') return original(...args);
        try {
          const response = await original(...args);
          const result = { status: response.status, body: 'pending' };
          window.__orgLibraryAdd = result;
          const timer = setTimeout(() => { result.body = 'timeout'; }, 2_000);
          void response.clone().json().then((body) => {
            if (result.body !== 'pending') return;
            clearTimeout(timer);
            Object.assign(result, { body: 'ready', code: body.code ?? null, installId: body.installId ?? null,
              section: body.section ?? null, botIds: body.bots?.map((bot) => bot.id) ?? null, botCount: body.bots?.length ?? null });
          }, () => { clearTimeout(timer); result.body = 'unavailable'; });
          return response;
        } catch (error) {
          window.__orgLibraryAdd = { error: String(error) };
          throw error;
        }
      };
      return true;
    })()`);
    let addClick: Record<string, unknown> | null = null;
    let afterAdd = "";
    try {
      addClick = await click("Add Sales desk");
      await expect.poll(async () => (afterAdd = await snapshot()), { timeout: 20_000 }).toContain('button "Sales desk"');
    } catch (error) {
      const [pageResult, listing, imported] = await Promise.allSettled([
        agentBrowser(browser.binary, sessionEnv(browser), ["eval", "({ href: location.href, dialog: document.querySelector('[role=dialog]')?.getAttribute('aria-labelledby') ?? null, addButton: [...document.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === 'Add Sales desk'), add: window.__orgLibraryAdd ?? null })"], 2_000).then((value) => value.result).catch(() => null),
        request("/api/org-library", { signal: AbortSignal.timeout(2_000) }, info.url).then((value) => value.packages.map((entry: { name: string; installed: unknown }) => ({ name: entry.name, installed: Boolean(entry.installed) }))),
        request("/api/bots", { signal: AbortSignal.timeout(2_000) }, info.url).then((value) => value.bots.filter((bot: { section?: string }) => bot.section === "Sales desk").map((bot: { id: string }) => bot.id)),
      ]);
      const lines = (text: string) => text.split("\n").filter((line) => /dialog "Templates"|button "Back to templates"|button "Add Sales desk"|button "Sales desk"|alert/.test(line));
      console.error("Organization library Add phase:", JSON.stringify({ beforeOrigin: beforeAddRead.origin, before: lines(beforeAdd), click: addClick && { target: addClick.target, clicked: addClick.clicked },
        after: lines(afterAdd), page: pageResult.status === "fulfilled" ? pageResult.value : null,
        packages: listing.status === "fulfilled" ? listing.value : null, botIds: imported.status === "fulfilled" ? imported.value : null }));
      throw error;
    }
    const bots = (await api("/api/bots")).bots.filter((bot: { section?: string }) => bot.section === "Sales desk");
    expect(bots).toHaveLength(3);
    for (const bot of bots) {
      const listed = (await api(`/api/bots/${bot.id}/skills`)).skills as Array<{ enabled: boolean }>;
      expect(listed.every((skill) => skill.enabled)).toBe(true);
    }
    expect((await api("/api/routines")).routines.every((routine: { enabled: boolean }) => !routine.enabled)).toBe(true);

    await click("New or share");
    await click("Templates");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Packages Customer Co shares with you");
    shelf = await snapshot();
    expect(shelf).toContain("Added");
    expect(shelf).not.toContain("Add Sales desk");
    await click("Add Sales skills");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Sales skills is added. Its skills are offered under each bot's Skills.");
    await evidence("org-library-added.png");
    await press("Escape");

    const state = await ui("snapshot", "--interactive");
    const profile = Object.entries(state.refs as Record<string, { role: string; name: string }>)
      .find(([, entry]) => entry.role === "button" && /Open .+ profile/.test(entry.name));
    expect(profile).toBeDefined();
    await ui("click", "--ref", `@${profile![0]}`);
    // The bot's panel: where it came from on Bot settings, the organization's skills on Library → Skills.
    await click("Bot settings");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("From Sales desk 1.3.0 · Acme Partners");
    let detailsClick: Record<string, unknown> | null = null;
    let libraryClick: Record<string, unknown> | null = null;
    let afterDetails: Record<string, unknown> | null = null;
    let afterLibrary: Record<string, unknown> | null = null;
    let settled: Record<string, unknown> | null = null;
    let cleanupError: unknown = null;
    const navigationRead = () => agentBrowser(browser.binary, sessionEnv(browser),
      ["eval", "window.__orgLibraryNavigation.snapshot()"], 2_000).then((value) => value.result as Record<string, unknown>);
    try {
      await agentBrowser(browser.binary, sessionEnv(browser), ["eval", `(() => {
        const current = () => ({
          selected: document.querySelector('[data-panel-tab][aria-selected="true"]')?.getAttribute('data-panel-tab') ?? null,
          page: document.querySelector('[data-panel-page-view]')?.getAttribute('data-panel-page-view') ?? null,
          skillsRow: Boolean(document.querySelector('[data-panel-page="skills"]')),
        });
        const transitions = [{ at: performance.now(), ...current() }];
        const deliveries = [];
        const mutations = [];
        let last = JSON.stringify(current());
        const record = () => {
          const state = current();
          const next = JSON.stringify(state);
          if (next !== last && transitions.length < 20) transitions.push({ at: performance.now(), ...state });
          last = next;
        };
        const click = (phase) => (event) => {
          const element = event.target instanceof Element ? event.target : null;
          const target = element?.closest('[data-panel-tab]');
          if (deliveries.length < 12) deliveries.push({ at: performance.now(), phase,
            targetTag: element?.tagName.toLowerCase() ?? null, targetRole: element?.getAttribute('role') ?? null,
            tab: target?.getAttribute('data-panel-tab') ?? null, inDialog: Boolean(element?.closest('[role="dialog"]')),
            trusted: event.isTrusted, defaultPrevented: event.defaultPrevented });
          queueMicrotask(record);
        };
        const capture = click('capture');
        const bubble = click('bubble');
        document.addEventListener('click', capture, true);
        document.addEventListener('click', bubble);
        const observer = new MutationObserver((changes) => {
          for (const change of changes) if (change.type === 'attributes' && mutations.length < 16) {
            mutations.push({ at: performance.now(), tab: change.target.getAttribute('data-panel-tab'),
              before: change.oldValue, after: change.target.getAttribute('aria-selected') });
          }
          record();
        });
        observer.observe(document.body, { attributes: true, attributeFilter: ['aria-selected'], attributeOldValue: true,
          childList: true, subtree: true });
        window.__orgLibraryNavigation = {
          snapshot: () => ({ current: current(), transitions, deliveries, mutations }),
          stop: () => { observer.disconnect(); document.removeEventListener('click', capture, true);
            document.removeEventListener('click', bubble); delete window.__orgLibraryNavigation; },
        };
        return true;
      })()`], 2_000);
      detailsClick = await click("Details");
      afterDetails = await navigationRead();
      libraryClick = await click("Library");
      afterLibrary = await navigationRead();
      await expect.poll(async () => {
        settled = await navigationRead();
        const current = settled.current as { selected: string | null; skillsRow: boolean };
        return current.selected === "library" && current.skillsRow;
      }, { timeout: 10_000 }).toBe(true);
      await ui("eval", "--js", "document.querySelector('[data-panel-page=\"skills\"]').click(); true");
    } catch (error) {
      const page = await agentBrowser(browser.binary, sessionEnv(browser), ["eval", `(() => {
          const library = document.querySelector('[data-panel-tab="library"]');
          return {
            href: location.href,
            dialogs: [...document.querySelectorAll('[role="dialog"]')].map((node) => node.getAttribute('aria-label') ?? node.getAttribute('aria-labelledby')),
            tabs: [...document.querySelectorAll('[role="tab"]')].map((node) => ({ name: node.textContent?.trim(), selected: node.getAttribute('aria-selected') })),
            back: [...document.querySelectorAll('button')].filter((node) => /Back/.test(node.textContent ?? '')).map((node) => node.textContent?.trim()),
            panelPages: [...document.querySelectorAll('[data-panel-page-view]')].map((node) => node.getAttribute('data-panel-page-view')),
            libraryTab: library ? { selected: library.getAttribute('aria-selected'), visible: library.getClientRects().length > 0 } : null,
            skillsRow: Boolean(document.querySelector('[data-panel-page="skills"]')),
            navigation: window.__orgLibraryNavigation?.snapshot() ?? null,
          };
        })()`], 2_000).then((value) => value.result).catch(() => null);
      console.error("Organization library Skills phase:", JSON.stringify({
        detailsClick: detailsClick && { target: detailsClick.target, clicked: detailsClick.clicked, name: detailsClick.name, referenceRole: detailsClick.referenceRole },
        libraryClick: libraryClick && { target: libraryClick.target, clicked: libraryClick.clicked, name: libraryClick.name, referenceRole: libraryClick.referenceRole },
        afterDetails, afterLibrary, settled, page,
      }));
      throw error;
    } finally {
      try {
        await agentBrowser(browser.binary, sessionEnv(browser),
          ["eval", "window.__orgLibraryNavigation?.stop(); true"], 2_000);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) throw cleanupError;
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Skills your organization shares");
    await evidence("org-library-bot-skills.png");
    await click("Add follow-up to this bot");
    const selected = bots.find((bot: { name: string }) => profile![1].name.includes(bot.name));
    await expect.poll(async () => ((await api(`/api/bots/${selected.id}/skills`)).skills as Array<{ name: string; enabled: boolean }>)
      .find((skill) => skill.name === "follow-up")?.enabled, { timeout: 10_000 }).toBe(true);
    process.stdout.write(`${JSON.stringify({ fixture: info!, addedSection: "Sales desk", offeredSkill: "follow-up" })}\n`);
  }, launchTimeout + 120_000);
});
