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

Lead should dispatch ready changes to reviewer immediately, with exact commit,
diff scope and validation. Review may run alongside independent next work.
Use one focused review, one correction batch and delta review of changed hunks
plus affected contracts. Repeat broad review only for new risk or unresolved
findings. The user has authorized reviewed merges into the personal repository.
Lead decides merge order and merges only after Reviewer has no unresolved
findings and required checks pass. Creating and pushing reviewable PRs is
authorized here.
Never equate a green badge or an idle agent with completed work.

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
An ordinary PR's first required-gate attempt has five minutes from run creation,
including queue time; a rerun uses its current attempt start, with the original
age kept as diagnostic. One cached Ubuntu static/setup path retains typecheck,
lint and source guards, then runs the 26-file security/data/dispatch core and
at most four portable affected files. Record deferred affected files, including
expensive browser and Electron tests. The `ci:full`, `qa:repair` and `windows`
labels request explicit wider checks.
Long platform, Electron, browser, full E2E and packaging checks belong to the
applicable post-integration, daily 05:00 and release lanes. A failed or
over-budget gate is a CI incident, not a waived check; current-head review
and QA holds still control merging.
Dev leaves a durable PR-body handoff with `QA-Handoff: <current head SHA>`.
The existing Lead owns review and CI follow-through while local delivery and
independent development continue.

The automated QA runner is the existing CI full lane, once daily at 05:00
Asia/Shanghai. It does not need another persistent model. Its trusted reporter
files deduplicated issues;
the ten-minute queue hands actionable work to mausbot-lead. Lead acknowledges,
triages within thirty minutes, assigns an existing developer/maintainer and sets
priority, scope, classification, next action and due date. Reviewer reviews fixes;
QA verifies after integration; Lead closes with evidence. Read the mechanism
for hold/repair boundaries and rollback. Shadow mode preserves existing checks;
admission requires the documented pilot evidence.

## Upstream integration

The user's assistant owns the existing daily 09:00 Asia/Shanghai schedule;
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
