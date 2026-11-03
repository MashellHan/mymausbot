# MausBot fork delivery, 2026-11-03

Owner: 大雄 (menha). Repository: https://github.com/MashellHan/openmausbot.
Upstream: https://github.com/milind-soni/OpenMausBot.

## Accepted scope

The dedicated Herdr workspace is `MausBot` in local session `default` (`w6`).
Its live agents are `mausbot-lead`, `mausbot-design`, `mausbot-front`,
`mausbot-back`, `mausbot-review`. The actual start argv selected GPT-6-Astra/max
for lead and reviewer and GPT-6-Sol/xhigh with model_context_window=1000000
for the other three. TUI model labels were read for lead and frontend; the
context value is a launch configuration, not a measured provider limit.
Sol initially failed on the implicit priority service tier. Restarting those
three agents with `service_tier="default"` preserved the requested model,
effort and context settings and produced actual tool-using responses.
Role files and CONTRIBUTING-FORK.md carry the user's development preferences.

## 1. Build and open

The source checkout is `/Users/mengxionghan/workspace/OpenMausBot`. Build outputs
are ignored files, not a separate source tree. The already executed script is
at:

`/Users/mengxionghan/.openmausbot/task-workspaces/0a053f00-e750-4f24-b026-2c3826811429/04c1cba3-f680-4f38-880c-a899afdf892f/mausbot-local-build-20261103/build.sh`

That directory contains build.log, finished, and exit-code. The initial nohup
attempt never ran; the Python start_new_session launcher did run successfully.
It installed the frozen pnpm lockfile, passed Electron syntax, built UI/server/
companion/updater and staged arm64 native resources, and passed the independent
server smoke check before packaging. The app is:

`/Users/mengxionghan/workspace/OpenMausBot/release/mac-arm64/OpenMausBot.app`

Packaging finished, but the explicit final codesign verification failed:
`code has no resources but signature indicates they must be present`.
CSC_IDENTITY_AUTO_DISCOVERY=false meant electron-builder skipped signing;
the bundle needs correct ad-hoc signing for this local-only build. Do not copy
or pretend to possess upstream's Developer ID. Resume at signing/packaged smoke,
not the entire dependency download. Validate packaged server and isolated app
startup before switching. The running official app owns this very chat; arrange
continuation and safe rollback before quitting it. 头号狗腿 will perform mounted
computer actions when the lead reports the artifact ready.

Keep the official app and all three existing data locations:
`~/.openmausbot`, `~/.openmausbot-companion`, and
`~/Library/Application Support/openmausbot`.
An initial app without the new features satisfies only this first milestone.

## 2. Agent Team panel

The requested right panel is the Computer panel, not the bot profile's
Details/Library/Computer tabs. The existing peer tab registry is
`src/components/computer-panel-tabs.ts`, and Files is the last registered tab.
Add Agent Team immediately after Files and Usage immediately after Agent Team.

Show local Herdr workspaces as teams with counts, collapsed by default.
Expanded members show name/role, actual model, state and most recent task when
it can be established. Do not infer completion solely from a lifecycle badge;
unknown and unavailable stay explicit. Avoid exposing full terminal content.
Reuse the visual idea and read-only integration from the existing Agent Town
source, especially `src/herdr.js`, `public/member-ui.js`, `public/team-office.css`.
Preserve current panel behavior, keyboard navigation, narrow layouts and themes.

## 3. Usage panel

The user's last sentence about windows is interpreted as 1, 7 and 30 days.
Use the existing personal/work activity aggregate source across known tools and
repos, not only this new fork. Display PRs, commits and tokens in a compact
period summary followed by trends. Use China time, with exact window semantics
consistent with Agent Town and transparent partial/stale coverage.

Reference `/Users/mengxionghan/workspace/whatsmyagentdoing/docs/ACTIVITY-MONITOR.md`
and `scripts/activity-monitor.py`, and existing aggregate
`~/.local/share/agent-town/activity/latest.json`. Reuse definitions for token
cache/reasoning accounting, cross-clone commit deduplication and PR identity.
Read aggregates rather than exposing raw conversation logs or credentials.
Refresh hourly with single-flight behavior and preserve last good results on
failure. Reuse an existing schedule or coordinate one owner to avoid duplicate
collection; the existing standing daily publication remains intact.
Hourly local refresh is already enabled on 头号狗腿, automation
`e8e4f244-f5bc-40c6-99aa-acdef15c7b12`, at every hour in China time, first
2026-11-03 17:00. It calls the existing collector without `--publish`; do not
add a second hourly collector in the App without consolidating ownership.

## Delivery checks

- Functional changes use isolated fixtures from docs/verification/README.md.
- Required pre-push checks are lint, typecheck and i18n:check; do not skip them.
- Focused PRs include exact commits and real check evidence. The bootstrap PR
  contains only team/profile/workflow docs; user's docs/research stays untracked.
- Reviewer should review the bootstrap immediately, then each ready slice;
  independent work can proceed concurrently. Merge is not yet authorized.
- Completion requires actual artifact/process/UI verification, not only a prompt
  accepted by Herdr or a role declaration. Report remaining limits precisely.
