import { artifactFiles, github, pages } from "./github.mjs";
import { eligibleRun, issueAreas, issueLabels, triageOf } from "./contracts.mjs";

export async function qaHealth({ api = github, readArtifact = artifactFiles, now = Date.now(), repository = process.env.GITHUB_REPOSITORY } = {}) {
  let report;
  try {
    const runs = await api("/actions/workflows/ci.yml/runs?branch=main&per_page=100");
    const run = runs.workflow_runs.find((item) => eligibleRun(item, repository) && item.status === "completed");
    if (!run) throw new Error("No completed full main run");
    const { artifacts } = await api("/actions/artifacts?name=mausbot-qa-report&per_page=100");
    for (const artifact of artifacts.filter((item) => !item.expired)) {
      const owner = await api(`/actions/runs/${artifact.workflow_run.id}`);
      if (owner.path !== ".github/workflows/qa-report.yml" || owner.head_branch !== "main" || owner.head_repository?.full_name !== repository
        || !["workflow_run", "workflow_dispatch"].includes(owner.event) || owner.conclusion !== "success") continue;
      const candidate = JSON.parse((await readArtifact(artifact, api))["qa-report.json"]);
      if (candidate.runId === run.id && candidate.attempt === run.run_attempt) { report = candidate; break; }
    }
    if (!report || report.version !== 1 || report.sha !== run.head_sha || !report.deliveryComplete) throw new Error("Latest full run has no trusted delivered report");
    const age = now - Date.parse(report.finishedAt);
    if (!Number.isFinite(age) || age < -60_000 || age > 14 * 60 * 60 * 1000) throw new Error("Full QA report is older than fourteen hours or has invalid time");
    const issues = (await pages("/issues?state=open&labels=qa", null, api)).filter((issue) => !issue.pull_request);
    const blockedAreas = [...new Set(issues.filter((issue) => !triageOf(issue).complete || issueLabels(issue).some((label) => ["qa:p0", "qa:p1"].includes(label))).flatMap(issueAreas))];
    return { healthy: report.executionComplete, reason: report.executionComplete ? "" : "Full QA execution was incomplete", report, issues, blockedAreas };
  } catch (error) {
    return { healthy: false, reason: error.message, report, issues: [], blockedAreas: ["global"] };
  }
}
