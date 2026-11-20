const SHA = /^[a-f\d]{40}$/i;
const MAIN_EVENTS = ["push", "schedule", "workflow_dispatch"];

export const MAIN_EVIDENCE_QUERY = "/actions/workflows/ci.yml/runs?branch=main&status=success&per_page=100";
export const MAIN_HISTORY_LIMIT = 101;

export function integrationRange({ before, after, checkout, history, runs, repository, runId }) {
  if (![before, after, checkout].every((sha) => SHA.test(sha ?? "")) || /^0+$/.test(before) || checkout !== after
    || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("Invalid main push revisions");
  if (!Array.isArray(history) || history[0] !== after || history.length > MAIN_HISTORY_LIMIT || history.some((sha) => !SHA.test(sha))) {
    throw new Error("Invalid first-parent main history");
  }
  const previous = history.indexOf(before);
  if (previous < 1) throw new Error("Main push before commit is outside its bounded first-parent history");
  if (!Array.isArray(runs) || runs.length > 100) throw new Error("Invalid main CI evidence list");
  for (let index = previous; index < history.length; index++) {
    const base = history[index];
    const evidence = runs.filter((run) => run.head_sha === base && run.path === ".github/workflows/ci.yml"
      && run.head_branch === "main" && run.head_repository?.full_name === repository
      && MAIN_EVENTS.includes(run.event) && run.status === "completed" && run.conclusion === "success"
      && Number.isSafeInteger(run.id) && run.id > 0 && run.id !== runId && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0)
      .sort((a, b) => b.id - a.id)[0];
    if (evidence) return { base, head: after, pushBefore: before, baselineRunId: evidence.id, baselineAttempt: evidence.run_attempt,
      cumulative: history.slice(1, index).reverse() };
  }
  throw new Error("No trusted green main CI baseline in the bounded history; run the existing full main lane to establish one");
}

export function validIntegration(integration, head) {
  const { base, pushBefore, baselineRunId, baselineAttempt, cumulative } = integration ?? {};
  return [base, head, pushBefore].every((sha) => SHA.test(sha ?? "")) && head === integration?.head && base !== head && pushBefore !== head
    && Number.isSafeInteger(baselineRunId) && baselineRunId > 0 && Number.isSafeInteger(baselineAttempt) && baselineAttempt > 0
    && Array.isArray(cumulative) && cumulative.length < MAIN_HISTORY_LIMIT - 1 && new Set(cumulative).size === cumulative.length
    && cumulative.every((sha) => SHA.test(sha) && sha !== base && sha !== head)
    && (pushBefore === base || cumulative.includes(pushBefore));
}
