import { artifactFiles, fullRunEvidence, github, pages } from "./github.mjs";
import { issueAreas, issueLabels, triageOf } from "./contracts.mjs";

export async function qaHealth({ api = github, readArtifact = artifactFiles, now = Date.now(), repository = process.env.GITHUB_REPOSITORY } = {}) {
  let report;
  try {
    const runs = await api("/actions/workflows/ci.yml/runs?branch=main&per_page=100");
    let run;
    for (const item of runs.workflow_runs) {
      if (item.status !== "completed") continue;
      const evidence = await fullRunEvidence(item, { api, readArtifact, repository, now });
      if (evidence === "unknown") throw new Error(`Main CI run ${item.id} has unclassifiable validation evidence`);
      if (evidence === "full") {
        run = item;
        break;
      }
    }
    if (!run) throw new Error("No completed full main run");
    const { artifacts } = await api("/actions/artifacts?name=mausbot-qa-report&per_page=100");
    for (const artifact of artifacts.filter((item) => !item.expired)) {
      const owner = await api(`/actions/runs/${artifact.workflow_run.id}`);
      if (owner.path !== ".github/workflows/qa-report.yml" || owner.head_branch !== "main" || owner.head_repository?.full_name !== repository
        || !["workflow_run", "workflow_dispatch"].includes(owner.event) || owner.conclusion !== "success") continue;
      const candidate = JSON.parse((await readArtifact(artifact, api))["qa-report.json"]);
      if (candidate.runId === run.id && candidate.attempt === run.run_attempt && candidate.version === 1
        && candidate.sha === run.head_sha && candidate.deliveryComplete === true
        && typeof candidate.executionComplete === "boolean" && Number.isFinite(Date.parse(candidate.finishedAt))
        && Date.parse(candidate.finishedAt) <= now + 60_000) { report = candidate; break; }
    }
    if (!report) throw new Error("Latest full run has no trusted delivered report");
    const age = now - Date.parse(report.finishedAt);
    if (!Number.isFinite(age) || age < -60_000 || age > 14 * 60 * 60 * 1000) throw new Error("Full QA report is older than fourteen hours or has invalid time");
    const issues = (await pages("/issues?state=open&labels=qa", null, api)).filter((issue) => !issue.pull_request);
    const blockedAreas = [...new Set(issues.filter((issue) => !triageOf(issue).complete || issueLabels(issue).some((label) => ["qa:p0", "qa:p1"].includes(label))).flatMap(issueAreas))];
    return { healthy: report.executionComplete, reason: report.executionComplete ? "" : "Full QA execution was incomplete", report, issues, blockedAreas };
  } catch (error) {
    return { healthy: false, reason: error.message, report, issues: [], blockedAreas: ["global"] };
  }
}
