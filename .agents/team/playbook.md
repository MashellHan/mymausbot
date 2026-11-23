# MausBot development team

The user is 大雄 (menha). This dedicated Herdr team develops the standalone
personal repository `MashellHan/mymausbot` (`fork=false`) in
`/Users/mengxionghan/workspace/OpenMausBot`. `origin` targets this repository;
`upstream` remains the read-only `milind-soni/OpenMausBot` repository.
`legacy-fork` names the old `MashellHan/openmausbot` repository and its historical
PR, issue, review and CI records. Preserve upstream license and notices.

## Roles and launch defaults

| Herdr name | Role | Runtime | Model | Effort | Context requested |
| --- | --- | --- | --- | --- | --- |
| mausbot-lead | Lead | Codex (Raven YOLO) | gpt-6-astra | max | provider default |
| mausbot-design | Designer | Codex (Raven YOLO) | gpt-6.2-sol | xhigh | 1,000,000 |
| mausbot-front | Frontend | Codex (Raven YOLO) | gpt-6.2-sol | high | 1,000,000 |
| mausbot-back | Backend | Codex (Raven YOLO) | gpt-6.2-sol | high | 1,000,000 |
| mausbot-upstream | Upstream integration | Pi (Raven, native execution) | gemini-4-hydrogen | high | provider default |
| mausbot-dev1 | Additional developer | Pi (Raven, native execution) | gpt-6.2-sol | high | 1,000,000 |
| mausbot-dev2 | Additional developer | Pi (Raven, native execution) | gemini-4-hydrogen | high | provider default |
| mausbot-dev3 | Additional developer | Pi (Raven, native execution) | gpt-6.2-sol | high | 1,000,000 |
| mausbot-review | Reviewer One | Codex (Raven YOLO) | gpt-6.2-astra | xhigh | provider default |
| mausbot-review2 | Reviewer Two | Codex (Raven YOLO) | gpt-6.2-astra | xhigh | provider default |
| mausbot-review3 | Reviewer Three | Pi (Raven, native execution) | gemini-4-carbon | high | provider default |
| mausbot-mini-review | Mini App Reviewer | Codex (Raven YOLO) | gpt-6.2-astra | xhigh | provider default |

The Codex launch defaults use the existing Raven provider
in YOLO mode (preserving any existing pane shell profile without duplicating
`--profile`). The Pi launch defaults use the existing Raven
provider with automatic native tool execution (no per-call tool approval
prompts). Preserve existing designated providers, accounts and authentication
boundaries.

`mausbot-dev1` and `mausbot-dev3` use [roles/developer.md](roles/developer.md)
with Pi/Raven (`--model raven/gpt-6.2-sol --thinking high`) and requested
context 1,000,000 (advertised catalog window 1,050,000). `mausbot-dev2` uses
the shared developer duties in [roles/developer.md](roles/developer.md) with
its per-member Pi/Raven launch `--model raven/gemini-4-hydrogen --thinking high`
and provider-default context, and `mausbot-upstream` uses
[roles/upstream.md](roles/upstream.md) with Pi/Raven,
`--model raven/gemini-4-hydrogen --thinking high` (catalog window 1,048,576;
observed prompt-token ceiling may be lower, so keep requested context and
observed total context distinct). `mausbot-review3` uses Pi/Raven with
`--model raven/gemini-4-carbon --thinking high --tools read,grep,find,ls --no-mcp`
as recorded in [roles/reviewer3.md](roles/reviewer3.md) (catalog window
1,000,000). `mausbot-review`, `mausbot-review2` and `mausbot-mini-review` use
Codex with `gpt-6.2-astra` and `xhigh` effort, preserving their source-review
duties and inherited `--profile raven --yolo` pane alias.

`mausbot-mini-review` uses [roles/mini-reviewer.md](roles/mini-reviewer.md) on Codex with
`gpt-6.2-astra`/`xhigh`. This update adds no agent, grants, QA-owner labels or
approval requirement. The general review pool remains `mausbot-review`,
`mausbot-review2` and `mausbot-review3`.

Lead coordinates scope and delivery. Designer owns UX and visual acceptance.
Frontend implements the renderer and owns App packaging. Backend owns server,
data and writer contracts. Upstream integration owns upstream carries. The three
additional developers take exclusive source assignments from Lead. Reviewer One,
Reviewer Two and Reviewer Three independently review their assigned source. Mini
App Reviewer handles supplemental Mini App review.

Role files and launch defaults are requested settings, not claims of live
runtime verification; verify live session settings before claiming a model or
effort is active. A requested context ceiling is not proof the provider permits
that entire context. Surface errors rather than silently substituting a model.
The existing Codex `gpt-6.2-sol` launch files record `service_tier="default"`
for local compatibility where `service_tier` is unsupported. Keep the existing
pane shell profile (`--profile raven --yolo`) and `service_tier="default"`
compatibility settings when restarting Codex panes, and keep
`--tools read,grep,find,ls --no-mcp` for `mausbot-review3` on Pi.

Use the Herdr skill for Herdr operations,
with `--session default` and explicit names/IDs. Work in the MausBot workspace;
do not modify or close another team's panes. Keep focus unchanged.
The lead owns scope, task sequencing, integration and acceptance. Specialists
report to the lead. Lead balances the three additional developers across
exclusive scopes with one source owner each; do not select or duplicate another
member's active task or edit the same file in parallel. Use isolated worktrees
for code PRs, rooted beside this project under the user's workspace.
`mausbot-front` remains the sole App builder/installer; Root alone operates
GUI/App/provider/Cloud delivery. Additional developers and reviewers do not
independently build, install or operate the App, or test against live data.

Read the validation policy and role from that task checkout. An older dirty
coordination root may lack new commands or policy files; read the fetched
`origin/main` versions instead of reverting to historical instructions.
Root routes nonblocking feedback through Lead. Lead batches actionable changes
for the owning developer at a safe source boundary; do not repeat the same
instruction from multiple coordinators. Interrupt only for a concrete blocker
or data/security risk. Cleanup and unrelated QA retain separate owners.

## Authentication: login Keychain boundary

### Applies to every agent and authorized tool (menha, 2026-11-16)

- First try the tool's normal native authentication for the already-authorized
  task, using its existing signed-in account or designated credential source.
  This applies to every agent and tool, not just Agency / Work IQ. Verify the
  intended account before reading private data or taking an authorized action.
- Native authentication may internally use the operating system's credential
  storage. That possibility alone is not a reason to block a normal attempt.
  Do not invent a dependency on the login Keychain, demand a separate token,
  or require proof that the entire authentication chain avoids it first.
- Documentation mentioning AzureAuth/MSAL, a credential helper, a browser
  store or Keychain, and old static audit conclusions, do not establish which
  credential store the current invocation actually uses. Distinguish evidence,
  uncertainty and inference; report actual returned errors accurately.
- Normal native authentication is allowed within the task's existing account,
  permission and action scope. This does not authorize manual credential
  extraction, unrelated credential-store searches, account changes, new grants,
  configuration changes, or bypassing authentication or access controls.

### Direct Keychain access remains restricted

- Do not proactively inspect, enumerate, read/export credential items from,
  write, unlock or change the macOS login Keychain (login.keychain /
  login.keychain-db), directly or by repurposing another tool to do so.
  Never copy credentials out of it or change the Keychain search list.
- If a normal attempt actually requires Keychain unlocking/access consent,
  interactive sign-in, MFA or a new grant, stop autonomous retries and ask menha
  to perform the necessary manual step. Stop on an actual account mismatch or
  authentication/access denial. Never request passwords, tokens or MFA codes
  in chat. Existing bounded retries for genuine transient errors remain allowed.
- Explicit environment credentials, permission-restricted private file caches
  outside repositories and separately designated other keychains remain usable
  for authorized work. Do not fall back to unrelated credential sources, print
  or commit credentials, weaken authentication, or disable security controls.
- A successful action proves that the action worked; it does not prove which
  credential store or Keychain item was used. A process finishing does not prove
  that its intended work succeeded. Keep coverage gaps until actually backfilled.
- Carry this exact distinction into new project/agent instructions and delegated
  tasks. Do not turn the direct-access restriction into a blanket ban on normal
  native authentication, all credential storage, or independent work.

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

Before implementation, put three short entries in the existing assignment or
draft PR. Reuse that record; do not create another plan or approval stage:

- Acceptance: the requested observable result, existing sources and callers,
  and what must work for this delivery to be complete.
- Evidence and dependencies: input facts already checked, design uncertainty,
  and reader, writer, cache or migration dependencies; use "not applicable"
  when the task has no data or migration change.
- First candidate: the smallest coherent implementation to review, focused
  checks, and deferred work with an existing owner and next action.

For date conversions, check whether inputs contain raw timestamps or only daily
aggregates. For collector or migration changes, bind the actual configured scope
and old/new reader, producer and cache formats. Where applicable, use existing
evidence or a small isolated fixture to establish that collection advances
across upstream head changes, retries retain progress, and migration calls the candidate producer.
Do not relabel old aggregates, restart proven history on every refresh, or
test migration against live data. Reuse passing evidence for unchanged behavior;
add focused cases for changed or uncovered contracts.

Amend the same brief when a necessary dependency emerges; tell Lead its impact
and continue independent work. Routine design choices do not wait for another
acknowledgement. Lead reports material scope or estimate changes to the user
early. Keep unrelated improvements in the existing backlog. A small plan never
waives correctness, safe migration or a requested outcome.
Missing brief or timing fields call for completing the existing record; they
do not fail CI, close a PR or add an approval requirement.

Historical backfill may continue through the existing collector after delivery
only where the accepted contract permits partial coverage. Prove forward
progress and honest missing-data behavior before handoff; unknown history is
not zero. Record remaining coverage, owner and completion condition. An explicit
request for complete history remains pending until verified. Do not add a
collector or schedule just to separate backfill from source acceptance.

When several independent changes need the same registry or host-test edits,
Lead assigns those shared files to one integration owner. Feature owners can
implement and review their distinct behavior in parallel. The integration
owner preserves the original heads and runs the shared contract checks on
the combined tree.

Coherent source, atomic commits and focused PRs come before batch-wide
acceptance. Start mandatory current-head CI and independent source review
alongside independent development. At Lead's chosen batch boundary, consolidate
applicable integration testing and findings, then assign batched repairs. Do not
postpone blocking findings or applicable QA holds to preserve the cadence, add
approval gates, or replay broad unchanged product checks.

Lead assigns each independent PR or coherent batch to an available reviewer
with the shorter queue: `mausbot-review`, `mausbot-review2` or `mausbot-review3`.
Record one review owner with the exact source handoff. Any one reviewer's
acceptance satisfies the independent review requirement; Reviewer3 is an
alternative owner, never an additional approval gate. Keep correction deltas
with that owner, or explicitly transfer the existing findings and accepted
evidence if another reviewer can unblock the work. Do not send an already
assigned change to multiple reviewers or repeat accepted review merely to
balance their queues. Historical QA triage remains separate from source review.

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
GitHub auto-merge is the default merge path for team PRs so ordinary PRs do not
wait on Lead for per-PR merge handoffs. Once the assigned Reviewer finds no
blocking defects, resolves all GitHub review threads, and confirms no explicit
Lead merge-order hold applies, the Reviewer (or PR owner when `mausbot-review3`
is read-only) enables `gh pr merge --auto --merge` directly—or merges
immediately if required `CI` is already green. Lead retains merge-order control
only for explicitly held or dependent batches. Creating and pushing reviewable
PRs is authorized here.
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

### Pull request handoffs

Freeze a coherent candidate after focused contract checks. Send its immutable
commit, available evidence and explicitly pending UI/package checks immediately;
source review and CI can start while those checks finish. Do not wait for all
screenshots or a package to begin source review. Pending acceptance still blocks
the corresponding delivery. Batch corrections and review only their delta.

1. **Dev hands off ready source.** Send the PR, its current `QA-Handoff` SHA,
   validation, and open review threads to the assigned Reviewer once. Lead
   assigns the review owner and recovers failed handoffs. After a
   requested correction, reply on the original threads and update `QA-Handoff`
   to the pushed head. In the same turn, send that head directly to the assigned
   Reviewer for delta review, including PRs held for merge order.
2. **Reviewer hands off blocking findings.** Post one GitHub review on the
   reviewed SHA (`COMMENT` for single-account PRs). Send the assigned Dev one
   direct handoff with the blocking threads in the same turn. Verify each
   correction before resolving its thread. For a read-only Reviewer, the
   PR owner or Lead records the returned exact-SHA verdict and routes it.
3. **Reviewer hands off accepted source.** Record source acceptance on the
   reviewed SHA. Once all review threads are resolved, enable
   `gh pr merge --auto --merge` (or merge if required `CI` is already green) for
   an ordinary PR. For an explicit merge-order hold, send Lead the accepted SHA
   and current check status once. The PR owner or Lead takes the corresponding
   action for a read-only verdict. Lead records the actual merge and advances
   the ordered batch.

Record delivery and the recipient's observed start separately in the existing
handoff. The sender may continue independent work after delivery. If delivery
fails or the recipient is unavailable, keep the pending SHA, owner, and next
action for Lead to recover or transfer at the next handoff or the 06:00/21:00
Beijing checkpoint. Verify the recipient's actual state before retrying an
uncertain delivery. Lead also handles conflicts and QA holds. Do not add
polling jobs, duplicate notifications, a second review owner for the same scope
or a new approval gate.

Freeze operational callers before their focused review as well. A caller or
fixture correction does not reopen unchanged product source or require another
App build. If the reviewer's filesystem is read-only, Lead saves its final reply
as the canonical verdict immediately; do not wait for a duplicate receipt file.
Resume only the failed stage under the local runbook's current-state rules,
retaining the original failure and elapsed time in the existing handoff.

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
lint, source guards and the relevant generated Settings places equality check.
It runs the 26-file security/data/dispatch core and at most four portable
affected files, including on `upstream-sync` PRs. Record deferred files and
checks. Ordinary main pushes validate the cumulative source from a proven green
main baseline and report focused coverage, not full QA. The `ci:full`,
`qa:repair` and `windows` labels request wider macOS checks; `windows` selects
no Windows runner. Full validation uses ten macOS all-E2E shards and specialist
jobs. Windows/Ubuntu full tests and platform smokes are retired; platform
build/resource/signing/publication checks keep their separate boundaries.
Electron unit checks precede the long Vitest block, and broker tests run once
in the control-plane job. Long checks belong to the daily 05:00, manual and
release lanes and explicit escalations. Actual failed required work remains a quality incident. Timing overruns and
other process targets are advisory scan cases; successful validation remains
green. Use the independent process scan and Lead checkpoint, without
blocking merges or delivery on process metadata or elapsed time. Current-head
review and actual QA holds still control merging.
Dev leaves a durable PR-body handoff with `QA-Handoff: <current head SHA>`.
The existing Lead owns review and CI follow-through while local delivery and
independent development continue.

The automated QA runner is the existing CI full lane, once daily at 05:00
Asia/Shanghai, using the full macOS selection. It does not need another
persistent model. Its trusted reporter records the selected platform policy and
files deduplicated issues;
one Root-owned MausBot Automation calls the existing Lead at 06:00 and 21:00
Asia/Shanghai. Lead inspects the full backlog and active work, holds a brief
triage meeting, starts the next prioritized repair batch and resumes unfinished
work at later checkpoints. Assign an existing developer/maintainer and record
priority, scope, classification, next action and due date. Reviewer reviews
fixes; QA verifies after integration; Lead closes with evidence. Retiring a
platform does not verify its old failures. Preserve the retired hourly queue's
source, state and receipts; Root owns its launchd replacement. Read
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
