# Local Usage and Agent Team panels

These panels are local-owner observations. Their existing routes reject paired
devices, remote/proxied requests and service trust. No terminal output, complete
conversation, checkout path or credential is returned. Repository names and a
bounded, redacted latest instruction are available only through those routes.
The native Activities Mini App reads the same Usage provider through its
revision-guarded app-scoped dashboard endpoint, then renders LocalUsageView.

## Usage definitions

- The 1, 7 and 30 day windows include the capture date through the displayed
  timestamp in Asia/Shanghai. The trend uses the same 30 dates. Window changes
  compare the previous non-overlapping period; daily changes compare the same
  China-calendar date one week earlier. The capture day is still in progress.
- PR references come from the authenticated account's typed GitHub contribution
  connection, with both excludeFirst and excludePopular false. They count creations
  by PR createdAt in Asia/Shanghai, not merges. Repositories currently marked isFork
  are excluded from the known subset. The private source records rawPrs,
  excludedForkPrs and knownPrs per China date, plus raw profilePrs source-day counts.
  isPrivate is read explicitly; private PRs visible to this connection remain in the
  subset. Current repository state cannot certify event-time eligibility, and
  accessible private PRs can be absent from the connection. PR totals and comparisons
  therefore stay unknown; visible subset counts carry a reference explanation.
- Commit references use GitHub's repository-by-day commitCount buckets unchanged.
  A daily connection's totalCount counts commits, so it must equal sum(commitCount),
  not the number of day nodes. These buckets expose no SHA or per-commit author
  instant: they cannot be shifted by eight hours into exact China-day counts.
  Exact China-day commits and percentage comparisons remain null. A China date
  whose Profile bucket has not started yet is unknown, not zero.
- The versioned definition is github-profile-v1. GitHub's contribution engine
  determines commit account/email attribution, standalone non-fork repository
  eligibility, default/gh-pages branch and repository relationship rules. It is
  not local all-branch Git history or commits carried by merged PRs. Credit units
  are account × repository × Profile day; without SHAs, no global SHA deduplication
  or per-commit timestamp precision is claimed. PR IDs and repository IDs include
  host identity; duplicate account scope, PRs and repository/day buckets fail closed.
- The client checks viewer identity/host, response errors, fixed collection bounds,
  repository totals, all commit count sums, PR totals, pagination cursors and stable
  collection metadata across pages. A fixed to is not a transactional snapshot;
  index/history changes can alter a later response for the same cutoff.
  maxRepositories is explicitly 100 (default 25);
  the repository list has no cursor. More reported repositories than listed, a
  truncated daily connection, ten PR pages or a 120-second capture budget exhausted
  are unavailable coverage, never proof of zero or unlimited completeness.
- hasAnyRestrictedContributions/restrictedContributionsCount describe mixed types;
  they cannot be allocated to PRs or commits. Even restricted=0 does not certify
  private/internal coverage. Independent email association remains unknown; local
  authorEmails and failed email endpoints are not proof. Restricted activity and
  private omissions remain partial. Calendar totalContributions is never used for either
  metric. Complete empty visible observations remain distinct from missing data;
  missing source dates are not filled with zero. Classification uses existing rules.
- GitHub and Azure DevOps are separate sources. ADO alignment remains follow-up;
  legacy merged ADO counts are not added as evidence of GitHub Profile parity.
- Tokens remain local, including cache reads. Their existing synced-device
  comparison scope is preserved. Remote and token captures have independent
  timestamps; open the information icon beside Usage to inspect both. If capture dates
  differ, tokens are joined by calendar date to the displayed remote windows.
  Missing token dates stay unavailable, and an unavailable comparison stays null.
  Missing remote data never falls back to legacy PR or local Git counts.
- The refresh wrapper records independent per-machine Token completeness. A
  partial machine whose only failures are Git fetches can compare complete
  observed Token periods; Git coverage stays partial. Unknown, log-read,
  stale and previously sampled missing sources remain incomplete. Never-sampled
  devices remain outside the observed comparison scope. Cards show Token changes
  as percentages (or New/unavailable), with comparison dates and periods retained
  in titles and screen-reader descriptions; the 30-day change compares consecutive rolling
  periods, not calendar months. Missing baseline history has an explicit hint.

The existing wrapper `scripts/refresh-local-usage.py` retains its local Token and
legacy merged-source behavior. Deploy it with both adjacent modules,
`local_usage_merged.py` and `local_usage_github.py`. The new private sidecar is
`~/.local/share/mymausbot/usage/github-profile-v1.json` (0600, atomic replace,
independent OS file lock released on process exit). The persistent `.lock` file
must not be unlinked while writers may run; an old directory lock requires
verified owner exit before manual removal. Collection is **opt-in** with the existing private
configuration field `githubContributionSource: "github-profile-v1"`; --skip-api
never collects it. Enabling this field is a separate data-admission operation,
not part of source installation. No scheduler is added or enabled by the App.

Each capture recomputes today's China date plus the preceding six dates, with
today in progress. The preceding UTC source date is a read-only query guard band,
not an eighth replacement date. Source days outside those seven dates and inactive
account history remain unchanged; failures retain prior observations as stale.
Stable account identity changes for the same host/login reject the capture
without replacing the cache or blending earlier account history.
Profile dates and PR China dates are recorded separately. Old definitions are
not reinterpreted, compared or backfilled. The new response field is `github`;
Activities never falls back to `merged`, local commits or old created-PR counts.
The 1/7/30 windows remain; older unknown dates stay missing. Tokens retain their
original aggregate, comparison scope and actual-date join.
The 60/90-day and six-calendar-month views use up to 191 dated observations from
this same Profile source, including prior comparison dates. They never substitute
legacy merged history. Only previously retained observations are available;
selecting a longer range does not collect or backfill older data. Commit history
keeps Profile bucket labels, while PR history keeps China creation dates.

The existing Agent Town latest.json, legacy merged-v1.json, public whitelist and
nightly report keep their old definitions for compatibility. The new private
source is not published to them. Credentials are never stored. API/read failures
retain a last observed stream as stale, without shifting its dates. Installation,
actual UI readback, independent daily reconciliation and the bounded seven-day
production repair are separate acceptance steps. Single-writer admission must
cover every refresh caller, including any enabled nightly publication task.

Official definitions are pinned to github/docs commit
`8cd1075179df75319912891d6620c9cb78eefb4d`:
[contribution reference](https://github.com/github/docs/blob/8cd1075179df75319912891d6620c9cb78eefb4d/content/account-and-profile/reference/profile-contributions-reference.md)
and [GraphQL objects](https://docs.github.com/en/graphql/reference/objects#createdcommitcontributionconnection).
The Profile contribution date label is not a certified China-calendar event date.

Run `python3 scripts/local_usage_github.test.py` for synthetic API completeness,
qualification, date boundary, opt-in and bounded-persistence tests. The synthetic
`server/local-usage-github.test.ts` exercises Python capture → private file →
provider → view, including unknown/stale coverage and independent Tokens.

### Microsoft authentication held in memory

For unattended Microsoft authentication without macOS Keychain requests, use
`scripts/refresh-local-usage.py` with the Python interpreter from the existing
Azure CLI installation. It reuses that installation's MSAL dependency and reads
its already configured account and token cache. Newly acquired tokens stay in
memory for the collection process; the existing cache and CLI settings are not
rewritten. The macOS authentication broker is disabled for this client.

```sh
"$USAGE_AZURE_PYTHON" scripts/refresh-local-usage.py \
  --collector "$USAGE_COLLECTOR" --config "$USAGE_CONFIG"
```

The collector path points to the existing Agent Town `activity-monitor.py`.
Its source, overlap lock, identity checks, date filters, aggregation and private
output files retain their existing behavior. Its Azure CLI REST calls and the merged-PR adapter use the same in-memory
client. GitHub collection uses the existing account-pinned helper.
The client supports existing AzureCloud user accounts whose identity matches
the configured author emails. It accepts only HTTPS Azure DevOps identity and
PR GET endpoints and refuses redirects carrying authentication. An unavailable
login leaves the corresponding source stale through the collector's normal
failure handling; it does not open a login prompt or fall back to the CLI.

Use this command in the existing five-minute job. Add `--publish` only to an
already authorized publication task; the normal refresh does not publish.
`--reuse-sources` and `--skip-api` keep the collector's recovery semantics.

Run `python3 scripts/local_usage_merged.test.py` for merged-PR pagination,
original-commit accounting and bounded cache recovery. Run
`python3 scripts/refresh-local-usage.test.py` for synthetic memory lifetime,
cross-tenant identity, endpoint/redirect, interrupted HTTP response and
collector-routing checks. A real identity GET is a separate read-only
acceptance check; keep its private receipt and never log token contents or
publish the CLI cache.

## Agent observations

The visible panel polls every two seconds without overlapping requests. The
provider deduplicates reads and caches unchanged session files. A pane must
provide an exact Codex session ID matching the file's session metadata before
model, effort, context or instruction can be read. Initial parsing is bounded
to the final 8 MiB; subsequent reads process bounded appends. A value absent
from that observation is unavailable, rather than inferred from role settings.

Context uses the last request's input plus output tokens, never lifetime token
totals. A model change clears prior context. Latest instructions replace one
bounded field. Team active counts include only the live `working` state;
blocked, idle, unknown and response-ready agents are separate states. Stale
snapshots label counts as last observed and pause the office artwork's motion.
The office selector uses bundled, attributed artwork and the same snapshot as
the selected member list.

## Per-agent activity

`GET /api/local-dashboard/agents/{paneId}/activity` is a separate local-owner
route. It accepts a Herdr pane ID such as `w6:p1` and no query parameters. Each
read rechecks that pane's current Codex session, matches its exact session file
ID, then returns at most 60 user-input and assistant-reply messages from a
512 KiB tail. Tool calls and results do not count toward the message limit.
Each excerpt is limited to 600 characters;
path-like values and recognized credential shapes are masked. System/developer
messages and reasoning records are skipped. The two-second team metadata
response carries no history.

The response names the pane, status, last successful read time, events and a
`truncated` flag. `unavailable` and `unsupported` have no rows. `stale` retains
last-good rows only after Herdr still identifies the same Codex session; a
missing or changed session clears them. The detail disclosure starts closed,
polls without overlap only while open and visible, and clears on 401/403.

## Isolated verification

Activities shares a 30/60/90-day or six-month range across its three trends.
The default 30-day projection and the 1/7/30-day cards, comparisons and repository
tables retain their existing scope. Longer trends use one extended projection
for the entire range, including dates also present in the default trend.
Days in different source captures are joined by their actual China-calendar date.

Six months means the interval after the clamped same date six calendar months
earlier, through the data date, inclusive. For 2026-11-09 this is 2026-05-10 through
2026-11-09; for 2024-08-31 the February boundary clamps to leap day, so the range
starts 2024-03-01. Six-month bars group by Monday, counting only dates inside the
range. Boundary tooltips show their actual start and end. Daily details retain
all selected dates; shorter ranges restore daily bars. Missing dates remain
unavailable, partial observations remain lower bounds, and verified zero remains zero.

The private response includes at most 191 dates, enough for six calendar months
and the daily comparison offset. The wrapper still requests the external
collector's supported `history_days=59`; it retains validated daily Token totals
in `trendHistory` across refreshes. It does not retrieve older Token logs or fill
gaps. The remote merged-PR collector has a bounded 191-day search and preserves
each stale source's actual coverage start. The server independently deduplicates
the original 60-day card projection and the extended trend projection, so an
earlier repeated commit cannot change existing card or repository accounting.
Legacy 60-day ready caches provide no observations before their declared start.
Deploy the wrapper and its adjacent module together to accumulate history;
source changes alone do not backfill, run collection or update an installed App.

Synthetic range and week regressions live in `shared/local-usage-range.test.ts`,
`src/lib/local-usage-trends.test.ts`, `src/lib/local-usage-view.test.ts` and
`src/components/LocalUsagePanel.test.ts`. The Python collector fixtures are
`scripts/refresh-local-usage.test.py` and `scripts/local_usage_merged.test.py`.
Use the shared selector and existing isolated renderer fixture below. Check
60/90 daily bars, six-month Monday bars, boundary dates, missing and partial
values, keyboard navigation and returning to 30 days in both locales at 360,
400 and 960px. Browser acceptance requires an approved browser channel.

Run the affected contracts and owner-access fixture:

```sh
pnpm exec vitest run server/local-agent-teams.test.ts server/local-agent-activity.test.ts server/local-usage.test.ts server/routes/local-dashboard.test.ts server/local-dashboard.e2e.test.ts src/components/AgentTeamPanel.test.ts src/components/AgentTeamPanel.auth.test.ts src/components/AgentActivityDetails.test.ts src/components/LocalUsagePanel.test.ts src/lib/local-usage-view.test.ts
```

Launch each synthetic renderer fixture directly in a separate terminal:

```sh
node --experimental-strip-types scripts/verify-usage.ts
node --experimental-strip-types scripts/verify-agent-team.ts
```

Use their printed URLs, never a live app URL. Check `width=360`, `400` and `960`,
`skin=midnight` and `atelier`, and `locale=en` and `zh`. Verify three stacked
trends, initially collapsed daily details, all three WoW values, and keyboard
navigation of repository period tabs. Check unavailable, stale and zero states.
Use `scenario=remote-only` to verify merged counts without local logs and
`scenario=legacy-only` to verify that old PR/commit/repository values are not
relabeled as merged. Faint full-height Monday separators mark each week.
In both locales at 360px, expand the daily table and scroll fully right. Each
WoW metric name and value must remain visible beside the fixed date column.

For Agent Team use `scenario=live`. The working team opens by default; when none
is working or blocked, use the most recent verified session timestamp. Unknown
activity times do not imply recency. A manual selection or collapse survives polling.
Select an office, focus its card and scroll the selector and member list. POST to
`/__agent-team-update` on that fixture's printed origin. Within the next polling
interval, the active count, instruction, effort and context change while
selection, focus and scroll remain. Switch offices to confirm the previous members
disappear. Use `scenario=many` to check two visible office rows and keyboard access
to the rest; `scenario=one` checks singular counts. Reset the synthetic snapshot
with `POST /__agent-team-update?reset=1`. Check paused motion, reduced motion,
stale counts, unknown metadata and loss of local authorization.

For activity, select an office and open one member's Recent messages button.
Check the bounded independently scrollable list at `width=360` and `400`, both
skins and both locales. The fixture includes more than 60 synthetic tool events
between chat messages; only Input and Reply rows appear. `activity=tools` shows
the message-empty state, while `activity=unavailable`, `activity=unsupported`
and `activity=stale` exercise source states. Opening starts at the latest reply;
POST to `/__agent-activity-update` and wait for the open detail to refresh
without moving the reader away from an older row. Closing the
disclosure, switching offices or hiding the page stops its detail requests.

Stop each foreground fixture with Ctrl-C. The separate collector tests use
temporary files and synthetic API responses, including an assertion that the
public sanitizer drops repository metadata. Required repository checks remain
`pnpm lint`, `pnpm typecheck` and `pnpm i18n:check`.
