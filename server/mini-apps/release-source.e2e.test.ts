import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type {
  MiniAppDocument, MiniAppMutationResult, MiniAppReleaseManifestV1, MiniAppUpdateCheckResult,
} from "../../shared/mini-apps.ts";
import { launchMiniAppsFixture } from "../testing/mini-apps-fixture.ts";

const SHA_45 = "ff735189522a871f645b7942b9040d466b074b7b14033bb672c2f8d7b07a4c74";
const SHA_48 = "7d9eb03023d99600b052840a6adef3ec95552f31a4aa0d2bc2ec104795256a94";
const COMMIT_A = "81253883c34a1d4ca829fa907ee0514156b780d7";
const COMMIT_B = "99993883c34a1d4ca829fa907ee0514156b780d9";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function releaseEntry(params: {
  appVersion: string;
  sourceCommit: string;
  html: string;
  tamperHtml?: string;
}) {
  const htmlBytes = Buffer.from(params.html, "utf8");
  const queries = JSON.stringify({ contractVersion: "0.1-draft", dataSlots: [] });
  const queriesBytes = Buffer.from(queries, "utf8");
  const manifest: MiniAppReleaseManifestV1 = {
    formatVersion: 1,
    packageId: "mashellhan.agent-team",
    appVersion: params.appVersion,
    sourceCommit: params.sourceCommit,
    requires: ["agent-team-v1"],
    artifacts: {
      "index.html": { bytes: htmlBytes.byteLength, sha256: sha256(htmlBytes) },
      "queries.json": { bytes: queriesBytes.byteLength, sha256: sha256(queriesBytes) },
    },
  };
  return {
    tagName: `mini-app/agent-team/v${params.appVersion}`,
    tagCommitSha: params.sourceCommit,
    targetCommitish: "main",
    isDraft: false,
    isPrerelease: false,
    assets: {
      "manifest.json": JSON.stringify(manifest),
      "index.html": params.tamperHtml ?? params.html,
      "queries.json": queries,
    },
  };
}

it("proves #45, #48, custom-HTML protection, upgrade/rollback, restart persistence, and negative HTTP cases against an isolated fixture", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-mini-release-e2e-"));
  const releasesFile = join(scratch, "releases.json");
  const v011 = releaseEntry({
    appVersion: "0.1.1",
    sourceCommit: COMMIT_A,
    html: "<!doctype html><html><meta charset=\"utf-8\"><body><h1>Agent Team 0.1.1</h1></body></html>",
  });
  const v012 = releaseEntry({
    appVersion: "0.1.2",
    sourceCommit: COMMIT_B,
    html: "<!doctype html><html><meta charset=\"utf-8\"><body><h1>Agent Team 0.1.2</h1></body></html>",
  });
  writeFileSync(releasesFile, JSON.stringify({ mode: "ok", releases: [v011, v012] }));
  process.env.OMB_TEST_MINI_APP_RELEASES_FILE = releasesFile;

  const fixture = await launchMiniAppsFixture();
  try {
    const { api, bot } = fixture;
    const opt45Path = process.env.OMB_TEST_AGENT_TEAM_45_HTML;
    const opt48Path = process.env.OMB_TEST_AGENT_TEAM_48_HTML;
    const fallbackReviewed = readFileSync(new URL("../../examples/mini-apps/agent-team/index.html", import.meta.url), "utf8");
    const html45 = opt45Path && existsSync(opt45Path) ? readFileSync(opt45Path, "utf8") : fallbackReviewed;
    const html48 = opt48Path && existsSync(opt48Path) ? readFileSync(opt48Path, "utf8") : fallbackReviewed;
    if (opt45Path && existsSync(opt45Path)) expect(sha256(html45)).toBe(SHA_45);
    if (opt48Path && existsSync(opt48Path)) expect(sha256(html48)).toBe(SHA_48);

    const installed45 = await api<MiniAppMutationResult>("POST", "/api/mini-apps", {
      requestKey: "e2e-45",
      expectedRevision: 0,
      slug: "agent-team-45",
      title: "Agent Team #45",
      description: "",
      html: html45,
      bindings: [],
      dashboardKind: "agent-team",
      publisherBotIds: [bot.id],
    }, 201);
    const installed48 = await api<MiniAppMutationResult>("POST", "/api/mini-apps", {
      requestKey: "e2e-48",
      expectedRevision: 0,
      slug: "agent-team-48",
      title: "Agent Team #48",
      description: "",
      html: html48,
      bindings: [],
      dashboardKind: "agent-team",
      publisherBotIds: [bot.id],
    }, 201);
    const customApp = await api<MiniAppMutationResult>("POST", "/api/mini-apps", {
      requestKey: "e2e-custom",
      expectedRevision: 0,
      slug: "agent-team-custom",
      title: "Custom Agent Team",
      description: "",
      html: "<!doctype html><html><body><h1>Real custom HTML edit</h1></body></html>",
      bindings: [],
      dashboardKind: "agent-team",
      publisherBotIds: [bot.id],
    }, 201);

    // Custom HTML is blocked ("custom" / 409)
    expect(await api<MiniAppUpdateCheckResult>("GET", `/api/mini-apps/${customApp.app.id}/update`)).toEqual({
      installedVersion: null,
      status: "custom",
      available: null,
    });
    await api("POST", `/api/mini-apps/${customApp.app.id}/update`, {
      appVersion: "0.1.2",
      sourceCommit: COMMIT_B,
      expectedRevision: 1,
      requestKey: "custom-blocked",
    }, 409);

    // Paired client cannot check or apply updates (403)
    const pairing = await api<{ code: string }>("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
    const paired = await api<{ token: string }>("POST", "/api/auth/pair", { code: pairing.code, label: "Paired check" });
    await api("GET", `/api/mini-apps/${installed45.app.id}/update`, undefined, 403, { authorization: `Bearer ${paired.token}` });
    await api("POST", `/api/mini-apps/${installed45.app.id}/update`, {
      appVersion: "0.1.1", sourceCommit: COMMIT_A, expectedRevision: 1, requestKey: "paired-try",
    }, 403, { authorization: `Bearer ${paired.token}` });

    // Check & adopt #45 -> 0.1.1, #48 -> 0.1.2
    expect(await api<MiniAppUpdateCheckResult>("GET", `/api/mini-apps/${installed45.app.id}/update`)).toEqual({
      installedVersion: null,
      status: "available",
      available: { appVersion: "0.1.2", sourceCommit: COMMIT_B },
    });
    const adopted45 = await api<MiniAppMutationResult>("POST", `/api/mini-apps/${installed45.app.id}/update`, {
      appVersion: "0.1.1",
      sourceCommit: COMMIT_A,
      expectedRevision: 1,
      requestKey: "adopt-45",
    });
    expect(adopted45.app.release).toMatchObject({
      packageId: "mashellhan.agent-team",
      appVersion: "0.1.1",
      sourceCommit: COMMIT_A,
    });
    expect(adopted45.app.publisherBotIds).toEqual([bot.id]);

    // Idempotent replay + stale revision
    expect(await api<MiniAppMutationResult>("POST", `/api/mini-apps/${installed45.app.id}/update`, {
      appVersion: "0.1.1",
      sourceCommit: COMMIT_A,
      expectedRevision: 1,
      requestKey: "adopt-45",
    })).toEqual({ app: adopted45.app, replayed: true });
    await api("POST", `/api/mini-apps/${installed45.app.id}/update`, {
      appVersion: "0.1.2",
      sourceCommit: COMMIT_B,
      expectedRevision: 1,
      requestKey: "stale-rev",
    }, 409);

    const adopted48 = await api<MiniAppMutationResult>("POST", `/api/mini-apps/${installed48.app.id}/update`, {
      appVersion: "0.1.2",
      sourceCommit: COMMIT_B,
      expectedRevision: 1,
      requestKey: "adopt-48",
    });
    expect(adopted48.app.release?.appVersion).toBe("0.1.2");
    expect(await api<MiniAppUpdateCheckResult>("GET", `/api/mini-apps/${installed48.app.id}/update`)).toEqual({
      installedVersion: "0.1.2",
      status: "current",
      available: null,
    });

    // Upgrade #45 to 0.1.2 then restart host and verify provenance + history survive
    const upgraded45 = await api<MiniAppMutationResult>("POST", `/api/mini-apps/${installed45.app.id}/update`, {
      appVersion: "0.1.2",
      sourceCommit: COMMIT_B,
      expectedRevision: 2,
      requestKey: "upgrade-45-012",
    });
    expect(upgraded45.app.release?.appVersion).toBe("0.1.2");

    await fixture.restart();

    const docAfterRestart = await api<MiniAppDocument>("GET", `/api/mini-apps/${installed45.app.id}`);
    expect(docAfterRestart.app.release?.appVersion).toBe("0.1.2");
    expect(docAfterRestart.versions.map((v) => v.release?.appVersion ?? null)).toEqual(["0.1.2", "0.1.1", null]);

    // Rollback to 0.1.1 preserves grants and restores 0.1.1 provenance
    const rolledBack = await api<MiniAppMutationResult>("POST", `/api/mini-apps/${installed45.app.id}/rollback`, {
      requestKey: "rollback-011",
      expectedRevision: 3,
      templateVersion: 2,
    });
    expect(rolledBack.app.release?.appVersion).toBe("0.1.1");
    expect(rolledBack.app.publisherBotIds).toEqual([bot.id]);

    // Tampered digest fails verification (unavailable check, 422 apply)
    const tampered012 = releaseEntry({
      appVersion: "0.1.2",
      sourceCommit: COMMIT_B,
      html: "<!doctype html><html><meta charset=\"utf-8\"><body><h1>Agent Team 0.1.2</h1></body></html>",
      tamperHtml: "<!doctype html><html><body>tampered</body></html>",
    });
    writeFileSync(releasesFile, JSON.stringify({ mode: "ok", releases: [v011, tampered012] }));
    expect(await api<MiniAppUpdateCheckResult>("GET", `/api/mini-apps/${installed45.app.id}/update`)).toEqual({
      installedVersion: "0.1.1",
      status: "unavailable",
      available: null,
    });
    await api("POST", `/api/mini-apps/${installed45.app.id}/update`, {
      appVersion: "0.1.2",
      sourceCommit: COMMIT_B,
      expectedRevision: 4,
      requestKey: "tampered-apply",
    }, 422);

    // Unavailable release source fails closed (unavailable check, 503 apply)
    writeFileSync(releasesFile, JSON.stringify({ mode: "unavailable", releases: [] }));
    expect(await api<MiniAppUpdateCheckResult>("GET", `/api/mini-apps/${installed45.app.id}/update`)).toEqual({
      installedVersion: "0.1.1",
      status: "unavailable",
      available: null,
    });
    await api("POST", `/api/mini-apps/${installed45.app.id}/update`, {
      appVersion: "0.1.2",
      sourceCommit: COMMIT_B,
      expectedRevision: 4,
      requestKey: "offline-apply",
    }, 503);
  } finally {
    delete process.env.OMB_TEST_MINI_APP_RELEASES_FILE;
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
