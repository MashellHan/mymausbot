const SHA = /^[a-f\d]{40}$/i;
const BRANCH = /^[a-z\d][a-z\d._/-]{0,199}$/i;

export async function currentMerge(request, api) {
  const branch = await api(`/branches/${encodeURIComponent(request.baseRef)}`);
  const base = branch?.commit?.sha;
  if (!SHA.test(base ?? "")) throw new Error("Current PR base ref is unavailable");
  const ref = await api(`/git/ref/pull/${request.number}/merge`);
  if (!SHA.test(ref?.object?.sha ?? "")) throw new Error("Current PR merge ref is unavailable");
  const merge = await api(`/commits/${ref.object.sha}`);
  if (merge?.sha !== ref.object.sha || merge.parents?.length !== 2
    || merge.parents[0]?.sha !== base || merge.parents[1]?.sha !== request.head
    || !SHA.test(merge.commit?.tree?.sha ?? "")) throw new Error("Current PR merge does not match its live base and head");
  return { base, merge };
}

export async function verifyCurrentExecution({ plan, sha, number, head, repository, api }) {
  const { execution, outputs } = plan;
  if (outputs?.pr_number !== number || outputs.pr_head !== head || execution?.head !== head || execution.merge !== sha
    || !SHA.test(execution.base ?? "") || !SHA.test(execution.tree ?? "")) throw new Error("Missing exact PR checkout binding");
  const pr = await api(`/pulls/${number}`);
  const baseRef = pr?.base?.ref;
  if (pr?.state !== "open" || pr.number !== number || pr.head?.sha !== head || pr.base?.repo?.full_name !== repository
    || !BRANCH.test(baseRef ?? "") || baseRef.includes("..")) throw new Error("Current PR identity differs from the CI checkout");
  const live = await currentMerge({ number, baseRef, head }, api);
  if (live.base !== execution.base || live.merge.commit.tree.sha !== execution.tree) throw new Error("PR base or merge tree changed; wait for its current CI run");
}
