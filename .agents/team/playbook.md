# MausBot development team

The user is 大雄 (menha). This dedicated Herdr team develops the standalone
personal repository `MashellHan/mymausbot` (`fork=false`) in
`/Users/mengxionghan/workspace/OpenMausBot`. `origin` targets this repository;
`upstream` remains the read-only `milind-soni/OpenMausBot` repository.
`legacy-fork` names the old `MashellHan/openmausbot` repository and its historical
PR, issue, review and CI records. Preserve upstream license and notices.

## Roles

| Herdr name | Role | Model | Effort | Context requested |
| --- | --- | --- | --- | --- |
| mausbot-lead | Lead | gpt-6-astra | max | provider default |
| mausbot-design | Designer | gpt-6-sol | xhigh | 1,000,000 |
| mausbot-front | Frontend | gpt-6-sol | xhigh | 1,000,000 |
| mausbot-back | Backend | gpt-6-sol | xhigh | 1,000,000 |
| mausbot-upstream | Upstream integration | gpt-6-sol | xhigh | 1,000,000 |
| mausbot-review | Reviewer | gpt-6-astra | max | provider default |

Launch arguments are in each role file; verify live session settings before
claiming the model is active. A requested context ceiling is not proof the
provider permits that entire context. Surface errors rather than downgrade.
The Sol launch explicitly uses `service_tier="default"`: the implicit priority
tier failed with `service_tier is not supported` on this installation, while
the explicit default tier was verified by real tool-using responses from all
four Sol members. Keep that local compatibility setting when restarting them.

Use the Herdr skill for Herdr operations,
with `--session default` and explicit names/IDs. Work in the MausBot workspace;
do not modify or close another team's panes. Keep focus unchanged.
The lead owns scope, task sequencing, integration and acceptance. Specialists
report to the lead; no parallel edits to the same file. Use isolated worktrees
for code PRs, rooted beside this project under the user's workspace.

Read the validation policy and role from that task checkout. An older dirty
coordination root may lack new commands or policy files; read the fetched
`origin/main` versions instead of reverting to historical instructions.
Root routes nonblocking feedback through Lead. Lead batches actionable changes
for the owning developer at a safe source boundary; do not repeat the same
instruction from multiple coordinators. Interrupt only for a concrete blocker
or data/security risk. Cleanup and unrelated QA retain separate owners.

## Authorized work, in order

1. Complete the arm64 packaged app build and open the locally built App, keeping
   the official `/Applications/OpenMausBot.app`, real user data and paired-device
   state. Verify in an isolated fixture before switching. Ask no repeat approval
   for the already requested switch. A screen action must use the mounted app
   tools; coordinate the switch with 头号狗腿, which has those tools. Do not
   bypass a refusal or kill the running chat app before arranging recovery.
2. Add **Agent Team** after **Files** in the right-hand panel. Show the real local
   Herdr teams, team count, per-team agent count, each agent's actual model,
   state and latest task when available. Team groups start collapsed and expand
   independently with keyboard-accessible controls. Inspect the existing panel:
   if Files is nested, preserve its context and put the new peer tab in the
   corresponding right panel rather than inventing a navigation hierarchy.
   Reference `/Users/mengxionghan/workspace/whatsmyagentdoing/public/member-ui.js`,
   `public/team-office.css` and `src/herdr.js`. Reuse the idea, not a second app.
3. Add a peer **Usage** tab: PR, commit and token totals for the latest 1, 7 and
   30 days, then trends. Default to the user's China time. Reuse verified Agent
   Town collection definitions and local aggregate data, with a five-minute refresh.
   Read `docs/ACTIVITY-MONITOR.md` and `scripts/activity-monitor.py` in that
   project first. Never publish raw conversations, credentials or repo lists.
   Missing/offline data is unavailable or stale, never fabricated zero.
   The initial dashboard covers the user's existing activity aggregate sources,
   not only activity inside this newly forked repo. Label the window and coverage.
   Include the capture day's partial data through the aggregate timestamp plus
   the preceding 0/6/29 China calendar days. Derive these windows and their
   matching 30-day trend from daily rows; preserve the collector's own totals.
4. Improve **Section classification and search** through the existing sidebar
   sections and picker. Inspect current behavior before adding code. Sections
   are departments and can affect Chief authority, shared context and computer
   access; sidebar organization must not silently expand those permissions.
5. Improve **message quoting and intent** through the existing ReplyAction,
   composer preview, persisted replyToId and promptWithReply. Make the entry
   point discoverable and fix demonstrated gaps without a second quote system.
   Verify direct chat, append while busy, retry and refresh persistence with
   isolated fixtures, preserving the original access boundaries.

Independent design/data reconnaissance may proceed while task 1 finishes;
feature integration and acceptance follow the order above. The existing build
job is already running: adopt its outputs, do not launch a duplicate build.
Job files live under the current conversation's `mausbot-local-build-20261103`.

## Engineering and review

Follow `CONTRIBUTING-FORK.md`. Keep a factual, short project runbook for build
commands and incident recovery. No secrets in commits, prompts or artifacts.
All PR titles, descriptions and comments must be entirely in English, with no
Chinese text. Code comments must also be in English. Keep actual conversation,
task and automation identifiers in local handoff records, not public documents.
Respect upstream AGENTS.md, required hooks/checks and verification fixtures.
Consult the github-accounts skill for identity and repository-specific auth.
Verify `origin` points to `MashellHan/mymausbot`; push feature branches and PRs
only there. Never push to read-only `upstream` or historical `legacy-fork`. Map
old PR and issue numbers through the authoritative migration mapping before
citing their new counterparts.
The user requested commit/PR history. Preserve intermediate meaningful commits;
do not manufacture commit counts, force-push others' work or bypass checks.

Lead sends compatible ready changes for one focused independent review of the
final integrated diff against current main, with exact head, scope and
validation. Review may run alongside independent next work. Carry accepted
unchanged hunks and checks on stable inputs. A composition commit alone does
not trigger another review, test or build cycle; recheck only actual conflicts,
new risks or findings with focused deltas. Required current-head CI and source
acceptance still gate merging. The user has authorized reviewed merges into the
personal repository.
Lead decides merge order and merges only after Reviewer has no unresolved
findings and required checks pass. Creating and pushing reviewable PRs is
authorized here.
Never equate a green badge or an idle agent with completed work.

Lead owns disposition of every open PR, including drafts. Inspect the queue at
existing handoffs and queue touchpoints. Twelve hours without observed activity
and twenty-four hours open are advisory scan targets, not closure deadlines.
Inspect real review/fix/CI progress; status-only comments, labels, empty commits
and draft toggles do not establish it. Record a blocker, owner and next action
and retain useful work, even when review, CI or priority delivery takes longer.
Never close, cancel, roll back or rerun solely because a process clock elapsed.
Close only for a substantive disposition such as demonstrated supersession or
an explicit product cancellation, with source/evidence and successor recorded.

A mistaken procedural closure is a process incident. Keep its original PR,
branch/head, accepted reviews/checks, closure reason, recovery owner and next
step. Reopen useful unadopted work on the same PR; link verified main adoption
when another PR already carried it. Assign pipeline/fixture improvements at
available capacity and follow deferred recovery through adoption or an explicit
resolution. Original dates remain diagnostic; reopening does not grant a test
waiver or require extra checks merely to reset a clock.

Freeze a coherent candidate after focused contract checks. Send its immutable
commit, available evidence and explicitly pending UI/package checks immediately;
source review and CI can start while those checks finish. Do not wait for all
screenshots or a package to begin source review. Pending acceptance still blocks
the corresponding delivery. Batch corrections and review only their delta.

## Development and verification

Local Accessibility, Screen Recording and CUA driver readiness are prerequisites
for the screen operations that need them. They are not prerequisites for source
development, Git operations, upstream integration, PR preparation, independent
source review or an otherwise eligible merge. Keep CLI, API and isolated
headless checks moving when native screen verification is unavailable. Actual
screen calls still require their existing permission, consent and access checks;
do not silently switch computers or grant access to continue a task.

Report these dimensions separately in the existing PR and handoff records:

| Dimension | Report |
| --- | --- |
| Development | In progress or complete, bound to the exact commit |
| Verification | Passed and failed checks; checks not run, their environmental blocker, owner and next action |
| Integration | Unpublished, open PR or merged, with the PR and merge commit |

For example, source can be complete and merged while native UI verification is
not run because screen permissions are unavailable. Keep that work explicitly
pending verification; neither a completed implementation nor a merge proves
the unrun checks passed. Do not label an environmental precondition as a tested
product failure or abandon development because it is unavailable.

Lead keeps the original source owner on unfinished development and assigns
pending verification to an existing responsible role or QA. Preserve the same
batch, branch and evidence when verification resumes. An unavailable local
screen check alone does not impose a merge hold; unresolved source findings,
required failed CI and applicable QA holds retain their existing merge rules.
Acceptance of the affected screen behavior remains pending until verified.

## Local candidate delivery

Every App shown to the user for preview, use or acceptance testing defaults to
a clean checkout of the active personal repository's latest fetched `origin/main`.
Fetch before packaging and record the exact main commit and source tree. Recheck
main before handoff; if it advanced, refresh and validate the candidate instead
of presenting an old package as the latest main. A local branch named `main`
does not establish this provenance. Do not silently include unmerged PRs,
cherry-picks, dirty source patches or packages built from another branch.

An exception requires the user's explicit selection of that branch or PR, or
Lead's documented strong, concrete necessity. The exception source must also
be a clean, exact checkout. Before showing the App, disclose the reason, exact
source and main SHAs, every included unmerged PR or commit, validation results
and the condition for returning to main. Slow CI or delivery convenience alone
is insufficient. Lead and Reviewer verify this boundary; an exception does not
waive applicable tests or review. Requested features still
confined to unmerged PRs remain pending in the default main-based delivery.

Developer branch tests and isolated internal diagnostic builds may combine
pinned commits in a separate worktree. They do not automatically qualify as an
App to show the user. Test the combined source: individual PR tests do not prove
its integration. Incomplete PR CI or merges may coexist with internal diagnostics,
not with an undisclosed user-facing candidate.

For a user-facing App, run affected functional/integration checks and applicable
static checks on the exact source, then one package build and isolated startup
acceptance. Include package/resource checks needed by the changed behavior.
Demonstrate the requested user action in an isolated fixture; startup alone is
not feature acceptance. Reuse identical evidence and checks already performed
by the build; do not remove required build checks or bypass push hooks. Changed
source may require a new artifact.

Run inexpensive lint and repository guards before handing off for review or
starting a package build, so file-size and declaration failures do not arrive
after acceptance. Assign each check one owner and reuse its result for unchanged
inputs. For a local arm64 build, reuse verified dependency/resource caches and
unchanged build outputs; rebuild only the outputs whose inputs changed. Record
stage durations in the existing build log instead of adding a separate audit.

Use the shared `check:delivery` preflight and preservation commands in the local
runbook. Do not recreate the routine-state and Mini App inventory comparators
inside each private job. Validate the build request before starting compilation.
Use `pnpm typecheck` when a local static check is required; the compiler maintains
separate UI/server incremental state within this worktree. `pnpm build` includes
that check, so do not add another prerequisite invocation. CI starts it fresh.
Reuse existing Electron fixture launchers and run `pnpm check:fixtures` before
executing changes to them; a launcher failure calls for one bounded correction,
not an unchanged retry or a larger global timeout.

Classify remote CI failures with a run link, evidence and follow-up owner.
Unrelated CI debt does not change the required source for user preview. Age
alone does not establish irrelevance. Failures affecting startup, authorization,
data safety or the requested behavior block candidate acceptance even if preexisting.
Investigate uncertain relevance with a focused check before declaring it unrelated.

Use the existing private build/handoff records to report the repository, exact
source SHA/tree, fetched main SHA, App artifact, validation and any disclosed
exception alongside pending/failed remote checks.
Internal candidate readiness or a disclosed exception does not establish merge
or release readiness, or completion of all outcomes in
feature-delivery-ready.json. Lead follows PRs through required CI and independent
review while internal diagnostics or a disclosed exception proceed. Verify with
isolated fixtures; preserve the official App and real data, and follow the
existing coordinated procedure for an actual App switch.

## Testing and QA rhythm

Follow [the validation mechanism](../../docs/MAUSBOT-VALIDATION.md). Use
check:plan, check:edit and check:ready for the small local loop; retain normal
push hooks and avoid repeating identical checks immediately before them.
An ordinary PR targets five minutes from run creation, including queue time; a rerun uses its current attempt start, with the original
age kept as diagnostic. One cached Ubuntu static/setup path retains typecheck,
lint and source guards, then runs the 26-file security/data/dispatch core and
at most four portable affected files. Record deferred affected files, including
expensive browser and Electron tests. The `ci:full`, `qa:repair` and `windows`
labels request full macOS checks; `windows` is a legacy request name and
selects no Windows test runner. Full validation uses four macOS all-E2E shards
and macOS specialist jobs, collecting portable contracts previously covered on
Ubuntu. Windows/Ubuntu full tests and platform smokes are retired; platform
build/resource/signing/publication integrity checks retain their own boundaries.
Electron unit checks precede the long Vitest block, and broker tests run once
in the control-plane job. Long checks belong to the applicable post-integration,
daily 05:00 and release lanes. Actual failed required work remains a quality incident. Timing overruns and
other process targets are advisory scan cases; successful validation remains
green. Use the independent process scan and existing Lead queue, without
blocking merges or delivery on process metadata or elapsed time. Current-head
review and actual QA holds still control merging.
Dev leaves a durable PR-body handoff with `QA-Handoff: <current head SHA>`.
The existing Lead owns review and CI follow-through while local delivery and
independent development continue.

The automated QA runner is the existing CI full lane, once daily at 05:00
Asia/Shanghai, using the full macOS selection. It does not need another
persistent model. Its trusted reporter records the selected platform policy and
files deduplicated issues;
the hourly queue hands actionable work to mausbot-lead. Lead acknowledges,
targets triage within thirty minutes, assigns an existing developer/maintainer and sets
priority, scope, classification, next action and due date. Reviewer reviews fixes;
QA verifies after integration; Lead closes with evidence. Retiring a platform
does not verify its old failures. Refresh the existing pinned hourly queue to
the accepted merged QA contracts without changing its cadence or state. Read
the mechanism for hold/repair boundaries and rollback. Shadow mode preserves existing checks;
admission requires the documented pilot evidence.

## Upstream integration

The user's assistant owns the existing daily 00:00 Asia/Shanghai schedule;
do not create another scheduler. The upstream developer works in an isolated
worktree, checks existing sync branches and PRs, and compares fetched
`upstream/main` with `origin/main` before integrating. Record exact source SHAs,
the new upstream range, the integrated commit and tree, resolutions, and checks.
When there are no new commits or pending integration changes, record the check
without an empty commit or PR.

Preserve the fork's Agent Team, Usage, sections and quoted reply behavior, user
data, pairing, and access boundaries. Review both sides of any conflict. Send
the exact ready commit and validation to Reviewer; Lead makes the merge decision
under the review rule above. Daily sync does not automatically replace the live
App.

## Design and verification

Designer follows `/Users/mengxionghan/.codex/skills/impeccable/SKILL.md` and
the incumbent MausBot component/token system. These are additions to an
established interface, not a redesign. The requested structure is settled;
choose sensible detail defaults without another approval round.
No live data mutation for tests. Use `docs/verification/README.md` fixtures.
Reviewer checks functional contracts and visual evidence. Report actual checks,
PR links, artifact paths and remaining limits to the lead and 头号狗腿.
Keep private handoff receipts in the local build job: `local-app-ready.json`
for the initial signed App, and `feature-delivery-ready.json` once all five
outcomes, required checks, independent reviews and the local feature App are
ready. Include per-outcome status, English PR links, exact commits, real test
and screenshot paths, the App path and remaining limits. Never mark partial
work as complete or create another collection/notification automation.
