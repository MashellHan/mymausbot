import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
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

function setup(root: string, database: DatabaseSync) {
  const apps = new MiniApps({ docs: docs(root), data, validPublisher: () => false,
    access: { database: () => database, write: (work) => work(database) } });
  const defaults = new DefaultMiniApps({ apps, data: data as DataEngine, bots: () => [], routines: () => null, reports: {} as ReportStore });
  return { apps, defaults };
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
});
