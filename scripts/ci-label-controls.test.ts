import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { CONTROL_LABELS, labelRequest, routeLabelControl } from "./ci-label-controls.mjs";
import { interpolate } from "./testing/github-expression.ts";

const workflow = parse(readFileSync(new URL("../.github/workflows/ci-control-labels.yml", import.meta.url), "utf8"));
const ci = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const repository = "MashellHan/mymausbot";
const head = "a".repeat(40);
const base = "b".repeat(40);
const event = (action: string, label?: string) => ({ action, number: 134, repository: { full_name: repository },
  label: label === undefined ? undefined : { name: label }, pull_request: { number: 134, head: { sha: head },
    base: { sha: base, repo: { full_name: repository } } } });
const context = (action: string, label?: string, runId = 42) => ({ github: { event_name: "pull_request_target", run_id: runId,
  event: event(action, label) } });
const sourceRun = { id: 123, event: "pull_request", path: ".github/workflows/ci.yml", head_sha: head,
  status: "completed", conclusion: "success", run_attempt: 1,
  pull_requests: [{ number: 134, head: { sha: head }, base: { sha: base } }] };

function apiFor(run = sourceRun, current = { state: "open", head: { sha: head }, base: { sha: base } }) {
  return vi.fn(async (path: string, options?: { method?: string; raw?: boolean }) => {
    if (path.startsWith("/actions/workflows/ci.yml/runs?")) return { workflow_runs: [run] };
    if (path === "/pulls/134") return current;
    if (path === `/actions/runs/${run.id}/rerun` && options?.method === "POST" && options.raw) return Buffer.alloc(0);
    throw new Error(`Unexpected API request: ${path}`);
  });
}

describe("CI control label routing", () => {
  it("keeps ordinary metadata out of the required CI workflow and its cancellation group", async () => {
    expect(ci.on.pull_request.types).toEqual(["opened", "synchronize", "reopened"]);
    expect(ci.jobs.gate.name).toBe("CI");
    expect(workflow.on.pull_request_target.types).toEqual(["labeled", "unlabeled"]);
    expect(workflow.name).not.toBe("CI");
    expect(workflow.jobs.route.name).not.toBe("CI");
    expect(workflow.jobs.route.if).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: "read", actions: "write", "pull-requests": "read" });
    for (const label of ["qa:triaged", "qa:p2", "qa:kind:product", "qa:scope:agents", "owner:backend"]) {
      for (const action of ["labeled", "unlabeled"]) {
        const ctx = context(action, label);
        expect(interpolate(workflow.concurrency.group, ctx)).toBe("ci-control-metadata-42");
        expect(interpolate(workflow.concurrency["cancel-in-progress"], ctx)).toBe(false);
        const api = vi.fn();
        expect(await routeLabelControl({ event: event(action, label), repository, api })).toEqual({ status: "ignored" });
        expect(api).not.toHaveBeenCalled();
      }
    }
  });

  it.each(CONTROL_LABELS)("refreshes exact-head PR validation when %s is added or removed", async (label) => {
    for (const action of ["labeled", "unlabeled"]) {
      const ctx = context(action, label);
      expect(interpolate(workflow.concurrency.group, ctx)).toBe("ci-control-pr-134");
      expect(interpolate(workflow.concurrency["cancel-in-progress"], ctx)).toBe(true);
      const api = apiFor();
      expect(await routeLabelControl({ event: event(action, label), repository, api })).toEqual({
        status: "rerun-requested", runId: 123, head,
      });
      expect(api).toHaveBeenCalledWith(`/actions/runs/123/rerun`, { method: "POST", raw: true });
    }
  });

  it("routes missing label data conservatively and refuses invalid PR identity", async () => {
    expect(labelRequest(event("labeled"), repository)).toEqual({ number: 134, head, base });
    expect(await routeLabelControl({ event: event("labeled"), repository, api: apiFor() })).toMatchObject({ status: "rerun-requested" });
    for (const malformed of [
      { ...event("labeled", "ci:full"), number: 999 },
      { ...event("labeled", "qa:triaged"), number: 999 },
      { ...event("labeled", "ci:full"), repository: { full_name: "other/repo" } },
      { ...event("labeled", "ci:full"), pull_request: { ...event("labeled").pull_request, head: { sha: "bad" } } },
    ]) expect(() => labelRequest(malformed, repository)).toThrow("Invalid current PR identity");
  });

  it("waits for the existing source attempt, then refreshes it without creating a branch run", async () => {
    const active = { ...sourceRun, status: "in_progress", conclusion: null };
    const api = vi.fn(async (path: string, options?: { method?: string; raw?: boolean }) => {
      if (path.startsWith("/actions/workflows/ci.yml/runs?")) return { workflow_runs: [active] };
      if (path === "/actions/runs/123") return sourceRun;
      if (path === "/pulls/134") return { state: "open", head: { sha: head }, base: { sha: base } };
      if (path === "/actions/runs/123/rerun" && options?.method === "POST" && options.raw) return Buffer.alloc(0);
      throw new Error(`Unexpected API request: ${path}`);
    });
    const wait = vi.fn(async () => undefined);
    expect(await routeLabelControl({ event: event("labeled", "windows"), repository, api, wait })).toMatchObject({ status: "rerun-requested" });
    expect(wait).toHaveBeenCalledOnce();
    expect(api).toHaveBeenCalledWith("/actions/runs/123/rerun", { method: "POST", raw: true });
  });

  it("fails closed on absent source validation and current base drift, while a new head owns its own run", async () => {
    const skipped = { ...sourceRun, conclusion: "skipped" };
    const noSource = apiFor(skipped);
    await expect(routeLabelControl({ event: event("labeled", "qa:repair"), repository, api: noSource })).rejects.toThrow("No current-head source PR CI run");
    expect(noSource).not.toHaveBeenCalledWith("/actions/runs/123/rerun", expect.anything());
    const staleBaseRun = apiFor({ ...sourceRun, pull_requests: [{ number: 134, head: { sha: head }, base: { sha: "c".repeat(40) } }] });
    await expect(routeLabelControl({ event: event("labeled", "windows"), repository, api: staleBaseRun })).rejects.toThrow("No current-head source PR CI run");
    const movedBase = apiFor(sourceRun, { state: "open", head: { sha: head }, base: { sha: "c".repeat(40) } });
    await expect(routeLabelControl({ event: event("labeled", "ci:full"), repository, api: movedBase })).rejects.toThrow("PR base changed");
    const movedHead = apiFor(sourceRun, { state: "open", head: { sha: "c".repeat(40) }, base: { sha: base } });
    expect(await routeLabelControl({ event: event("labeled", "ci:full"), repository, api: movedHead })).toEqual({ status: "superseded" });
    expect(movedHead).not.toHaveBeenCalledWith("/actions/runs/123/rerun", expect.anything());
  });

  it("lets the PR gate fail closed if current controls cannot be read", async () => {
    const api = vi.fn(async (path: string, options?: { method?: string; raw?: boolean }) => {
      if (path.startsWith("/actions/workflows/ci.yml/runs?")) return { workflow_runs: [sourceRun] };
      if (path === "/pulls/134") throw new Error("PR controls unavailable");
      if (path === "/actions/runs/123/rerun" && options?.method === "POST" && options.raw) return Buffer.alloc(0);
      throw new Error(`Unexpected API request: ${path}`);
    });
    expect(await routeLabelControl({ event: event("unlabeled", "upstream-sync"), repository, api })).toMatchObject({ status: "rerun-requested" });
    expect(api).toHaveBeenCalledWith("/actions/runs/123/rerun", { method: "POST", raw: true });
  });
});
