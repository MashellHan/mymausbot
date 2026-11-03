# MausBot development team

The user is 大雄 (menha). This dedicated Herdr team develops the personal
MashellHan/openmausbot fork in `/Users/mengxionghan/workspace/OpenMausBot`.
The original repository remains the upstream. Preserve its license and notices.

## Roles

| Herdr name | Role | Model | Effort | Context requested |
| --- | --- | --- | --- | --- |
| mausbot-lead | Lead | gpt-6-astra | max | provider default |
| mausbot-design | Designer | gpt-6-sol | xhigh | 1,000,000 |
| mausbot-front | Frontend | gpt-6-sol | xhigh | 1,000,000 |
| mausbot-back | Backend | gpt-6-sol | xhigh | 1,000,000 |
| mausbot-review | Reviewer | gpt-6-astra | max | provider default |

Launch arguments are in each role file; verify live session settings before
claiming the model is active. A requested context ceiling is not proof the
provider permits that entire context. Surface errors rather than downgrade.
The Sol launch explicitly uses `service_tier="default"`: the implicit priority
tier failed with `service_tier is not supported` on this installation, while
the explicit default tier was verified by real tool-using responses from all
three Sol members. Keep that local compatibility setting when restarting them.

Use `/Users/mengxionghan/.agents/skills/herdr/SKILL.md` for Herdr operations,
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
   Town collection definitions and local aggregate data, with an hourly refresh.
   Read `docs/ACTIVITY-MONITOR.md` and `scripts/activity-monitor.py` in that
   project first. Never publish raw conversations, credentials or repo lists.
   Missing/offline data is unavailable or stale, never fabricated zero.
   The initial dashboard covers the user's existing activity aggregate sources,
   not only activity inside this newly forked repo. Label the window and coverage.

Independent design/data reconnaissance may proceed while task 1 finishes;
feature integration and acceptance follow the order above. The existing build
job is already running: adopt its outputs, do not launch a duplicate build.
Job files live under the current conversation's `mausbot-local-build-20261103`.

## Engineering and review

Follow `CONTRIBUTING-FORK.md`. Keep a factual, short project runbook for build
commands and incident recovery. No secrets in commits, prompts or artifacts.
Respect upstream AGENTS.md, required hooks/checks and verification fixtures.
Consult the github-accounts skill for identity and repository-specific auth.
Only push feature branches and PRs to the user's fork; do not push upstream.
The user requested commit/PR history. Preserve intermediate meaningful commits;
do not manufacture commit counts, force-push others' work or bypass checks.

Lead should dispatch ready changes to reviewer immediately, with exact commit,
diff scope and validation. Review may run alongside independent next work.
Use one focused review, one correction batch and delta review of changed hunks
plus affected contracts. Repeat broad review only for new risk or unresolved
findings. Merge only with explicit user authorization or an already applicable
repository policy; creating and pushing reviewable PRs is authorized here.
Never equate a green badge or an idle agent with completed work.

## Design and verification

Designer follows `/Users/mengxionghan/.codex/skills/impeccable/SKILL.md` and
the incumbent MausBot component/token system. These are additions to an
established interface, not a redesign. The requested structure is settled;
choose sensible detail defaults without another approval round.
No live data mutation for tests. Use `docs/verification/README.md` fixtures.
Reviewer checks functional contracts and visual evidence. Report actual checks,
PR links, artifact paths and remaining limits to the lead and 头号狗腿.
