# MausBot backlog

## Mini Apps delivered locally

The installed App delivered on 2026-11-09 at 12:46 Asia/Shanghai was built from
`18aa460c57445b353d30eb80dcd7b8edd1eb3150` after the reviewed integration
in [PR #137](https://github.com/MashellHan/mymausbot/pull/137). The private
delivery handoff has SHA-256
`103d11e182b7c9bed6c998c3b1478ec2992c641bdabc141d5357ab002f649f0b`;
the installed package and its compiled outputs were independently matched to that
source. This is package/source evidence, not native click acceptance. The audit
also confirmed that installed app identities, retained ledger Data, report
editions and existing schedules were preserved, without publishing their private
identifiers or contents here.

| Delivered outcome | Merged source | Behavior in the `18aa460c` App |
| --- | --- | --- |
| Compact Mini Apps and navigation | [#122](https://github.com/MashellHan/mymausbot/pull/122), [#126](https://github.com/MashellHan/mymausbot/pull/126) | Mini Apps opens by default on the guarded local desktop; the one-row launcher and anchored All apps menu hold publisher chat, version history and removal. Agent Team and Activities are Mini Apps, not separate Computer tabs. Explicit Data, Browser, Screen and manual tab choices remain available. |
| Agent Team and Activities | [#122](https://github.com/MashellHan/mymausbot/pull/122), [#124](https://github.com/MashellHan/mymausbot/pull/124), [#130](https://github.com/MashellHan/mymausbot/pull/130) | Agent Team opens a verified working, blocked or recently active team when available and shows only attributable rolling 24-hour/7-day Token observations. Activities keeps its existing `usage` identity, source coverage and complete-period Token comparisons; unavailable history is not fabricated. |
| Bookkeeping | [#122](https://github.com/MashellHan/mymausbot/pull/122), [#129](https://github.com/MashellHan/mymausbot/pull/129) | Recent/Statistics, compact Trend/Calendar, spending summary and prior-period change, daily/monthly trend with peak, category shares and whole-ledger record sorting. The ledger and permissions remain local. |
| X AI and GitHub reports | [#131](https://github.com/MashellHan/mymausbot/pull/131) | Editorial current/history reading, indexed detail and guarded source opening when the desktop grants that capability. Existing edition Data and custom-template protection remain intact. |

## Acceptance and separate follow-ups

| Item | Status |
| --- | --- |
| Native visual, source-click and Agent Team header interaction | Pending: mounted controls were unavailable for this acceptance. Package, resource and startup evidence does not establish a native click or an OS permission grant. |
| Next natural scheduled X/GitHub report publication | No post-upgrade acceptance receipt was located in the audit. Earlier real publication was already proven, and existing editions and schedules were preserved; absence of a new receipt is not a report failure. This follow-up is separate from the unapplied upstream-sync routine-owner prompt. |
| Runtime [#136](https://github.com/MashellHan/mymausbot/pull/136) | Merged after the `18aa460c` build; it is not in the installed App. A later App update needs its own source-bound delivery evidence. |
| Upstream [#134](https://github.com/MashellHan/mymausbot/pull/134) | Source and CI work remains separate and is not installed. Its corrections do not change the Mini Apps delivery status above. |
| Generated Markdown/CSV preview | Queued after Mini Apps: open a generated file in the right panel, render Markdown or a CSV table, and retain download. |

## Resumed Activities contribution and data repair

The user explicitly resumed the following two items on 2026-11-09. Historical
initialization or pause instructions no longer apply to these items;
seemyagentteam migration remains paused. These entries do not mark a repair,
backfill or installation complete.

| Item | Owner, status and dependency | Acceptance boundary |
| --- | --- | --- |
| [#364: GitHub Profile PR/commit alignment](https://github.com/MashellHan/mymausbot/issues/364) | `miniapp-lead` is accountable; existing `miniapp-dev` has started runtime/source investigation. `miniapp-review` and `miniapp-qa` provide independent review and acceptance. | Verify the actual collector, scheduler, writers, source versions and reader/UI chain; reconcile official GitHub definitions and daily account contributions, including repository/branch/fork eligibility, identity, deduplication, dates/time zones and private/restricted visibility. Preserve unknown/partial states and a metric-version boundary. Local all-branch commits or merged-PR counts are not Profile parity. Azure DevOps parity is a separate source-specific follow-up associated with this issue. |
| [#365: Latest-seven-day data repair](https://github.com/MashellHan/mymausbot/issues/365) | Same accountable owner and existing team; production execution depends on accepted #364 and independent data admission. Runtime tracing, isolated repair tooling and rehearsal may proceed. | At execution use that capture day plus the preceding six China calendar days, with today partial through the capture cutoff. For a 2026-11-09 execution this is 2026-11-03 through 2026-11-09; recalculate rather than reusing the example. Require a recoverable private snapshot, single-writer control, isolated rehearsal, idempotent bounded deduplication/upsert, preservation of earlier history and unrelated Token/Data, and per-day persisted, reader and rendered readback. A dry-run or source merge does not complete this issue. |

Use the existing issues and team, not duplicate tasks or monitoring routines.
Keep raw private records and recovery snapshots outside Git. Tests use isolated
synthetic fixtures; real bounded repair runs only after its review and data
admission gates. Record each item's PR/head/merge, required checks, independent
review/QA, real data execution, installed source/version and actual UI acceptance
separately. `mausbot-lead` retains host integration and sole App delivery
coordination; these tasks do not independently restart the user's App.

Existing unfinished long-period trends, configuration viewer, Tokens/title
installation and report interaction acceptance remain separate, alongside the
other follow-ups above. This addition does not close or certify any of them.

Merged source, installed package and native interaction are separate results.
Continue required review, CI, permission and Data checks for each pending item;
do not infer delivery from a merge or a failure from missing new observation.
