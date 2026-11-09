# MausBot validation

An ordinary PR targets five minutes from run creation, including queue and
setup time. A rerun is measured from its current attempt start; the original
run's age remains diagnostic. Timing, queue age, handoff and follow-up deadlines
are advisory scan criteria. Missing a target creates an optimization case; it
does not fail a quality gate, close a PR, cancel delivery or invalidate a pass. Local feedback and App
delivery are measured separately; this is not a test-count reduction quota.
`MAUSBOT_CI_MODE=shadow` and unadmitted areas remain available for the broader
validation rollout; neither is a prerequisite for the ordinary fast PR gate.

## Developer loop

| Entry point | Boundary |
| --- | --- |
| `pnpm check:plan` | Explain the complete merge-base diff, including staged, unstaged, untracked, deleted and renamed paths; execute no checks |
| `pnpm check:edit` | Changed contract tests and the area's synthetic UI assertions; use `--test path/to/file.test.ts` when no contract is mapped |
| `pnpm check:ready` | Fixed core, affected contracts and policy/docs guards once for the review handoff |
| `git push` | Existing changed-file lint and applicable locale/source guards; do not immediately repeat them manually |
| Review correction | Check the corrected contracts and new risks, then use the normal push hook |

All three commands accept `--base <revision>`; the default is `origin/main`.
For changes under `relay/`, local edit and ready checks run the Relay package's
native `pnpm test` in addition to their selected Vitest files. Relay tests are
listed as deferred by an ordinary PR's fast selector and run in the full
integration, daily and release lanes.
Keep the base current. The current push hook leaves the global typecheck and
suite in CI. Run additional local static checks when the changed contract or
verification recipe requires them, with one recorded owner for each check.
Local receipts live in `.omb-scratch/validation/` and
record the base/head, dirty-source digest, lockfile digest, command, environment,
start/end, counts and outcome. A source change during the command invalidates
its readiness result. They are evidence for that input, never a cache
or a replacement for independent CI. Full escalation concerns merge evidence;
it does not launch a full platform matrix on a developer's laptop.

Targets are 5–30 seconds for ordinary edit feedback and 1–2 minutes for ordinary
local completion. Record a costly required step rather than dropping it to meet
the target. A cold browser or dependency setup is part of the measured cost.

Read this policy from the actual task checkout. Preserve an older dirty
coordination root and inspect `git show origin/main:docs/MAUSBOT-VALIDATION.md`
when its copy is missing. Start new source work from fetched main; do not reset
an active feature branch merely because unrelated main work advances.

When the affected contract requires local type validation, use
`pnpm typecheck --project ui` or `pnpm typecheck --project server`.
The TypeScript compiler always runs and invalidates affected source/imports;
it maintains real incremental state under `.omb-scratch/typecheck/` rather than
reusing a previous success receipt. Each worktree has its own state. CI and
`--fresh` remove the selected compiler state before checking. `pnpm build`
includes the same complete typecheck; do not separately invoke it immediately
before the build. Emitting server/companion builds keep their existing checks.

For new or edited Electron fixture entrypoints, run `pnpm check:fixtures` first.
Electron's ESM entry must finish evaluating before readiness: await
`app.whenReady()` in an invoked async function, never at module scope.
Reuse existing launchers, scope selectors to the feature root, and preserve
bounded startup/load/assertion phases with their failure output. Diagnose the
failed phase once before retrying; retain the failure. Do not increase a global
timeout to hide a launcher error. Keep local acceptance focused on the changed
interaction and critical layout; broader unchanged permutations remain QA work.

Dev records the exact head, local receipt and remaining checks in the PR body,
including `QA-Handoff: <40-character head SHA>`. The queue hands that head to
MausBot Lead only while the marker matches the current head. Updating the
handoff or marking a draft ready does not restart CI. Lead owns CI,
independent review and merging while Dev can take independent work. New pushes
require an updated handoff marker; a chat mention alone is not the handoff record.

Freeze and hand off coherent source as soon as its focused checks pass. Start
independent source review and CI in parallel with remaining isolated rendering
or package acceptance. List each pending check with its owner; pending evidence
cannot be claimed as passed. Source changes require delta review and their
affected checks, while unchanged evidence remains valid. Root and specialists
send nonblocking findings through Lead in one batch, avoiding repeated prompts
and unrelated work on the delivery owner.

## Coverage boundaries

`scripts/ci-scope.mjs` maps the full changed-file diff to contracts. An ordinary
PR uses one cached Ubuntu static/setup path: applicable typecheck, lint, locale
and source guards, the fixed 26-file security/data/dispatch core, and at most
four portable affected test files. The selection artifact and log list
additional affected files deferred to full validation, including browser and
Electron tests and expensive E2E files under `scripts/testing/` and
`server/browser/`. Missing or unsafe required tests fail selection; the bound
does not silently turn a failed test into a skip.

| Change/state | Required evidence |
| --- | --- |
| Ordinary PR | One Ubuntu fast path and the current-head `CI` gate; first attempt includes queue time in its five-minute target |
| Explicit `ci:full`, `qa:repair` or `windows` label | Selected wider checks; this is an exception to the ordinary fast path, never a waiver of holds or review |
| Main integration, daily 05:00 full QA, release | Deferred platform, Electron, browser, full E2E and packaging checks in their applicable lanes; daily/release retain the full set |
| Missing or unreadable controls; applicable P0 or P1 hold | Fail closed or hold the affected merge; do not manufacture a green gate |
| Stale full QA report without an applicable hold | Request shared recovery and restrict optional broader-lane reduction; ordinary fast PR selection remains available |

Sensitive auth, permission, credential, redaction, persistence, dispatch,
driver and native changes still receive the fixed core, affected contracts and
full validation after integration. The path/text guard does not replace review
of semantics. Reviewer may request an explicit wider run with `ci:full`; label
changes start a new run. Shadow timing and area admission do not delay the
ordinary five-minute path or relax current-head and QA-hold checks.

The required `CI` check starts with the workflow and binds its selection
artifact to the run, revision and producing attempt. It waits for the selected
required jobs, rechecks current PR controls and QA holds, and fails on missing,
skipped, cancelled or failed required work. An ordinary fast run that exceeds
five minutes remains pending until its required work completes. Successful
quality checks produce a green gate regardless of elapsed time. The independent
process scan records timing violations, including queue/setup and slow phases.
Actual required failures or incomplete execution still fail; execution safety
timeouts are not the five-minute performance target. Explicit wider runs and post-integration
validation keep their selected platform and specialist jobs. Unreadable
controls fail closed; an unreadable issue list cannot grant an exemption.
Failed-job reruns reuse valid
successful evidence from the same immutable run and revision, with the newest
attempt of each job taking precedence. A pass after an actual failed validation attempt
remains a finding for Lead to classify and cannot verify the incident until a
later clean execution covers it.

## Advisory process scan and PR recovery

`scripts/qa/scan.mjs` records process cases separately from quality results.
The trusted-main `scan` job in `qa-report.yml` runs after PR CI completes; it is
not a required PR check and uses `continue-on-error`. Its
`process-scan.json` reports `passed`, `optimization_needed` or `incomplete`.
The existing ten-minute Lead queue also scans open PRs and recent PR runs;
there is no new scheduler. Scanner outages cannot fail the quality gate or
prevent ordinary QA/PR handoffs.

Cases use only `qa:process`, without `qa`. They are deduplicated by rule and
subject and excluded from QA holds and reduction-health issue classification,
even if another label is accidentally added. Five-minute gate latency,
12-hour observed PR inactivity, 24-hour open PR age, 30-minute triage and repair
due dates are optimization targets. GitHub's update timestamp is an inactivity
indicator; Lead inspects substantive progress rather than treating comments,
labels or empty commits as progress. Local edit/ready receipts already record
over-budget work without failing successful checks.

Lead records the blocker, current owner and next useful action, then assigns
pipeline or fixture improvements to an existing member during available
capacity. Preserve priority feature delivery. Do not close a useful PR, cancel
its pipeline, force rollback, or repeat unchanged review/tests merely to meet a
clock. Missing handoff text calls for completing the handoff, not discarding
work. Actual review findings, source binding, failed required checks and
applicable data/security holds remain quality decisions.

If a procedural rule caused a mistaken closure, record the original PR URL,
branch/head, accepted review and check evidence, closure reason, owner, next
action and recovery condition in a process issue. Reopen the same PR when its
work remains useful and unadopted; retain its original dates and history. If it
already reached main through another PR, link that integration and verify the
source instead of recreating the change. Keep deferred recovery owned and
visible until adoption, demonstrated supersession or an explicit product
cancellation. A clock alone is never a disposition reason.

## Automated QA and Lead rhythm

The existing CI full lane runs on pinned main once daily at **05:00
Asia/Shanghai** (`0 21 * * *` UTC), including unchanged source. PR pushes
cannot cancel it. Root `pnpm test` alone is not a full QA run.

`qa-report.yml` executes trusted main code with issue-write permission, separate
from PR execution. It accepts completed scheduled/manual main runs and main
integration runs, reads result artifacts as data, and records execution
completeness, outcomes and report delivery separately. Report artifacts are
retained for 30 days and raw test results for seven days.

Defects are keyed by contract and platform, not commit. The reporter updates
or reopens an existing issue, preserves triage text, and groups demonstrated
common dependency setup failures. Failed preflight or a workflow with no jobs
has one incident listing dependent jobs. A later complete run must positively
verify every affected job before a shared incident can be marked verified.
Execution order and attempts govern updates; a slow old run cannot overwrite
newer evidence merely by finishing later. A pass after the existing two allowed CI retries remains a
flake. No additional full-suite retry budget is added.

The local ten-minute queue uses the existing `mausbot-lead` Herdr agent. It
submits new QA work, ready PR heads, verification and overdue conditions. Normal
recurrence updates the issue without another wake-up. A durable submission
receipt is not an acknowledgement: Lead acknowledges and triages on the issue
or PR. An ambiguous Herdr submission is retained for inspection, not blindly
retried. Preflight outages before any prompt attempt retry on the next tick.
The schedule requires this Mac and Herdr to be available; CI's coverage
fallback does not depend on them.

Lead targets triage within 30 minutes and sets `qa:triaged`, removes `qa:untriaged`, chooses
`qa:p0`, `qa:p1` or `qa:p2`, selects a `qa:kind:*` and `qa:scope:*`, and records:

```text
QA-Owner: mausbot-back
QA-Next: reproduce in an isolated fixture, fix, and request Reviewer
QA-Due: 2026-11-06T10:00:00+08:00
```

Use the actual assigned role (`mausbot-front`, `mausbot-back`,
`mausbot-upstream` or `mausbot-lead`) and matching `owner:*` label. Role labels
are not GitHub usernames. Lead assigns baseline/infrastructure work to an
existing developer or maintainer; unrelated feature authors do not inherit it.
P0 holds all ordinary merges/releases; P1 holds its area. P2 and flakes remain
owned without holding unrelated work. For a reviewed repair PR, Lead writes
one `QA-Repair: #123` line per hold it repairs before adding `qa:repair`. That
label forces fresh full validation and exempts only those named holds. Shared
GitHub credentials do not provide role-level authorization separation.

Dev fixes, Reviewer reviews, QA verifies the contract without retries after
integration, and Lead closes with that evidence. The reporter sets `qa:verified`
and leaves closure to Lead. Keep priority/owner/next-action/due-date records
current; a `qa:triaged` label by itself is insufficient.

No complete delivered full report within 26 hours restricts future optional
coverage reduction and requests shared recovery. Its age does not invalidate
an already selected run or independently fail the merge gate.
This allows the 24-hour cadence plus a two-hour grace period; report health
and shared execution recovery use the same window.
The queue requests one shared recovery run per failed scheduled cycle, reusing
any in-progress full run. A delivery failure retries reporting from durable
results, without rerunning tests. The queue also backfills coalesced reporter
events since its installation. An unreadable issue list fails the merge gate
because it cannot enforce existing holds.

## Local candidate, merge and release

Every App shown to the user for preview, use or acceptance testing follows the
[playbook's source policy](../.agents/team/playbook.md#local-candidate-delivery):
use a clean checkout of the active repository's latest fetched `origin/main` by
default. Fetch before packaging and recheck main before handoff; do not present
an older or unmerged package as the latest main. Record the repository, exact
main and source SHAs/trees, artifact and validation. An exception still uses a
clean, exact checkout: unmerged PRs or cherry-picks may enter a user-facing App
only when the user explicitly selects that branch or PR, or Lead documents a
strong, concrete necessity. Before the preview, disclose the reason, all
unmerged inclusions, validation and the condition for returning to main. Slow
CI or convenience alone is insufficient.
Requested features absent from main remain pending default delivery.

Developer branch tests and isolated internal diagnostic builds may combine
unmerged commits in a separate worktree; they do not automatically qualify for
user preview. Test the combined source, run applicable static checks and keep
one package owner. Reuse an unchanged artifact only when its source and bytes
are verified. Classify unrelated CI failures with evidence and an owner, but
do not use that classification to relax the user-facing source requirement.
Startup, authorization, data-safety and requested-behavior failures block
acceptance of any App presented to the user.

Compatible ready changes receive one independent review of their final
integrated diff against current main. Accepted unchanged hunks and stable-input
checks carry into composition; a composition commit alone does not trigger a
repeat review, test or build cycle. Recheck actual conflicts, new risks or
findings with focused deltas. Merge still requires independent source acceptance
on the current integrated diff, required green CI for the current head,
current integration evidence and no applicable hold. Release additionally
requires full evidence for its revision or identical tree, signing/native
resources and package/install/update acceptance. Preserve the official App and
real data; use the existing coordinated switch/recovery procedure.

Use the [local runbook](MAUSBOT-LOCAL-RUNBOOK.md) for the read-only
`check:delivery request`, `routines` and `inventory` commands. Request fields and
source binding are checked before spending time on a package. A routine run's
normal recovery state and initial queued-check assignments are separate from
unchanged configuration and established run identity, routing and check authority.
Unrecognized transitions need owner review, not automatic rollback. Only
absent/null `shippedTemplateKind` is normalized in an inventory;
grants, IDs, revisions and every other field remain exact. These checks do not
replace credentials, pairing, signature, package, startup or rollback checks,
and they do not authorize a live switch.

## Rollout and operations

`MAUSBOT_CI_MODE` accepts `legacy`, `shadow` and `tiered`; unset or unknown values
preserve existing broader coverage. The ordinary five-minute PR path does not
wait for area admission or a switch to `tiered`. `legacy` is a broader-coverage
rollback, not a bypass for failed checks or holds. Shadow remains advisory and
does not replace the required current-head gate.

Before enabling an area's optional broader-lane reduction, require a
representative real PR's shadow timing, selector/gate edge-case tests and two
consecutive scheduled reports from two daily cycles, plus a real failure →
issue → triage → assignment →
reviewed fix → verification → closure loop. Manual bootstrap and recovery runs
do not count as scheduled cycles. Classify full-run failures and resolve
selection misses in that area. Do not substitute calendar age or a PR count.
Change admission through reviewed full validation before setting the repository
variable to `tiered`. This pilot does not authorize or delay the ordinary fast
PR gate, and no timing improvement is claimed without measured runs.

Report local feedback time, request-to-first-validated-candidate time, PR gate
latency, eligibility fraction, runner time, queueing, escaped regressions,
retries and triage/repair latency, with sample counts and p50/p95. Include
corrections and retries in the original delivery clock.

The queue entry point is `node scripts/qa/queue.mjs`. It requires
`GITHUB_REPOSITORY`, `MAUSBOT_QA_STATE`, an authenticated `GH_TOKEN` or a JSON argv
prefix in `MAUSBOT_GH_COMMAND`, and optional `MAUSBOT_HERDR` /
`MAUSBOT_HERDR_SESSION` (default `default`). Use the verified personal account
helper on a Mac with multiple GitHub accounts; never store tokens in a plist.
Install one launchd job with a 600-second interval against a pinned checkout.
Preserve the existing upstream sync and activity collectors. Resolve an
uncertain receipt by reading Lead's actual state/output and the issue/PR;
clear its pending entry only after determining whether submission happened.

For report delivery only, dispatch `qa-report.yml` with `run_id`. For a shared
execution recovery, dispatch `ci.yml` on main once after checking existing runs.
Do not delete failure evidence or rerun a matrix just to obtain a green badge.
