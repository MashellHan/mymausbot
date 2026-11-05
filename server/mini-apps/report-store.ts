import { createHash } from "node:crypto";
import { REPORT_APPS, REPORT_COLUMNS, REPORT_TABLE, reportPublicationDraft, type ReportEditionReceipt,
  type ReportKind, type ReportPrepareResult } from "../../shared/report-mini-app.ts";
import type { BotDatabase, DataEngine } from "../data/types.ts";
import { quoteLiteral } from "../data/tools.ts";
import { MINI_APPS_OWNER } from "./registry.ts";
import { appFailure } from "./validation.ts";
import { parseReportEdition } from "./report-schema.ts";

const TABLE = `main.${REPORT_TABLE}`;
const COLUMNS = REPORT_COLUMNS.map(([name]) => name);
const TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  ${REPORT_COLUMNS.map(([name, type]) => `${name} ${type}${["report_kind", "edition_key", "item_index", "edition_day"].includes(name) ? " NOT NULL" : ""}`).join(",\n  ")},
  PRIMARY KEY (report_kind, edition_key, item_index)
)`;
const chinaDay = (at: number) => new Date(at + 8 * 60 * 60_000).toISOString().slice(0, 10);
const sqlValue = (value: string | number | null): string => value === null ? "NULL" : typeof value === "number" ? String(value) : quoteLiteral(value);

type Header = { contentHash: string; publishedAt: string; itemCount: number };

export class ReportStore {
  constructor(private readonly data: DataEngine, private readonly template: (kind: ReportKind) => string,
    private readonly now: () => number = Date.now) {}

  private async ensureTable(database: BotDatabase): Promise<void> {
    const table = (await database.listSourceTables()).find((source) => source.schema === "main" && source.name === REPORT_TABLE);
    if (!table) await database.run(TABLE_DDL, { connection: "bot", businessMutation: true });
    const created = (await database.listSourceTables()).find((source) => source.schema === "main" && source.name === REPORT_TABLE);
    if (!created || JSON.stringify(created.columns.map(({ name, type }) => [name, type.toUpperCase()])) !== JSON.stringify(REPORT_COLUMNS)) {
      throw appFailure(409, "The retained report table has an incompatible schema.");
    }
    const constraints = await database.run(`SELECT constraint_column_names FROM duckdb_constraints()
      WHERE schema_name = 'main' AND table_name = ${quoteLiteral(REPORT_TABLE)} AND constraint_type = 'PRIMARY KEY'`,
    { connection: "panel", maxRows: 1 });
    let primary: unknown;
    try { primary = JSON.parse(String(constraints.rows[0]?.[0])); } catch {}
    if (JSON.stringify(primary) !== JSON.stringify(["report_kind", "edition_key", "item_index"])) {
      throw appFailure(409, "The retained report table has no matching edition key.");
    }
  }

  private async connect(botId: string): Promise<{ database: BotDatabase; datasetId: string; revision: number }> {
    await this.ensureTable(await this.data.forBot(botId));
    const promoted = await this.data.promoteForBot(botId, MINI_APPS_OWNER);
    return { database: await this.data.forBot(botId), datasetId: promoted.datasetId, revision: promoted.revision };
  }

  private editionKey(given: string | undefined, nominalAt: number | null): string {
    if (nominalAt !== null && (!Number.isSafeInteger(nominalAt) || nominalAt <= 0)) throw appFailure(400, "The Automation run has no valid scheduled time.");
    const key = nominalAt === null ? given : chinaDay(nominalAt);
    if (!key || !/^\d{4}-\d{2}-\d{2}$/u.test(key) || Number.isNaN(Date.parse(`${key}T00:00:00Z`)) ||
        new Date(`${key}T00:00:00Z`).toISOString().slice(0, 10) !== key || given && nominalAt !== null && given !== key ||
        key > chinaDay(this.now())) throw appFailure(400, "Use the Automation's scheduled China day or an explicit past/current edition day.");
    return key;
  }

  async prepare(botId: string, kind: ReportKind, nominalAt: number | null = null): Promise<ReportPrepareResult> {
    if (!Object.hasOwn(REPORT_APPS, kind)) throw appFailure(400, "Unsupported report kind.");
    const { database, datasetId, revision } = await this.connect(botId);
    const html = this.template(kind);
    return { kind, slug: REPORT_APPS[kind].slug, nominalEditionKey: nominalAt === null ? null : this.editionKey(undefined, nominalAt),
      dataset: { datasetId, revision, tables: await database.listSourceTables() },
      publication: reportPublicationDraft(kind, datasetId, html) };
  }

  private async header(database: BotDatabase, kind: ReportKind, key: string): Promise<Header | null> {
    const result = await database.run(`SELECT content_sha256, published_at, item_count FROM ${TABLE}
      WHERE report_kind = ${quoteLiteral(kind)} AND edition_key = ${quoteLiteral(key)} AND item_index = 0`,
    { connection: "bot", maxRows: 1 });
    const row = result.rows[0];
    if (!row) return null;
    return { contentHash: String(row[0]), publishedAt: String(row[1]), itemCount: Number(row[2]) };
  }

  async publish(botId: string, kind: ReportKind, raw: unknown, nominalAt: number | null = null): Promise<ReportEditionReceipt> {
    if (!Object.hasOwn(REPORT_APPS, kind)) throw appFailure(400, "Unsupported report kind.");
    const edition = parseReportEdition(kind, raw);
    const editionKey = this.editionKey(edition.editionKey, nominalAt);
    const normalized = { ...edition, editionKey };
    const contentHash = createHash("sha256").update(JSON.stringify({ kind, edition: normalized })).digest("hex");
    const { database, datasetId } = await this.connect(botId);
    const receipt = (header: Header, replayed: boolean): ReportEditionReceipt => ({ slug: REPORT_APPS[kind].slug,
      datasetId, kind, editionKey, editionDay: editionKey, itemCount: header.itemCount,
      contentHash: header.contentHash, publishedAt: header.publishedAt, replayed });
    const previous = await this.header(database, kind, editionKey);
    if (previous) {
      if (previous.contentHash !== contentHash) throw appFailure(409, "This report edition already has different content.");
      return receipt(previous, true);
    }
    const publishedAt = new Date(this.now()).toISOString();
    const common = { report_kind: kind, edition_key: editionKey, edition_day: editionKey };
    const rows: Array<Record<string, string | number | null>> = [{ ...common, item_index: 0,
      window_start_at: edition.windowStartAt, window_end_at: edition.windowEndAt, source_as_of_at: edition.sourceAsOfAt,
      coverage_status: edition.coverageStatus, coverage_note: edition.coverageNote, item_count: edition.items.length,
      content_sha256: contentHash, published_at: publishedAt, summary: edition.reportSummary }];
    edition.items.forEach((item, index) => rows.push({ ...common, item_index: index + 1,
      category: item.category, title: item.title, summary: item.summary, why_it_matters: item.whyItMatters,
      verification_note: item.verificationNote, source_label: item.sourceLabel, source_url: item.sourceUrl,
      source_published_at: item.sourcePublishedAt, attribution: item.attribution, repo_full_name: item.repoFullName,
      repo_stars: item.repoStars, repo_forks: item.repoForks, repo_pushed_at: item.repoPushedAt,
      weekly_star_increase: item.weeklyStarIncrease, signal_source_url: item.signalSourceUrl,
      public_advisory_count: item.publicAdvisoryCount, public_advisory_as_of_at: item.publicAdvisoryAsOfAt,
      selection_basis: item.selectionBasis }));
    const values = rows.map((row) => `(${COLUMNS.map((column) => sqlValue(row[column] ?? null)).join(", ")})`).join(", ");
    try {
      await database.run(`INSERT INTO ${TABLE} (${COLUMNS.join(", ")}) VALUES ${values}`,
        { connection: "bot", businessMutation: true, maxRows: 0 });
    } catch (error) {
      const current = await this.header(database, kind, editionKey).catch(() => null);
      if (current?.contentHash === contentHash) return receipt(current, true);
      if (current) throw appFailure(409, "This report edition already has different content.");
      throw error;
    }
    return receipt({ contentHash, publishedAt, itemCount: edition.items.length }, false);
  }
}
