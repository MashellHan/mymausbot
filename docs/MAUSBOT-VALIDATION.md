# MausBot validation

The target is about 80% less PR waiting time, measured separately from local
feedback and delivery of a usable App. It is not a test-count reduction quota.
The initial deployment uses `MAUSBOT_CI_MODE=shadow`; no area is admitted to
reduced coverage in `scripts/testing/check-policy.json`.

## Developer loop

| Entry point | Boundary |
| --- | --- |
| `pnpm check:plan` | Explain the complete merge-base diff, including staged, unstaged, untracked, deleted and renamed paths; execute no checks |
| `pnpm check:edit` | Changed contract tests and the area's synthetic UI assertions; use `--test path/to/file.test.ts` when no contract is mapped |
| `pnpm check:ready` | Fixed core, affected contracts and policy/docs guards once for the review handoff |
| `git push` | Existing changed-file lint and applicable locale/source guards; do not immediately repeat them manually |
| Review correction | Check the corrected contracts and new risks, then use the normal push hook |

All three commands accept `--base <revision>`; the default is `origin/main`.
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

Dev records the exact head, local receipt and remaining checks in the PR body,
including `QA-Handoff: <40-character head SHA>`. The queue hands that head to
MausBot Lead only while the marker matches the current head. Updating the
handoff or marking a draft ready does not restart CI. Lead owns CI,
independent review and merging while Dev can take independent work. New pushes
require an updated handoff marker; a chat mention alone is not the handoff record.

## Coverage boundaries

`scripts/ci-scope.mjs` is the shared selector. CI reads the base revision's
policy before considering reduction. A policy change forces full validation;
a missing or invalid required test cannot pass selection. The two candidate
areas are Usage presentation and Agent Team presentation, with exact source
and contract lists in the manifest. The UI assertions use isolated fixtures at
360, 400 and 960 pixels, in English and Chinese.

| Change/state | Merge evidence |
| --- | --- |
| Docs only | Existing static and docs/reference checks |
| Admitted, fully mapped presentation change with healthy QA | Static, fixed core, affected contracts and fixture assertions |
| Known area outside the admitted mapping, including a new file | Existing broader checks for that area |
| Sensitive paths/changed lines, CI/policy/dependency/toolchain changes, unknown scope or broad integration | Full validation, including platform and specialist jobs |
| Missing, stale, incomplete or unreadable QA report; affected untriaged failure | Disable reduction and retain broader checks |

Changed code involving auth, permissions, credentials, redaction, persistence,
shared contracts, lifecycle, drivers or native behavior requires full relevant
validation even inside a presentation file. The conservative path/text guard
does not replace review of semantics. Reviewer adds `ci:full` for uncertain
impact; adding/removing that label starts a new CI run. A label never waives
coverage. Ordinary tiered main pushes keep core plus packaged-server startup;
legacy/shadow main pushes retain the existing checks.

The required check remains `CI` and is queued when the workflow starts, so a
fresh full request cannot reuse the previous green check while its jobs wait.
It binds the selection artifact to that run, revision and preflight attempt, then
waits for all required jobs through the Actions API. Missing, skipped,
cancelled or failed required jobs cannot pass. Full-required runs also require
every selected platform and specialist job; deployments are excluded. The gate
rechecks current PR controls, QA holds and reduced-coverage eligibility before
returning green. If controls or health changed during the run, rerun CI with
the required broader coverage. Unreadable current PR controls force full
selection and grant no repair exemption; unreadable gate controls fail closed.
Failed-jobs reruns reuse successful evidence from the same immutable run and
revision, while the newest attempt of each job takes precedence. Expired plans
or changed coverage requirements fail promptly with an actionable rerun request.
A pass after a failed workflow attempt remains a finding for Lead to classify
and cannot verify the incident until a later clean execution covers it.

## Automated QA and Lead rhythm

The existing CI full lane runs on pinned main twice daily at **10:17 and 22:17
Asia/Shanghai** (`17 2,14 * * *` UTC), including unchanged source. PR pushes
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

Within 30 minutes Lead sets `qa:triaged`, removes `qa:untriaged`, chooses
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

No complete delivered full report within 14 hours disables reduced coverage.
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

Merge still requires current-head independent review, required green CI,
current integration evidence and no applicable hold. Release additionally
requires full evidence for its revision or identical tree, signing/native
resources and package/install/update acceptance. Preserve the official App and
real data; use the existing coordinated switch/recovery procedure.

## Rollout and operations

`MAUSBOT_CI_MODE` accepts `legacy`, `shadow` and `tiered`; unset or unknown values
preserve existing coverage. `legacy` is the coverage rollback, not a bypass for
failed checks, holds or full requests. Shadow runs the proposed core on candidate
PRs as a separate advisory timing job while keeping the existing merge gate.

Before setting an area's `admitted` flag, require a representative real PR's
shadow timing, selector/gate edge-case tests, two consecutive scheduled reports
covering both slots, and a real failure → issue → triage → assignment → reviewed
fix → verification → closure loop. Classify full-run failures and resolve
selection misses in that area. Do not substitute calendar age or a PR count.
Change admission through a reviewed full-validation PR, then set the repository
variable to `tiered`. No 80% improvement is claimed merely by installing this.

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
