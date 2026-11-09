import { issueAreas, issueLabels } from "./contracts.mjs";

const marker = /^<!-- mausbot-qa-group (.+) -->$/gm;
const statusBlock = /<!-- mausbot-qa-group-status:start -->[\s\S]*?<!-- mausbot-qa-group-status:end -->/;
const priority = (issue) => Math.min(3, ...issueLabels(issue).filter((label) => /^qa:p[012]$/.test(label)).map((label) => Number(label.at(-1))));

export function qaGroups(issues) {
  const groups = [], byKey = new Map(), memberNumbers = new Set();
  for (const parent of issues.filter((issue) => issue.body?.includes("<!-- mausbot-qa-group "))) {
    const matches = [...parent.body.matchAll(marker)];
    if (matches.length !== 1 || issueLabels(parent).includes("qa:process")) throw new Error(`Invalid QA group #${parent.number}`);
    const keys = JSON.parse(matches[0][1]);
    if (!Array.isArray(keys) || keys.length < 2 || keys.length > 500 || new Set(keys).size !== keys.length
      || keys.some((key) => typeof key !== "string" || !/^[a-f\d]{24}$/.test(key))) throw new Error(`Invalid QA group members #${parent.number}`);
    const members = keys.map((key) => {
      const candidates = issues.filter((issue) => issue.body?.includes(`<!-- mausbot-qa:${key} -->`));
      if (candidates.length !== 1 || byKey.has(key)) throw new Error(`Missing or ambiguous QA group member ${key}`);
      const member = candidates[0];
      const markers = [...member.body.matchAll(/<!-- mausbot-qa:([a-f\d]{24}) -->/g)];
      const states = [...member.body.matchAll(/<!-- mausbot-qa-state (.+) -->/g)];
      if (memberNumbers.has(member.number) || markers.length !== 1 || markers[0][1] !== key
        || states.length !== 1 || JSON.parse(states[0][1])?.key !== key) throw new Error(`Ambiguous QA group member #${member.number}`);
      if (member === parent || issueLabels(member).includes("qa:process") || priority(parent) > priority(member)
        || !issueAreas(parent).includes("global") && issueAreas(member).some((area) => !issueAreas(parent).includes(area))) {
        throw new Error(`QA group #${parent.number} does not retain member #${member.number}'s priority and scope`);
      }
      memberNumbers.add(member.number);
      byKey.set(key, parent);
      return member;
    });
    groups.push({ parent, keys, members });
  }
  return { groups, byKey };
}

export async function refreshQaGroups(groups, changedKeys, report, api) {
  for (const { parent, keys, members } of groups) {
    const direct = JSON.parse(parent.body.match(/<!-- mausbot-qa-state (.+) -->/)?.[1] ?? "null");
    if (!keys.some((key) => changedKeys.has(key)) && !changedKeys.has(direct?.key)) continue;
    const verified = members.filter((issue) => issueLabels(issue).includes("qa:verified"));
    const complete = verified.length === members.length && (!direct?.caseKeys || direct.verified === true);
    const previousLabels = issueLabels(parent);
    const recurrence = !complete && (parent.state === "closed" || previousLabels.includes("qa:verified"));
    let labels = previousLabels.filter((label) => label !== "qa:verified");
    if (complete) labels.push("qa:verified");
    else if (recurrence) {
      labels = [...new Set([...labels.filter((label) => label !== "qa:triaged"), "qa:untriaged"])];
    }
    const previous = JSON.parse(parent.body.match(/<!-- mausbot-qa-group-report (.+) -->/)?.[1] ?? "null");
    const source = previous && (previous.runId > report.runId || previous.runId === report.runId && previous.attempt > report.attempt)
      ? previous : { runId: report.runId, attempt: report.attempt, sha: report.sha, url: report.url };
    const latest = { ...source, triageEpoch: recurrence ? report.finishedAt : previous?.triageEpoch ?? parent.created_at ?? report.finishedAt };
    const summary = ["<!-- mausbot-qa-group-status:start -->",
      `<!-- mausbot-qa-group-report ${JSON.stringify(latest)} -->`,
      `Verified member cases: ${verified.length}/${members.length}. Pending cases remain tracked by this issue.`,
      `Latest contributing report: ${latest.url} (revision \`${latest.sha}\`, attempt ${latest.attempt}).`,
      complete ? "All member cases have positive execution evidence. Lead must review integrated fix evidence before closure."
        : "Consolidating member issues does not resolve or waive their failures. Review new failures and retain each platform's evidence.",
      "<!-- mausbot-qa-group-status:end -->"].join("\n\n");
    const body = statusBlock.test(parent.body) ? parent.body.replace(statusBlock, summary) : `${parent.body}\n\n${summary}`;
    const patch = { body, labels, ...(!complete ? { state: "open" } : {}) };
    await api(`/issues/${parent.number}`, { method: "PATCH", body: patch });
    Object.assign(parent, patch);
  }
}
