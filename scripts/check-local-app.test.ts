import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertInventorySame, assertRoutinesSame, validateBuildRequest } from "./check-local-app.mjs";

const routine = { id: "routine-1", prompt: "Synthetic task", enabled: true, schedule: { type: "daily", time: "05:00" } };
const run = { id: "run-1", routineId: routine.id, botId: "bot-1", target: "bot", runOn: "maus", createdAt: 1,
  scheduledFor: 2, manual: false, status: "running", access: "read-and-draft" };
const routines = () => ({ version: 1, routines: [structuredClone(routine)], runs: [structuredClone(run)] });

describe("local App preservation", () => {
  it("allows recovery status changes and new runs while retaining existing identities and definitions", () => {
    const before = routines();
    const after = routines();
    after.runs[0]!.status = "queued";
    after.runs.push({ ...run, id: "run-2" });
    expect(() => assertRoutinesSame(before, after)).not.toThrow();
  });

  it("rejects changed configuration, missing history, duplicate runs and expanded run authority", () => {
    const before = routines();
    for (const change of [
      (after: ReturnType<typeof routines>) => { after.routines[0]!.prompt = "Changed"; },
      (after: ReturnType<typeof routines>) => { after.routines[0]!.enabled = false; },
      (after: ReturnType<typeof routines>) => { after.runs = []; },
      (after: ReturnType<typeof routines>) => { after.runs.push({ ...run }); },
      (after: ReturnType<typeof routines>) => { after.runs[0]!.access = "expanded"; },
      (after: ReturnType<typeof routines>) => { after.runs[0]!.target = "room-goal"; },
    ]) {
      const after = routines(); change(after);
      expect(() => assertRoutinesSame(before, after)).toThrow();
    }
    expect(() => assertRoutinesSame(before, { ...before, runs: [{ ...run, groupId: "new-room" }] })).toThrow();
    expect(() => assertRoutinesSame(before, { ...before, version: 2 })).toThrow();
  });

  it("normalizes only absent template provenance without ignoring IDs, revisions or grants", () => {
    const app = { id: "app-1", revision: 1, dashboard: { kind: "usage" }, publisherBotIds: ["bot-1"] };
    const before = { apps: [app] };
    expect(() => assertInventorySame(before, { apps: [{ ...app, shippedTemplateKind: null }] })).not.toThrow();
    for (const change of [{ id: "app-2" }, { revision: 2 }, { dashboard: { kind: "agent-team" } },
      { publisherBotIds: ["other-bot"] }, { shippedTemplateKind: "bookkeeping" }]) {
      expect(() => assertInventorySame(before, { apps: [{ ...app, ...change }] })).toThrow();
    }
    expect(() => assertInventorySame(before, { apps: [] })).toThrow();
    expect(() => assertInventorySame({ apps: [app, app] }, { apps: [app, app] })).toThrow();
  });
});

it("fails delivery preflight before a build for incomplete, dirty or mismatched source", () => {
  const directory = mkdtempSync(join(tmpdir(), "mausbot-delivery-"));
  const requestPath = join(tmpdir(), `mausbot-request-${process.pid}-${Date.now()}.json`);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  try {
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    const lock = "synthetic lock\n";
    writeFileSync(join(directory, "pnpm-lock.yaml"), lock);
    git("add", "."); git("commit", "-qm", "fixture");
    const request = { sourceCheckout: directory, sourceCommit: git("rev-parse", "HEAD"), sourceTree: git("rev-parse", "HEAD^{tree}"),
      sourceRef: "HEAD", appVersion: "1.0.0", lockfileSha256: createHash("sha256").update(lock).digest("hex"),
      targetApp: join(directory, "normal.app"), packageApp: join(directory, "package.app"), officialApp: join(directory, "official.app"),
      expectedDownloadsPurpose: "Synthetic access purpose", expectedEnvironmentId: "fixture-environment" };
    expect(() => validateBuildRequest({ ...request, expectedDownloadsPurpose: undefined })).toThrow("expectedDownloadsPurpose");
    expect(() => validateBuildRequest({ ...request, targetApp: request.officialApp })).toThrow("different paths");
    const invoke = (value: object) => {
      writeFileSync(requestPath, JSON.stringify(value));
      return spawnSync(process.execPath, [fileURLToPath(new URL("./check-local-app.mjs", import.meta.url)), "request", requestPath], { encoding: "utf8" });
    };
    expect(invoke(request).status).toBe(0);
    expect(invoke({ ...request, sourceCommit: "0".repeat(40) }).status).toBe(1);
    expect(invoke({ ...request, lockfileSha256: "0".repeat(64) }).status).toBe(1);
    writeFileSync(join(directory, "unexpected.txt"), "not committed");
    const dirty = invoke(request);
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain("must be clean");
  } finally { rmSync(directory, { recursive: true, force: true }); rmSync(requestPath, { force: true }); }
});
