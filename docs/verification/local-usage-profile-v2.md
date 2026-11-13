# GitHub Beijing-day contribution source

`scripts/local_usage_profile.py` reads the last 60 Beijing calendar days for each explicitly configured GitHub or GHE account. Its metric is `github-profile-beijing-v1`: PRs use creation instants and default-head commits use author instants, including merge commits. It is a provider module, not a scheduled writer. The primary wrapper owns locking, validation, atomic publication, installation and migration. The old `github-profile-v1` diagnostic sidecar and reader remain separate.

## Input and identity

Call `collect(config, run, repository_category, *, at=None, days=60, previous=None, focus_start=None)`. The `run` callback receives an argv list and a bounded `timeout`. It must route each `gh` request through `config.githubHelper` and the selected `githubProfiles[].profile` alias. No global current `gh` account is used.

The provider recomputes the bounded 60-day window on each call. `previous` retains raw, source-bound pinned-head evidence and partial traversal progress, never old daily totals as new results. The integration writer replaces its validated provider snapshot rather than summing captures from two machines.

Each profile must supply `host`, `login`, `profile` and an independently verified `stableId`. Every response checks the viewer's stable ID, login and URL host before admitting data. Missing or mismatched identity produces unavailable rows, never zero. The private configuration and its expected IDs are installed by the migration owner; no account IDs or credentials belong in the repository.

`repository_category(remote, config)` classifies each repository as work, personal or unclassified. The authenticated account and repository category remain independent. Unclassified repositories are retained rather than assigned to a category by guesswork.

## Profile counts and dates

The source queries `contributionsCollection` with `excludeFirst: false` and `excludePopular: false`, fully paginates PR nodes, and checks returned totals, cursors, stable account identity and source consistency across pages. PR day comes from each `createdAt`, including when the Profile bucket differs. Current fork metadata does not remove a PR that Profile already credited. The Profile commit buckets check connection completeness and identify repositories; they cannot be shifted into Beijing days. Author timestamps and verified account/coauthor IDs come from pinned default-head commit history. A repository connection or repository limit that cannot be fully read is unavailable; the module never fills its gap with zero.

The 60 `operationWindow` dates end on the Beijing date of the UTC source cutoff. On a warm capture with complete prior PR coverage, `focus_start` bounds the ordinary Profile and private PR discovery requests to the unpaid Beijing days through that cutoff; older same-scope PR observations retain their original dates. Cold or explicit full discovery rechecks the wider history and can authoritatively lower an old count. The full Profile query starts one UTC day before the 60-day window to guard PR date placement. A cached author event cannot prove current-head reachability. Complete pinned proof is reused for the same head; a normal advance pages the new DAG to the proven old head and batches commit details, including older side merges. An incomplete pinned scan continues across captures even when the default head advances. Diverged history gets a fresh bounded scan. No date-ordered early stop certifies coverage. `asOfAt` is the query cutoff, `capturedAt` is completion time, and `todayPartial` marks the open Beijing day.

A five-minute scheduler must not overlap unbounded provider work. This module caps one invocation at 120 requests and 25 seconds, with each request limited by the remaining budget. The provider persists incomplete pinned-history progress in its private state and continues it on later cycles; an unchanged, settled day does not trigger a full-window query. The writer's Shanghai focus includes yesterday before 00:30 and keeps any older unpublished day as debt. It publishes PR/commit data before waiting for legacy Token work; the 30-second end-to-end target remains unmeasured pending reviewed installation and natural readback. `collection` reports elapsed seconds, request count, completion reasons and the last usable rate-limit observation. A budget or API failure remains partial or unavailable.

## Qualified private supplements

An account may list `privateRepositories` as explicit `owner/name` candidates, for example `"privateRepositories": ["fixture-owner/private-repo"]` in a synthetic fixture. Absence of a list never proves that no hidden private contributions exist. For each candidate, the module verifies authenticated account, repository identity, private nonfork status, and that the repository's User owner has the viewer's stable ID and login. Readable collaborator or organization repositories remain partial and add no supplement without a separately reviewed qualification contract. The module checks creation time, pinned default-branch head and unchanged head at completion. It fully pages all PR states on a cold capture and uses bounded creation-date search on a warm focus, retaining older qualified supplements even when a new typed Profile PR appears in the same repository. The shared pinned history supplies commit author events for typed and qualified private repositories. Account ID on a PR or a commit's associated author/coauthor must match the verified viewer. Merge commits are retained. A changed head, untraversable history, incomplete author connection, overlap or budget exhaustion leaves the source partial. REST `since`/`until` is not a continuation algorithm.

`knownPrs` and `knownCommits` are observed typed PR plus qualified private PR and raw reachable-commit subtotals. Exact `prs` and `commits` stay null unless an independently admitted `visibilityProof` for that same account, cutoff and complete 60-day window matches both totals. Its private input shape is:

```json
{
  "stableId": "fixture-account-id",
  "startDay": "2026-09-11",
  "endDay": "2026-11-09",
  "asOfAt": "2026-11-09T12:00:00Z",
  "prs": 3,
  "commits": 4,
  "metricDefinition": "github-profile-beijing-v1",
  "dateBasis": {"prs": "created-at/Asia-Shanghai", "commits": "author-at/Asia-Shanghai"},
  "evidenceSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}
```

The migration owner independently verifies the evidence bytes, authenticated signed-in account, Beijing date scope, cutoff and totals before installing this input. The module checks the account, definition, all 60 dates, exact cutoff, digest shape and both collected totals; it does not treat the digest string alone as proof. A later refresh has a new cutoff and requires new evidence. A zero restricted count alone never marks visibility complete. Unknown private repositories and dates remain an explicit coverage limit.

## Validation

The synthetic test uses no account token, local Git checkout, live data or scheduled writer. `scripts/local_usage_profile.py.test.ts` is the narrow Vitest adapter selected by `check:edit` for the Python source; it invokes this same suite once:

`python3 -B scripts/local_usage_profile.test.py`

It covers account mismatch and expired auth, historical fork retention, Profile PR pagination, private default-head history and coauthors, changed-head/duplicate/budget rejection, zero-without-proof handling and repeat collection without additive counts. The current personal 59/76 and 164/170 cohort is a separate frozen reference: a later provider correction must be reconciled, not forced into constants. Real account visibility, private eligibility, scheduled capture, authenticated API and UI acceptance remain with the designated integration and delivery owners.
