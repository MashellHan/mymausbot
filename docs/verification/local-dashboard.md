# Local Usage and Agent Team panels

These panels are local-owner observations. Their existing routes reject paired
devices, remote/proxied requests and service trust. No terminal output, complete
conversation, checkout path or credential is returned. Repository names and a
bounded, redacted latest instruction are available only through those routes.

## Usage definitions

- The 1, 7 and 30 day windows include the capture date through the displayed
  timestamp in Asia/Shanghai. The trend uses the same 30 dates.
- PRs count authored PRs created in the window across configured account and
  repository API sources. A complete API result is independent of whether a
  device is offline. An unused unclassified category does not make the PR total
  incomplete. Missing configured PR sources still do.
- An incomplete PR value is its confirmed numeric count with a **Synced** label.
  No observation is unavailable, including when a source has never returned a
  valid result. A successful empty result is a real zero.
- Enterprise and personal classifications reuse the collector's configured
  categories. Commits retain its author filter and global commit-hash deduplication.
- WoW compares each metric with the date seven China-calendar days earlier.
  Both dates must be covered for that metric. Zero to zero is 0%; zero to a
  positive count is **New**. Missing or partial inputs yield no percentage. The
  current date is incomplete in time, so it is compared with a full prior date
  with that limitation stated beside the table. The oldest six trend dates may
  lack baselines in a 31-day snapshot.
- Repository rows deduplicate a commit within each repository across clones and
  devices. A commit shared by different repositories appears in each row but
  once in the summary. Extra appearances are disclosed separately. Events with
  no repository identity retain their counts in an unattributed row.

The provider reads the existing five-minute collector's private `latest.json`.
The visible Usage panel reads it every five minutes without overlapping requests.
A snapshot older than fifteen minutes, or from an earlier China-calendar date,
is stale and retains its actual counts and capture timestamp. Collection reuses
the existing local routine with cron `*/5 * * * *` in `Asia/Shanghai`; the separate
daily publication keeps its schedule. No second collection routine is created.
The aggregate's optional `localRepositories` object has `version: 1`, `rows` and `attribution`.
Each row contains a SHA-256 identity, a display name, a category and sparse
`daily` entries with `day`, `knownPrs` and `commits`. `attribution` contains unique
global events with known repository identity, using the same daily fields.
The provider validates dates, identities, accounting and bounds; a malformed
repository extension does not discard valid headline totals. Older snapshots
without the extension show repository details as unavailable.

The Agent Town collector and both of its public transports use an independent
aggregate whitelist. `localRepositories` must never be added to that whitelist.
No additional scheduler or network collection runs inside OpenMausBot.

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

Run the affected contracts and owner-access fixture:

```sh
pnpm exec vitest run server/local-agent-teams.test.ts server/local-agent-activity.test.ts server/local-usage.test.ts server/routes/local-dashboard.test.ts server/local-dashboard.e2e.test.ts src/components/AgentTeamPanel.test.ts src/components/AgentTeamPanel.auth.test.ts src/components/AgentActivityDetails.test.ts src/components/LocalUsagePanel.test.ts
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
In both locales at 360px, expand the daily table and scroll fully right. Each
WoW metric name and value must remain visible beside the fixed date column.

For Agent Team use `scenario=live`. No members appear until an office is selected.
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
