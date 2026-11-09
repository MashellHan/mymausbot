# Local Usage and Agent Team panels

These panels are local-owner observations. Their existing routes reject paired
devices, remote/proxied requests and service trust. No terminal output, complete
conversation, checkout path or credential is returned. Repository names and a
bounded, redacted latest instruction are available only through those routes.

## Usage definitions

- The 1, 7 and 30 day windows include the capture date through the displayed
  timestamp in Asia/Shanghai. The trend uses the same 30 dates. Window changes
  compare the previous non-overlapping period; daily changes compare the same
  China-calendar date one week earlier. The capture day is still in progress.
- PRs count PRs authored by the verified account owner and merged remotely in
  the window. Their creation date and the device performing the merge do not
  affect the count. Closed but unmerged PRs are excluded.
- Commits count the original non-merge commits returned by those merged PRs,
  including other contributors' commits within an owner-authored PR. A PR with
  five original commits contributes five even after squash merge. Direct pushes,
  unmerged branches and merge commits do not contribute. Both metrics use the
  PR merge date, rather than a local author or commit timestamp.
- PR identity includes the host and stable remote identity. Original commit SHAs
  are deduplicated across PRs, devices and clones, and assigned to the earliest
  observed merge within retained history. Conflicting categories are unclassified.
  Repository rows deduplicate each SHA at its earliest merge within that repository;
  a SHA shared by repositories can appear in several rows but once in the summary.
- Enterprise and personal classification follows the existing repository rules.
  GitHub/GHE searches cover the configured verified accounts. Azure DevOps queries
  cover all repositories in each configured project, without requiring local
  clones. `mergedAdoProjects` accepts HTTPS project URLs; known `adoRemotes` also
  identify projects. Preserve known project configuration when moving devices.
- Complete remote results are exact totals. Incomplete results show confirmed
  numeric counts; the circle alert beside the period reveals coverage and missing
  dates on hover, focus or click. Unobserved values are unavailable.
  Only a successful complete empty result is a verified zero. Incomplete PR or
  commit periods do not produce percentage comparisons. Zero to zero is 0%;
  zero to a positive count is **New** only for a comparable metric.
- Tokens remain local, including cache reads. Their existing synced-device
  comparison scope is preserved. Remote and token captures have independent
  timestamps; open the information icon beside Usage to inspect both. If capture dates
  differ, tokens are joined by calendar date to the displayed remote windows.
  Missing token dates stay unavailable, and an unavailable comparison stays null.
  Missing remote data never falls back to created PRs or local Git commits.

The existing five-minute `scripts/refresh-local-usage.py` job writes the private
`~/.local/share/mymausbot/usage/merged-v1.json` sidecar through its adjacent
`local_usage_merged.py` module. Deploy both files together. No new scheduler runs
inside the App, and the disabled chat-notifying collection routine is not needed.
The Activities Mini App reads every five minutes. Agent Team and Activities are
available through Mini Apps; the separate Computer tabs are removed.
Remote collection retains 60 China-calendar days for current and previous
30-day periods. API/page/time limits and unavailable credentials are coverage
gaps, not zero. Completed per-PR commit lists can be reused during later refreshes.

The existing Agent Town `latest.json`, public aggregate whitelist and nightly
report retain their original definitions for compatibility. The App reads local
Token metrics from that aggregate and remote PR/commit metrics from the separate
optional `merged` response field. The sidecar is private with mode 0600; event
identifiers are hashed, and credentials are never written to it. Remote events
and repository metadata are not added to public transports. Stale data retains
its actual event dates; transient API/read failures do not erase a good stream.

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
