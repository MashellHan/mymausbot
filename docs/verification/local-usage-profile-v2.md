# GitHub Profile v2 source

`scripts/local_usage_profile.py` reads the last 60 GitHub Profile source dates for each explicitly configured GitHub or GHE account. It is a provider module, not a scheduled writer. The primary wrapper owns locking, validation, atomic publication, installation and migration. The old `github-profile-v1` sidecar and reader remain separate.

## Input and identity

Call `collect(config, run, repository_category, *, at=None, days=60, previous=None)`. The `run` callback receives an argv list and a bounded `timeout`. It must route each `gh` request through `config.githubHelper` and the selected `githubProfiles[].profile` alias. No global current `gh` account is used.

GitHub recomputes the bounded 60-day window on each call. It does not add `previous` rows or reuse an earlier head as if that proved the current source; `previous` is accepted for the common provider signature only. The integration writer replaces its validated provider snapshot rather than summing captures from two machines.

Each profile must supply `host`, `login`, `profile` and an independently verified `stableId`. Every response checks the viewer's stable ID, login and URL host before admitting data. Missing or mismatched identity produces unavailable rows, never zero. The private configuration and its expected IDs are installed by the migration owner; no account IDs or credentials belong in the repository.

`repository_category(remote, config)` classifies each repository as work, personal or unclassified. The authenticated account and repository category remain independent. Unclassified repositories are retained rather than assigned to a category by guesswork.

## Profile counts and dates

The source queries `contributionsCollection` with `excludeFirst: false` and `excludePopular: false`, fully paginates PR nodes, and checks returned totals, cursors, stable account identity and source consistency across pages. Current fork metadata does not remove a PR that Profile already credited. Commit buckets use `commitContributionsByRepository` and retain GitHub's counts, including eligible merge and coauthor contributions. A repository connection or repository limit that cannot be fully read is unavailable; the module never fills its gap with zero.

The 60 `operationWindow` dates are Profile dates, selected by the UTC source cutoff. Querying one guard day before the first admitted date protects the boundary; guard-day records are not added to the 60 displayed dates. `asOfAt` is the query cutoff, `capturedAt` is completion time. `todayPartial` marks the current calendar interval even when a ready row is fully observed through its cutoff.

A five-minute scheduler must not overlap unbounded provider work. This module caps its work at 120 requests and 180 seconds, with a 30-second ceiling per request. `collection` reports elapsed seconds, request count, completion reasons and the last usable rate-limit observation. A budget or API failure remains partial or unavailable.

## Qualified private supplements

An account may list `privateRepositories` as explicit `owner/name` candidates, for example `"privateRepositories": ["fixture-owner/private-repo"]` in a synthetic fixture. Absence of a list never proves that no hidden private contributions exist. For each candidate, the module verifies authenticated account, repository identity, private nonfork status, and that the repository's User owner has the viewer's stable ID and login. Readable collaborator or organization repositories remain partial and add no supplement without a separately reviewed qualification contract. The module checks creation time, pinned default-branch head and unchanged head at completion. It fully pages all PR states and the pinned default-head commit history. Account ID on a PR or a commit's associated author/coauthor must match the verified viewer. Merge commits are not discarded. It checks event uniqueness and never supplements a metric for a repository already represented by typed Profile records. A changed head, untraversable history, incomplete author connection, overlap or budget exhaustion leaves the source partial while retaining completed typed records. REST `since`/`until` is not used as a continuation algorithm.

`knownPrs` and `knownCommits` are observed typed plus qualified supplement subtotals. Exact `prs` and `commits` stay null unless an independently admitted `visibilityProof` for that same account, cutoff and complete 60-day window matches both totals. Its private input shape is:

```json
{
  "stableId": "fixture-account-id",
  "startDay": "2026-09-11",
  "endDay": "2026-11-09",
  "asOfAt": "2026-11-09T12:00:00Z",
  "prs": 3,
  "commits": 4,
  "evidenceSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}
```

The migration owner independently verifies the evidence bytes, authenticated signed-in account, Profile date scope, cutoff and totals before installing this input. The module checks the account, all 60 dates, exact cutoff, digest shape and both collected totals; it does not treat the digest string alone as proof. A later refresh has a new cutoff and requires new evidence. The frozen November 9 browser cohort cannot make subsequent days or windows complete. A zero restricted count alone never marks visibility complete. Unknown private repositories and dates remain an explicit coverage limit.

## Validation

The synthetic test uses no account token, local Git checkout, live data or scheduled writer. `scripts/local_usage_profile.py.test.ts` is the narrow Vitest adapter selected by `check:edit` for the Python source; it invokes this same suite once:

`python3 -B scripts/local_usage_profile.test.py`

It covers account mismatch and expired auth, historical fork retention, Profile PR pagination, private default-head history and coauthors, changed-head/duplicate/budget rejection, zero-without-proof handling and repeat collection without additive counts. The current personal 59/76 and 164/170 cohort is a separate frozen reference: a later provider correction must be reconciled, not forced into constants. Real account visibility, private eligibility, scheduled capture, authenticated API and UI acceptance remain with the designated integration and delivery owners.
