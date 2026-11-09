import { isDeepStrictEqual } from "node:util";
import { ALL_OS, ciOutputs, FULL_SCOPE, moveLinuxIntoStatic } from "../ci-scope.mjs";

export const MERGE_JOBS = ["build", "vitest", "behavior-evals", "packaged-server", "windows-cua", "electron-smokes", "relay"];
const PREFLIGHT_NAMES = {
  hosted: ["typecheck + lint", "preflight"],
  boat: ["typecheck + lint + Linux tests (Boat)", "preflight + Linux tests (Boat)"],
};

export function preflightJob(jobs) {
  const matches = jobs.filter((job) => [...PREFLIGHT_NAMES.hosted, ...PREFLIGHT_NAMES.boat].includes(job.name));
  if (matches.length > 1) throw new Error("Ambiguous workflow preflight");
  return matches[0] ?? null;
}

const NAMES = {
  build: "typecheck + build",
  "behavior-evals": "behavior evals (offline tiers 1-3)",
  "windows-cua": "Windows CUA host smoke",
  "electron-smokes": "macOS smokes (packaged server + Electron)",
  "cloudflared-linux-arm64": "cloudflared installer (Linux ARM64)",
  foss: "open-source edition builds without enterprise/",
  "control-plane": "control-plane check + workerd tests + dry run",
  "ui-smoke": "renderer smoke (control-omb ui, Ubuntu 24.04)",
  "package-linux": "package + smoke (Ubuntu 24.04 x64)",
  relay: "relay typecheck + tests + fuzz + audit",
};

export function expectedJobs(outputs = ciOutputs(FULL_SCOPE, ALL_OS), full = true, preflightName) {
  const names = outputs.linux_lanes ? PREFLIGHT_NAMES.boat : PREFLIGHT_NAMES.hosted;
  if (preflightName !== undefined && !names.includes(preflightName)) throw new Error("Invalid workflow preflight");
  const jobs = [{ id: "static", name: preflightName ?? names[0], build: outputs.build,
    ...(outputs.fast_pr ? { fast: true } : {}), linux: Boolean(outputs.linux_lanes),
    ...(outputs.linux_lanes?.vitest.length || outputs.linux_lanes?.evals ? { artifact: "qa-results-boat" } : {}) }];
  for (const id of outputs.jobs) {
    if (!full && !MERGE_JOBS.includes(id)) continue;
    if (id === "vitest") {
      for (const entry of outputs.vitest_matrix.include) jobs.push({ id, name: `vitest (${entry.os}, ${entry.part})`, artifact: `qa-results-vitest-${entry.os}-${entry.shard}`, nodeTests: entry.node_tests });
    } else if (id === "packaged-server" || id === "browser-identity" || id === "browser-driver") {
      for (const os of id === "packaged-server" ? outputs.packaged_server_os : outputs.vitest_os) {
        const label = { "packaged-server": "packaged server smoke", "browser-identity": "browser identity", "browser-driver": "browser driver S4" }[id];
        jobs.push({ id, name: `${label} (${os})`, ...(id === "packaged-server" ? {} : { artifact: `qa-results-${id === "browser-identity" ? "identity" : "driver"}-${os}` }) });
      }
    } else if (NAMES[id]) {
      const artifact = { "behavior-evals": "evals", foss: "foss", "ui-smoke": "ui" }[id];
      jobs.push({ id, name: NAMES[id], ...(artifact ? { artifact: `qa-results-${artifact}` } : {}) });
    }
    else throw new Error(`No validation contract for selected job: ${id}`);
  }
  return jobs;
}

export function inspectJobs(expected, observed) {
  const missing = expected.filter((item) => !observed.some((job) => job.name === item.name)).map((item) => item.name);
  const selected = expected.flatMap((item) => observed.filter((job) => job.name === item.name));
  return {
    missing, pending: selected.filter((job) => job.status !== "completed").map((job) => job.name),
    failed: selected.filter((job) => job.status === "completed" && job.conclusion !== "success").map((job) => job.name),
    passed: !missing.length && selected.length === expected.length && selected.every((job) => job.status === "completed" && job.conclusion === "success"),
  };
}

const VALIDATION_STEPS = {
  static: ["Verify CI selection and documentation references", "Validate locale catalogs", "pnpm lint", "Source guards", "Security, data and dispatch core with bounded affected tests", "pnpm typecheck", "pnpm check:electron", "production UI build"],
  build: ["pnpm typecheck", "pnpm check:electron", "production UI build"],
  vitest: ["Run tests"],
  "behavior-evals": ["Eval suite typecheck", "Eval vitest gate", "Tier 1 scenarios", "Tier 2 golden replay", "Tier 3 stays offline"],
  "packaged-server": ["pnpm test:packaged-server"],
  "windows-cua": ["Smoke the staged Windows CUA host", "Lend this PC's apps"],
  "electron-smokes": ["Packaged server smoke", "Verify native approval", "Verify app permissions", "Verify chat app frames", "Verify paired phone", "Verify Send to My Cloud"],
  "cloudflared-linux-arm64": ["Install and reuse the pinned connector"],
  foss: ["pnpm typecheck", "pnpm exec vitest run", "The server boots"],
  "control-plane": ["pnpm control-plane:check", "pnpm control-plane:test", "pnpm control-plane:dry-run"],
  "ui-smoke": ["Drive the real renderer through control-omb ui"],
  "browser-identity": ["Drive a real Chrome through the launcher"],
  "package-linux": ["Prove overlay-free X11 input routing", "Package from the verified offline CUA stage", "node scripts/verify-linux-package.mjs", "Reproduce and verify an in-place DEB upgrade", "Verify the installed browser", "Launch packaged app"],
  relay: ["Audit the production dependencies", "pnpm check", "pnpm test"],
  "browser-driver": ["S4 on the runner's Google Chrome"],
};

export function executionComplete(expected, jobs, artifacts) {
  return expected.every((item) => {
    const job = jobs.find((entry) => entry.name === item.name);
    if (!job || job.status !== "completed" || !["success", "failure"].includes(job.conclusion)) return false;
    if (item.artifact && !artifacts.has(item.artifact)) return false;
    const steps = VALIDATION_STEPS[item.id].filter((step) => {
      if (item.id !== "static") return true;
      if (step === "Security, data and dispatch core with bounded affected tests") return item.fast;
      if (step === "pnpm typecheck") return item.build;
      if (["pnpm check:electron", "production UI build"].includes(step)) return item.build && !item.fast;
      return true;
    });
    if (item.linux) steps.push("Linux tests (vitest shards, behavior evals, packaged server), side by side");
    if (item.nodeTests) steps.push("Broker and Electron unit tests");
    if (item.id === "browser-driver" && item.name.includes("ubuntu")) steps.push("S4 inside the server image's runtime");
    if (item.id === "browser-driver" && item.name.includes("macos")) steps.push("The runner's Google Chrome did not change");
    return steps.every((prefix) => job.steps?.some((step) => (step.name.startsWith(prefix) || step.name.startsWith(`Run ${prefix}`)) && ["success", "failure"].includes(step.conclusion)));
  });
}

export function eligibleRun(run, repository, fullOnly = true) {
  return run.path === ".github/workflows/ci.yml" && run.head_branch === "main" && run.head_repository?.full_name === repository
    && (fullOnly ? ["schedule", "workflow_dispatch"] : ["schedule", "workflow_dispatch", "push"]).includes(run.event);
}

const fullSelection = ciOutputs(FULL_SCOPE, ALL_OS);
const fullSelections = [fullSelection, moveLinuxIntoStatic(fullSelection)];
const sameSelection = (outputs, selection) => ["build", "jobs", "vitest_os", "packaged_server_os", "vitest_matrix", "linux_lanes"]
  .every((key) => isDeepStrictEqual(outputs[key], selection[key]));

/** A push's selected jobs must prove the same full scope as the nightly run, including relocated Linux lanes. */
export function fullPushPlan(plan) {
  const outputs = plan?.outputs;
  if (plan?.version !== 1 || plan.plan?.full !== true || plan.plan?.candidate !== false
    || plan.plan?.admitted !== false || plan.plan?.reduced !== false
    || !isDeepStrictEqual(plan.plan?.scope, FULL_SCOPE) || outputs?.full_required !== true || outputs.reduced !== false
    || !isDeepStrictEqual(outputs.qa_areas, ["global"])) return false;
  return fullSelections.some((selection) => sameSelection(outputs, selection)
    && isDeepStrictEqual(outputs.expected_jobs, expectedJobs(selection))
    && isDeepStrictEqual(outputs.required_jobs, selection.jobs.filter((id) => MERGE_JOBS.includes(id))));
}

/** A bound, internally consistent narrow plan can be skipped when finding the latest full execution. */
export function narrowPushPlan(plan) {
  const outputs = plan?.outputs;
  if (plan?.version !== 1 || (plan.plan !== null && (plan.plan?.full !== false
    || !Array.isArray(plan.plan?.scope?.areas) || !Array.isArray(plan.plan?.scope?.checks)
    || isDeepStrictEqual(plan.plan?.scope, FULL_SCOPE)))
    || outputs?.full_required !== false || typeof outputs.build !== "boolean"
    || typeof outputs.reduced !== "boolean" || outputs.reduced !== Boolean(plan.plan?.reduced)
    || !Array.isArray(outputs.jobs) || !Array.isArray(outputs.vitest_os) || !Array.isArray(outputs.packaged_server_os)
    || !Array.isArray(outputs.vitest_matrix?.include) || !Array.isArray(outputs.qa_areas) || !outputs.qa_areas.length) return false;
  try {
    return !fullSelections.some((selection) => sameSelection(outputs, selection))
      && isDeepStrictEqual(outputs.expected_jobs, expectedJobs(outputs, false))
      && isDeepStrictEqual(outputs.required_jobs, outputs.jobs.filter((id) => MERGE_JOBS.includes(id)));
  } catch { return false; }
}

export function issueAreas(issue) {
  const areas = issue.labels.map((label) => typeof label === "string" ? label : label.name).filter((label) => label.startsWith("qa:scope:")).map((label) => label.slice(9));
  return areas.length ? areas : ["global"];
}

export function issueLabels(issue) {
  return issue.labels.map((label) => typeof label === "string" ? label : label.name);
}

export function triageOf(issue) {
  const labels = issueLabels(issue);
  const body = issue.body ?? "";
  const due = body.match(/^QA-Due:\s*(.+)$/m)?.[1];
  const owner = body.match(/^QA-Owner:\s*(mausbot-(lead|front|back|upstream))\s*$/m);
  const complete = labels.includes("qa:triaged") && !labels.includes("qa:untriaged")
    && Boolean(owner && labels.includes(`owner:${owner[2]}`)) && Number.isFinite(Date.parse(due))
    && labels.some((label) => /^qa:kind:(?:product|flake|infrastructure)$/.test(label))
    && labels.some((label) => /^qa:scope:(?:global|usage|agents)$/.test(label))
    && labels.some((label) => /^qa:p[012]$/.test(label)) && /^QA-Next:\s*\S/m.test(body);
  return { complete, owner: owner?.[1], due };
}

export function holdsFor(issues, areas, repairIds = []) {
  return issues.filter((issue) => {
    if (repairIds.includes(issue.number)) return false;
    const labels = issueLabels(issue);
    if (labels.includes("qa:process")) return false;
    return labels.includes("qa:p0") || labels.includes("qa:p1") && issueAreas(issue).some((area) => area === "global" || areas.includes("global") || areas.includes(area));
  });
}
