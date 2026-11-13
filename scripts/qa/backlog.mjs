import { issueLabels, triageOf } from "./contracts.mjs";

const DAY_MS = 24 * 60 * 60_000;
const CADENCE_MS = 6 * 60 * 60_000;

export function beijingDay(now) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(now));
}

export function backlogSlot(now) {
  return Math.floor((now + 8 * 60 * 60_000) / CADENCE_MS);
}

function safe(value, limit = 120) {
  return [...String(value ?? "")].map((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char)
    .join("").replace(/\s+/g, " ").trim().slice(0, limit);
}

function field(body, name) {
  return body?.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1];
}

function linkedRepair(issue, prs) {
  return prs.find((pr) => new RegExp(`^QA-Repair:\\s*#${issue.number}\\s*$`, "m").test(pr.body ?? ""));
}

function observe(issue, prs, previous, now) {
  const labels = issueLabels(issue);
  const qa = labels.includes("qa") && !labels.includes("qa:process");
  const process = labels.includes("qa:process");
  const paused = labels.some((label) => /(?:^|:)paused?$|^status:on-hold$/.test(label));
  const triage = qa ? triageOf(issue) : {};
  const owner = triage.owner ?? field(issue.body, "QA-Owner") ?? "unassigned";
  const next = field(issue.body, "QA-Next");
  const blocker = field(issue.body, "QA-Blocker");
  const evidence = field(issue.body, "QA-Evidence");
  const repair = qa ? linkedRepair(issue, prs) : undefined;
  const verified = labels.includes("qa:verified");
  const review = repair && !repair.draft && repair.body?.match(/^QA-Handoff:\s*([a-f0-9]{40})\s*$/m)?.[1] === repair.head?.sha;
  const stage = !qa && !process || paused ? "disposition_needed"
    : verified ? "verification" : review ? "review" : repair ? "fixing" : triage.complete ? "assigned" : "unassigned";
  const signature = JSON.stringify([stage, owner, next, blocker, evidence, repair?.number, repair?.head?.sha, verified]);
  const firstSeenAt = previous?.firstSeenAt ?? issue.created_at ?? new Date(now).toISOString();
  const lastProgressAt = previous?.signature === signature ? previous.lastProgressAt
    : previous ? new Date(now).toISOString() : firstSeenAt;
  const age = now - Date.parse(issue.created_at ?? firstSeenAt);
  const progressAge = now - Date.parse(lastProgressAt);
  const stale = Number.isFinite(age) && age >= 48 * 60 * 60_000
    && (previous ? progressAge >= DAY_MS : true);
  const priority = verified ? 0 : qa && !triage.complete ? 1 : qa && stale ? 2 : process ? 3 : qa ? 4 : 5;
  const action = stage === "disposition_needed" ? "request explicit disposition; do not resume paused or product work"
    : stage === "verification" ? "review exact integrated evidence for closure"
    : stage === "review" ? "finish existing review and verification"
    : stage === "fixing" ? "follow up with existing repair owner"
    : stage === "unassigned" ? "triage and assign an existing owner" : "check evidence and next action with existing owner";
  return {
    number: issue.number, url: issue.html_url, qa, process, paused, verified, stale, priority, stage,
    firstSeenAt, lastProgressAt, signature, lastNotifiedAt: previous?.lastNotifiedAt,
    owner: safe(owner), next: safe(next), blocker: safe(blocker), evidence: safe(evidence),
    repair: repair && { number: repair.number, head: repair.head?.sha, draft: repair.draft },
    action,
  };
}

function order(a, b) {
  return a.priority - b.priority || (a.lastNotifiedAt ? Date.parse(a.lastNotifiedAt) : 0) - (b.lastNotifiedAt ? Date.parse(b.lastNotifiedAt) : 0)
    || Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt) || a.number - b.number;
}

function line(item) {
  const proof = item.evidence || item.blocker || "no evidence/blocker recorded";
  return `#${item.number} ${safe(item.url)}: ${item.action}; stage=${item.stage}; owner=${item.owner}; QA-Next=${item.next || "unrecorded"}; evidence/blocker=${proof}${item.repair ? `; existing PR #${item.repair.number}` : ""}`;
}

export function planBacklog(issues, prs, records = {}, now = Date.now(), { daily = true, followup = true } = {}) {
  const open = issues.filter((issue) => !issue.pull_request && issue.state !== "closed");
  const observed = open.map((issue) => observe(issue, prs, records[issue.number], now));
  const inventory = {
    at: new Date(now).toISOString(), day: beijingDay(now), total: observed.length,
    qa: observed.filter((item) => item.qa).length, process: observed.filter((item) => item.process).length,
    other: observed.filter((item) => !item.qa && !item.process).length,
    verified: observed.filter((item) => item.verified).length,
    paused: observed.filter((item) => item.paused).length,
  };
  const eligible = observed.filter((item) => item.stage !== "closed").sort(order);
  const qa = eligible.filter((item) => item.qa);
  const process = eligible.filter((item) => item.process);
  const other = eligible.filter((item) => !item.qa && !item.process);
  const reservedProcess = process.slice(0, 2);
  const reserved = [...reservedProcess, ...other.slice(0, 3 - reservedProcess.length)];
  const selectedDaily = daily ? [...qa.slice(0, 5), ...reserved,
    ...eligible.filter((item) => !qa.slice(0, 5).includes(item) && !reserved.includes(item))].slice(0, 8) : [];
  const dailyIds = new Set(selectedDaily.map((item) => item.number));
  const selectedFollowup = followup ? eligible.filter((item) => !dailyIds.has(item.number)
    && (item.qa || item.process) && (item.verified || item.stage === "unassigned" || item.stale)).slice(0, 6) : [];
  const items = [];
  if (daily) items.push({ key: `backlog:daily:${inventory.day}`, kind: "daily", selected: selectedDaily,
    text: `Beijing daily open backlog ${inventory.day}: ${inventory.total} open (${inventory.qa} QA, ${inventory.process} process, ${inventory.other} other; ${inventory.verified} verified, ${inventory.paused} paused). Review all-open inventory; selected ${selectedDaily.length} for bounded action, ${inventory.total - selectedDaily.length} deferred. Preserve current owners and existing repairs.\n${selectedDaily.map(line).join("\n")}` });
  if (followup && selectedFollowup.length) items.push({ key: `backlog:followup:${backlogSlot(now)}`, kind: "followup", selected: selectedFollowup,
    text: `Unresolved work follow-up, six-hour cadence: ${selectedFollowup.length} selected. Prompt delivery is not completion; record assignment, repair, review/verification or evidence-backed disposition on each original item.\n${selectedFollowup.map(line).join("\n")}` });
  return { inventory, observed, items };
}
