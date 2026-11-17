import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gateRun } from "./gate.mjs";
import { artifactFiles, github, runPlan } from "./github.mjs";

const repository = "example/mausbot";
const run = { id: 100, run_attempt: 1, head_sha: "a".repeat(40) };
const preflight = { name: "typecheck + lint", run_attempt: 1, status: "completed", conclusion: "success" };
const required = { name: "control-plane check + workerd tests + dry run", run_attempt: 1, status: "completed", conclusion: "success" };
const outputs = { full_required: false, reduced: false, qa_areas: ["global"], required_jobs: ["control-plane"],
  expected_jobs: [{ id: "static", name: preflight.name }, { id: "control-plane", name: required.name }] };
const zipPath = "/actions/artifacts/9/zip";
const metadataPath = "/actions/artifacts/9";

function archive(plan: object) {
  const directory = mkdtempSync(join(tmpdir(), "mausbot-plan-test-"));
  try {
    writeFileSync(join(directory, "qa-plan.json"), JSON.stringify(plan));
    const path = join(directory, "plan.zip");
    execFileSync("zip", ["-q", path, "qa-plan.json"], { cwd: directory });
    return readFileSync(path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

type FixtureOptions = {
  statuses?: number[];
  metadataStatus?: number;
  metadataPatch?: Record<string, unknown>;
  artifactPatch?: Record<string, unknown>;
  planPatch?: Record<string, unknown>;
  archiveBody?: Buffer;
  runAttempt?: number;
  prHead?: string;
  jobs?: object[];
  issues?: object[];
};

function fixture({ statuses = [404, 200], metadataStatus = 200, metadataPatch = {}, artifactPatch = {}, planPatch = {}, archiveBody,
  runAttempt = 1, prHead, jobs = [preflight, required], issues = [] }: FixtureOptions = {}) {
  const plan = { version: 1, runId: run.id, attempt: 1, sha: run.head_sha,
    ...(prHead ? { execution: { merge: run.head_sha, base: "c".repeat(40), head: prHead } } : {}),
    outputs: prHead ? { ...outputs, pr_number: 7, pr_head: prHead } : outputs, ...planPatch };
  const bytes = archive(plan);
  const artifact = { id: 9, name: "qa-plan-attempt-1", expired: false, size_in_bytes: bytes.length,
    workflow_run: { id: run.id, head_sha: prHead ?? run.head_sha }, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, ...artifactPatch };
  const requests: string[] = [];
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = url.replace(`https://api.github.test/repos/${repository}`, "");
    requests.push(path);
    if (path === zipPath) {
      const status = statuses[Math.min(reads++, statuses.length - 1)] ?? 200;
      return new Response(status === 200 ? new Uint8Array(archiveBody ?? bytes) : null, { status });
    }
    if (path === metadataPath) return metadataStatus === 200
      ? Response.json({ ...artifact, ...metadataPatch }) : new Response(null, { status: metadataStatus });
    if (path === `/actions/runs/${run.id}`) return Response.json({ ...run, run_attempt: runAttempt, event: "pull_request",
      head_sha: prHead, created_at: new Date(Date.now() - 1000).toISOString() });
    if (path === "/pulls/7") return Response.json({ head: { sha: prHead }, labels: [] });
    if (path.startsWith(`/actions/runs/${run.id}/jobs?`)) return Response.json({ jobs });
    if (path.startsWith(`/actions/runs/${run.id}/artifacts?`)) return Response.json({ artifacts: [artifact] });
    if (path.startsWith("/issues?")) return Response.json(issues);
    throw new Error(`Unexpected synthetic API request: ${path}`);
  }));
  return { plan, artifact, requests,
    read: () => runPlan({ ...run, run_attempt: runAttempt }, jobs, [artifact], prHead ? { artifactHead: prHead } : {}),
    gate: () => gateRun({ runId: run.id, attempt: runAttempt, sha: run.head_sha, event: prHead ? "pull_request" : "schedule", deadlineMs: 0,
      ...(prHead ? { eventPayload: { pull_request: { number: 7, head: { sha: prHead } } } } : {}) }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("GITHUB_REPOSITORY", repository);
  vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
  vi.stubEnv("GH_TOKEN", "synthetic-token");
  vi.stubEnv("MAUSBOT_GH_COMMAND", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("bound current-run plan archive recovery", () => {
  it("recovers a transient archive 404 only after verifying the same artifact metadata", async () => {
    const found = fixture();
    const result = expect(found.read()).resolves.toEqual(found.plan);
    await vi.runAllTimersAsync();
    await result;
    expect(found.requests).toEqual([zipPath, metadataPath, zipPath]);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      `GitHub GET ${zipPath}: HTTP 404 (current-run plan 100, producer attempt 1, archive read 1/3)`);
  });

  it("keeps recovery bound to a carried preflight's producing attempt", async () => {
    const found = fixture({ runAttempt: 2 });
    const result = expect(found.read()).resolves.toEqual(found.plan);
    await vi.runAllTimersAsync();
    await result;
    expect(found.plan.attempt).toBe(1);
    expect(found.requests).toEqual([zipPath, metadataPath, zipPath]);
  });

  it("keeps the verified PR head separate from the executed merge SHA during recovery", async () => {
    const prHead = "b".repeat(40);
    const found = fixture({ prHead });
    const result = expect(found.gate()).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    await result;
    expect(found.plan).toMatchObject({ sha: run.head_sha, execution: { head: prHead, merge: run.head_sha } });
    expect(found.requests.filter((path) => path === zipPath)).toHaveLength(2);
    expect(found.requests.filter((path) => path === metadataPath)).toHaveLength(1);
  });

  it("exhausts after three archive reads and retains every failed read", async () => {
    const pause = vi.spyOn(globalThis, "setTimeout");
    const found = fixture({ statuses: [404] });
    const result = expect(found.read()).rejects.toMatchObject({ status: 404, method: "GET", path: zipPath });
    await vi.runAllTimersAsync();
    await result;
    expect(found.requests).toEqual([zipPath, metadataPath, zipPath, metadataPath, zipPath]);
    expect(console.warn).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenLastCalledWith(expect.stringContaining("archive read 3/3"));
    expect(pause.mock.calls.map((call) => call[1])).toEqual([1000, 2000]);
  });

  it.each([401, 403])("does not recover an initial HTTP %s", async (status) => {
    const found = fixture({ statuses: [status, 200] });
    await expect(found.read()).rejects.toMatchObject({ status, path: zipPath });
    expect(found.requests).toEqual([zipPath]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([401, 403])("stops when archive recovery encounters HTTP %s", async (status) => {
    const found = fixture({ statuses: [404, status, 200] });
    const result = expect(found.read()).rejects.toMatchObject({ status, path: zipPath });
    await vi.runAllTimersAsync();
    await result;
    expect(found.requests).toEqual([zipPath, metadataPath, zipPath]);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404])("does not retry or bypass metadata HTTP %s", async (status) => {
    const found = fixture({ metadataStatus: status });
    await expect(found.read()).rejects.toMatchObject({ status, path: metadataPath });
    expect(found.requests).toEqual([zipPath, metadataPath]);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["artifact ID", { id: 10 }],
    ["producing attempt", { name: "qa-plan-attempt-2" }],
    ["run", { workflow_run: { id: 101, head_sha: run.head_sha } }],
    ["head", { workflow_run: { id: run.id, head_sha: "b".repeat(40) } }],
    ["digest", { digest: `sha256:${"0".repeat(64)}` }],
    ["size", { size_in_bytes: 1 }],
    ["expiry", { expired: true }],
  ] as const)("rejects changed %s metadata without another archive read", async (_name, metadataPatch) => {
    const found = fixture({ metadataPatch });
    await expect(found.read()).rejects.toMatchObject({ message: "Current-run plan artifact metadata changed", cause: { status: 404 } });
    expect(found.requests).toEqual([zipPath, metadataPath]);
  });

  it.each([
    ["digest", { digest: undefined }],
    ["malformed digest", { digest: "sha256:invalid" }],
    ["workflow run", { workflow_run: undefined }],
    ["head", { workflow_run: { id: run.id } }],
    ["explicit expiry", { expired: undefined }],
  ] as const)("does not grant recovery without complete %s metadata", async (_name, artifactPatch) => {
    const found = fixture({ artifactPatch });
    await expect(found.read()).rejects.toMatchObject({ status: 404, path: zipPath });
    expect(found.requests).toEqual([zipPath]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("does not recover an artifact attributed to another source head", async () => {
    const found = fixture({ artifactPatch: { workflow_run: { id: run.id, head_sha: "b".repeat(40) } } });
    await expect(found.read()).rejects.toMatchObject({ status: 404, path: zipPath });
    expect(found.requests).toEqual([zipPath]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("does not read an artifact attributed to another run", async () => {
    const found = fixture({ artifactPatch: { workflow_run: { id: 101, head_sha: run.head_sha } } });
    await expect(found.read()).rejects.toThrow("Missing current-run validation plan");
    expect(found.requests).toEqual([]);
  });

  it.each([
    ["source SHA", { sha: "b".repeat(40) }],
    ["run ID", { runId: 101 }],
    ["producing attempt", { attempt: 2 }],
  ] as const)("still rejects a recovered plan's mismatched %s", async (_name, planPatch) => {
    const found = fixture({ planPatch });
    const result = expect(found.read()).rejects.toThrow("Missing current-run validation plan");
    await vi.runAllTimersAsync();
    await result;
    expect(found.requests).toEqual([zipPath, metadataPath, zipPath]);
  });

  it("rejects recovered ZIP bytes that do not match the pinned digest", async () => {
    const found = fixture({ archiveBody: archive({ sha: "b".repeat(40) }) });
    const result = expect(found.read()).rejects.toThrow("Artifact digest mismatch");
    await vi.runAllTimersAsync();
    await result;
    expect(found.requests).toEqual([zipPath, metadataPath, zipPath]);
  });

  it("does not retry a digest mismatch on the first successful archive read", async () => {
    const found = fixture({ statuses: [200], archiveBody: archive({ unexpected: true }) });
    await expect(found.read()).rejects.toThrow("Artifact digest mismatch");
    expect(found.requests).toEqual([zipPath]);
  });

  it("leaves generic and unbound archive 404s as immediate failures", async () => {
    const found = fixture({ statuses: [404] });
    await expect(artifactFiles(found.artifact)).rejects.toMatchObject({ status: 404, path: zipPath });
    await expect(github(zipPath, { raw: true })).rejects.toMatchObject({ status: 404, path: zipPath });
    expect(found.requests).toEqual([zipPath, zipPath]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["an unstructured error", {}],
    ["another endpoint", { status: 404, method: "GET", path: metadataPath }],
    ["a write", { status: 404, method: "POST", path: zipPath }],
  ] as const)("does not classify %s as a recoverable archive response", async (_name, properties) => {
    const found = fixture();
    const error = Object.assign(new Error("unavailable"), properties);
    await expect(runPlan(run, [preflight], [found.artifact], { readArtifact: async () => { throw error; } })).rejects.toBe(error);
    expect(found.requests).toEqual([]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["failed required job", { jobs: [preflight, { ...required, conclusion: "failure" }] }, "Required validation failed"],
    ["skipped required job", { jobs: [preflight, { ...required, conclusion: "skipped" }] }, "Required validation failed"],
    ["missing required job", { jobs: [preflight] }, "Incomplete required validation"],
    ["QA hold", { issues: [{ number: 7, labels: ["qa:p0"] }] }, "QA hold: #7"],
  ] as const)("does not mask a %s after archive recovery", async (_name, options, message) => {
    const found = fixture(options as FixtureOptions);
    const result = expect(found.gate()).rejects.toThrow(message);
    await vi.runAllTimersAsync();
    await result;
    expect(found.requests.filter((path) => path === zipPath)).toHaveLength(2);
    expect(found.requests.filter((path) => path === metadataPath)).toHaveLength(1);
  });
});
