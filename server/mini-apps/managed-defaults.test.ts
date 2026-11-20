import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { LEGACY_MINI_APP_IDS } from "../../shared/mini-app-release-packages.ts";
import { AppDocs } from "../app-docs.ts";
import type { DataEngine } from "../data/types.ts";
import { NATIVE_DEFAULT_HTML, pendingDefaultHtml } from "./default-documents.ts";
import { DefaultMiniApps } from "./defaults.ts";
import { MiniApps, type MiniAppActor } from "./registry.ts";
import type { ReportStore } from "./report-store.ts";

const owner: MiniAppActor = { writeAllowed: true, assertActive() {}, canBind: () => true };
const docs = (root: string) => new AppDocs(join(root, "docs"));
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "omb-mini-managed-defaults-"));
  try { await run(root); } finally { await rm(root, { force: true, recursive: true }); }
}
const data = {
  async validateBinding() { throw new Error("Unbound stock defaults cannot validate Data bindings."); },
  async readNamed() { throw new Error("Unbound stock defaults cannot read Data."); },
  async listDatasets() { return []; },
  async listBotSources() { return []; },
} as Pick<DataEngine, "validateBinding" | "readNamed" | "listDatasets" | "listBotSources">;

function setup(root: string, database: DatabaseSync, publisherIds: string[] = []) {
  const apps = new MiniApps({ docs: docs(root), data, validPublisher: (id) => publisherIds.includes(id),
    access: { database: () => database, write: (work) => work(database) } });
  apps.list(owner);
  const defaults = new DefaultMiniApps({ apps, data: data as DataEngine, bots: () => publisherIds.map((id) => ({ id })), routines: () => null, reports: {} as ReportStore });
  return { apps, defaults };
}

function seedLegacyMojo(
  database: DatabaseSync,
  root: string,
  options: {
    html?: string;
    revision?: number;
    templateVersion?: number;
    publisherBotIds?: string[];
    shippedTemplateKind?: "mojo" | null;
    status?: "active" | "archived";
    title?: string;
    description?: string;
  } = {},
) {
  const store = docs(root);
  const revision = options.revision ?? 6;
  const templateVersion = options.templateVersion ?? 6;
  const html = options.html ?? "<!doctype html><html><body><h1>Legacy Mojo</h1></body></html>";
  const title = options.title ?? "Mojo";
  const description = options.description ?? "Quotes and poetry.";
  const publisherBotIds = options.publisherBotIds ?? ["legacy-publisher"];
  const stored = store.put({ source: "html", html });
  if (!stored.ok) throw new Error("Failed to store legacy Mojo doc.");
  database.prepare(`INSERT INTO mini_apps (
    id, owner_id, slug, title, description, status, revision, template_version, publishers,
    created_at, updated_at, shipped_template_kind, capabilities
  ) VALUES (?, 'workspace-owner', 'mojo', ?, ?, ?, ?, ?, ?, 1000, 2000, ?, '[]')`).run(
    LEGACY_MINI_APP_IDS.mojo,
    title,
    description,
    options.status ?? "active",
    revision,
    templateVersion,
    JSON.stringify(publisherBotIds),
    options.shippedTemplateKind ?? null,
  );
  for (let version = 1; version <= templateVersion; version++) {
    database.prepare(`INSERT INTO mini_app_versions (
      app_id, version, doc, title, description, bindings, created_at, dashboard_html, release_provenance
    ) VALUES (?, ?, ?, ?, ?, '[]', ?, 0, NULL)`).run(
      LEGACY_MINI_APP_IDS.mojo,
      version,
      stored.doc,
      title,
      description,
      1000 + version,
    );
  }
}

describe("managed Mini App defaults", () => {
  it("installs a fresh Mojo identity and respects archive and explicit restore", async () => {
    await fixture(async (root) => {
      const database = new DatabaseSync(join(root, "apps.db"));
      try {
        const { apps, defaults } = setup(root, database);
        const input = { bookkeepingHtml: "<p>Example ledger</p>" };
        const first = await defaults.ensure(owner, input);
        expect(first.issues).toEqual([]);
        const mojo = first.apps.find((item) => item.shippedTemplateKind === "mojo")!;
        expect(mojo).toMatchObject({ slug: "mojo", title: "Mojo", revision: 1, status: "active", release: null });
        const document = apps.document(owner, mojo.id);
        expect(document).toMatchObject({ html: pendingDefaultHtml("mojo"), bindings: [] });
        expect((await defaults.ensure(owner, input)).apps.find((item) => item.id === mojo.id)).toEqual(mojo);
        const archived = apps.archive(owner, mojo.id, { expectedRevision: mojo.revision, requestKey: "archive-mojo" }).app;
        expect((await defaults.ensure(owner, input)).apps.find((item) => item.id === mojo.id)).toEqual(archived);
        expect((await defaults.ensure(owner, { ...input, restore: "mojo" })).apps.find((item) => item.id === mojo.id))
          .toMatchObject({ id: mojo.id, status: "active", shippedTemplateKind: "mojo" });
      } finally { database.close(); }
    });
  });

  it("widens the existing SQLite identity constraint without changing old app records or versions", async () => {
    await fixture(async (root) => {
      const file = join(root, "apps.db");
      let previousId: string;
      let nativeId: string;
      let detailedId: string;
      const previous = new DatabaseSync(file);
      try {
        const { apps } = setup(root, previous);
        const { app } = await apps.publish(owner, { requestKey: "old", expectedRevision: 0, slug: "bookkeeping",
          title: "My existing ledger", description: "", html: "<h1>Stored HTML</h1>", bindings: [],
          shippedTemplateKind: "bookkeeping" });
        previousId = app.id;
        nativeId = (await apps.publish(owner, { requestKey: "old-native", expectedRevision: 0, slug: "native-team", title: "Native team",
          description: "", html: NATIVE_DEFAULT_HTML, bindings: [], dashboardKind: "agent-team" })).app.id;
        detailedId = (await apps.publish(owner, { requestKey: "old-reviewed", expectedRevision: 0, slug: "reviewed-team", title: "Reviewed team",
          description: "", html: await readFile(new URL("../../examples/mini-apps/agent-team/index.html", import.meta.url), "utf8"),
          bindings: [], dashboardKind: "agent-team" }, undefined, true)).app.id;
        previous.exec(`
          ALTER TABLE mini_apps DROP COLUMN agent_team_detail_grant;
          ALTER TABLE mini_apps RENAME COLUMN shipped_template_kind TO shipped_kind_before_fixture;
          ALTER TABLE mini_apps ADD COLUMN shipped_template_kind TEXT
            CHECK(shipped_template_kind IN ('bookkeeping', 'x_ai_digest', 'github_activity') OR shipped_template_kind IS NULL);
          UPDATE mini_apps SET shipped_template_kind = shipped_kind_before_fixture;
          ALTER TABLE mini_apps DROP COLUMN shipped_kind_before_fixture;
        `);
      } finally { previous.close(); }
      const current = new DatabaseSync(file);
      try {
        const { apps, defaults } = setup(root, current);
        expect(apps.document(owner, previousId!)).toMatchObject({ app: { id: previousId!, templateVersion: 1,
          shippedTemplateKind: "bookkeeping" }, html: "<h1>Stored HTML</h1>", versions: [{ version: 1 }] });
        expect(current.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(apps.document(owner, nativeId!).app.dashboard).toMatchObject({ renderer: "native", resources: ["teams", "activity"] });
        expect(apps.document(owner, detailedId!).app.dashboard).toMatchObject({ renderer: "html",
          resources: ["teams", "activity", "configuration", "team-rules", "skill"] });
        const latest = await defaults.ensure(owner, { bookkeepingHtml: "<p>Example ledger</p>" });
        expect(latest.apps.some((item) => item.shippedTemplateKind === "mojo")).toBe(true);
        expect(latest.apps.find((item) => item.id === previousId)?.revision).toBe(1);
      } finally { current.close(); }
    });
  });

  it("suppresses duplicate Mojo for canonical legacy id regardless of edits and preserves history", async () => {
    await fixture(async (root) => {
      const database = new DatabaseSync(join(root, "apps.db"));
      try {
        const { apps, defaults } = setup(root, database, ["legacy-publisher"]);
        const customHtml = "<!doctype html><html><body><h1>Owner edited Mojo</h1></body></html>";
        seedLegacyMojo(database, root, { html: customHtml, revision: 6, templateVersion: 6, publisherBotIds: ["legacy-publisher"] });
        const result = await defaults.ensure(owner, { bookkeepingHtml: "<p>Example ledger</p>" });
        expect(result.issues).toEqual([]);
        const mojos = result.apps.filter((item) => item.id === LEGACY_MINI_APP_IDS.mojo || item.shippedTemplateKind === "mojo" || item.slug.startsWith("mojo"));
        expect(mojos).toHaveLength(1);
        expect(mojos[0]).toMatchObject({
          id: LEGACY_MINI_APP_IDS.mojo,
          slug: "mojo",
          revision: 6,
          templateVersion: 6,
          publisherBotIds: ["legacy-publisher"],
          shippedTemplateKind: null,
          status: "active",
          release: null,
        });
        expect(apps.document(owner, LEGACY_MINI_APP_IDS.mojo)).toMatchObject({
          html: customHtml,
          bindings: [],
        });
        expect(apps.document(owner, LEGACY_MINI_APP_IDS.mojo).versions).toHaveLength(6);
        expect(await apps.checkUpdate(owner, LEGACY_MINI_APP_IDS.mojo)).toEqual({
          installedVersion: null,
          status: "custom",
          available: null,
        });
      } finally { database.close(); }
    });
  });

  it("retires only a pristine generated suffixed Mojo duplicate alongside canonical Mojo and preserves altered duplicates", async () => {
    await fixture(async (root) => {
      const database = new DatabaseSync(join(root, "apps.db"));
      try {
        const { apps, defaults } = setup(root, database, ["legacy-publisher"]);
        const legacyHtml = "<!doctype html><html><body><h1>Untouched legacy Mojo</h1></body></html>";
        seedLegacyMojo(database, root, { html: legacyHtml, revision: 6, templateVersion: 6, publisherBotIds: ["legacy-publisher"] });
        const duplicate = await apps.publish(owner, {
          requestKey: "dup-mojo-1",
          expectedRevision: 0,
          slug: "mojo-included-1",
          title: "Mojo",
          description: "Quotes and poetry.",
          html: pendingDefaultHtml("mojo"),
          bindings: [],
          publisherBotIds: [],
          shippedTemplateKind: "mojo",
        });

        const repaired = await defaults.ensure(owner, { bookkeepingHtml: "<p>Example ledger</p>" });
        expect(repaired.issues).toEqual([]);
        expect(repaired.apps.find((item) => item.id === LEGACY_MINI_APP_IDS.mojo)).toMatchObject({
          id: LEGACY_MINI_APP_IDS.mojo,
          slug: "mojo",
          status: "active",
          revision: 6,
          templateVersion: 6,
          publisherBotIds: ["legacy-publisher"],
          shippedTemplateKind: null,
        });
        const archivedDup = repaired.apps.find((item) => item.id === duplicate.app.id)!;
        expect(archivedDup).toMatchObject({
          id: duplicate.app.id,
          slug: "mojo-included-1",
          status: "archived",
          revision: 2,
          templateVersion: 1,
          shippedTemplateKind: "mojo",
        });
        expect(apps.document(owner, duplicate.app.id)).toMatchObject({
          html: pendingDefaultHtml("mojo"),
          bindings: [],
          versions: [{ version: 1, title: "Mojo", release: null }],
        });

        // Repeated defaults run stays clean even after canonical Mojo is marked shippedTemplateKind='mojo' or archived+restored
        const second = await defaults.ensure(owner, { bookkeepingHtml: "<p>Example ledger</p>" });
        expect(second.issues).toEqual([]);
        expect(second.apps.find((item) => item.id === duplicate.app.id)).toEqual(archivedDup);

        const archivedCanonical = apps.archive(owner, LEGACY_MINI_APP_IDS.mojo, { requestKey: "archive-canonical", expectedRevision: 6 }).app;
        expect(archivedCanonical.status).toBe("archived");
        const restored = await defaults.ensure(owner, { bookkeepingHtml: "<p>Example ledger</p>", restore: "mojo" });
        expect(restored.issues).toEqual([]);
        expect(restored.apps.find((item) => item.id === LEGACY_MINI_APP_IDS.mojo)).toMatchObject({
          status: "active",
          shippedTemplateKind: "mojo",
        });
        expect(restored.apps.find((item) => item.id === duplicate.app.id)?.status).toBe("archived");
        expect((await defaults.ensure(owner, { bookkeepingHtml: "<p>Example ledger</p>" })).issues).toEqual([]);
      } finally { database.close(); }
    });

    // Altered or independently created extra Mojo copies are preserved untouched without a false conflict error,
    // even when a separate pristine placeholder is archived in the same pass
    await fixture(async (root) => {
      const database = new DatabaseSync(join(root, "apps.db"));
      try {
        const { apps, defaults } = setup(root, database, ["legacy-publisher"]);
        seedLegacyMojo(database, root, { revision: 6, templateVersion: 6, publisherBotIds: ["legacy-publisher"] });
        const pristine = await apps.publish(owner, {
          requestKey: "pristine-mojo-dup",
          expectedRevision: 0,
          slug: "mojo-included-1",
          title: "Mojo",
          description: "Quotes and poetry.",
          html: pendingDefaultHtml("mojo"),
          bindings: [],
          publisherBotIds: [],
          shippedTemplateKind: "mojo",
        });
        const altered = await apps.publish(owner, {
          requestKey: "altered-mojo-dup",
          expectedRevision: 0,
          slug: "mojo-included-2",
          title: "Mojo",
          description: "Quotes and poetry.",
          html: "<!doctype html><html><body><h1>User edited copy</h1></body></html>",
          bindings: [],
          publisherBotIds: [],
          shippedTemplateKind: "mojo",
        });

        const result = await defaults.ensure(owner, { bookkeepingHtml: "<p>Example ledger</p>" });
        expect(result.issues).toEqual([]);
        expect(result.apps.find((item) => item.id === pristine.app.id)).toMatchObject({
          id: pristine.app.id,
          status: "archived",
          revision: 2,
          templateVersion: 1,
        });
        expect(result.apps.find((item) => item.id === altered.app.id)).toMatchObject({
          id: altered.app.id,
          status: "active",
          revision: 1,
          templateVersion: 1,
        });
        expect(result.apps.find((item) => item.id === LEGACY_MINI_APP_IDS.mojo)).toMatchObject({
          id: LEGACY_MINI_APP_IDS.mojo,
          status: "active",
          revision: 6,
          templateVersion: 6,
        });
      } finally { database.close(); }
    });

    // An archived primary canonical Mojo must never silently archive an active secondary
    await fixture(async (root) => {
      const database = new DatabaseSync(join(root, "apps.db"));
      try {
        const { apps, defaults } = setup(root, database, ["legacy-publisher"]);
        seedLegacyMojo(database, root, { revision: 6, templateVersion: 6, publisherBotIds: ["legacy-publisher"], status: "archived" });
        const secondary = await apps.publish(owner, {
          requestKey: "active-secondary-mojo",
          expectedRevision: 0,
          slug: "mojo-included-1",
          title: "Mojo",
          description: "Quotes and poetry.",
          html: pendingDefaultHtml("mojo"),
          bindings: [],
          publisherBotIds: [],
          shippedTemplateKind: "mojo",
        });

        const result = await defaults.ensure(owner, { bookkeepingHtml: "<p>Example ledger</p>" });
        expect(result.issues).toEqual([]);
        expect(result.apps.find((item) => item.id === LEGACY_MINI_APP_IDS.mojo)).toMatchObject({
          id: LEGACY_MINI_APP_IDS.mojo,
          status: "archived",
          revision: 6,
          templateVersion: 6,
        });
        expect(result.apps.find((item) => item.id === secondary.app.id)).toMatchObject({
          id: secondary.app.id,
          status: "active",
          revision: 1,
          templateVersion: 1,
        });
      } finally { database.close(); }
    });
  });
});
