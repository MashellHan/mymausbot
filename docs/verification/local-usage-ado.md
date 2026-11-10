# Remote Azure DevOps contribution source

`scripts/local_usage_ado.py` exports `collect(config, run, repository_category,
*, at=None, days=60, previous=None)`. It returns an `ado-default-head-v1`
version 2 envelope. It reads remote Azure DevOps data only. It never uses local
clones, writes a cache, changes authentication, or starts a scheduler.

## Scope and identity

`mergedAdoProjects` and `adoRemotes` select project URLs. The collector
canonicalizes organization/project pairs and rejects malformed or duplicate
repository discovery. Each organization must have an explicit
`adoPrincipals[organization.lower()] = {"stableId": "<verified GUID>",
"alias": "<verified lowercase account email>"}`. The authenticated
`connectionData` ID and alias must match before any data is admitted. Every PR
creator ID must also match; an API creator filter alone is insufficient.
`adoAuthorEmails` is the separately confirmed corporate historical
author/coauthor alias set. It is required and never falls back to the mixed
legacy `authorEmails` list. A missing or malformed scoped list makes the source
unavailable. Changing it invalidates cached pinned-head attribution and forces
reconciliation. The principal ID and alias remain a separate identity check.
A matching token with a different organizational principal is unavailable,
never an implicit replacement account.

The caller supplies the existing Azure in-memory authenticated GET executor as
`run(argv, timeout=seconds)`. In addition to identity and PR reads, its narrow
allowlist must permit project repository lists, repository default-branch refs,
pinned commit-list pages and individual commit details. The module requests
JSON with the existing Azure DevOps resource ID, and stores no bearer token.

## Counting and coverage

The window contains exactly 60 UTC dates ending on the UTC capture date.
`todayPartial` marks the current day as observed only through the source
cutoff. Created PRs count in active, completed and abandoned states; PRs are
bucketed by creation instant. The collector pages all creator-filtered PR
states without trusting a server-side date filter. It locally verifies creator,
repository, status and UTC creation date, then rechecks the first page before
certifying pagination. A failed page admits no prefix; duplicate or drifting
pagination restarts before any exact PR count is published.

The temporary repository scope is the explicit `adoRemotes` allowlist, bound
by name to the authenticated project inventory. The configured remotes come
from separately verified recent activity; the collector does not infer a
complete active-repository list from PRs or scan every project repository.
For each selected enabled repository with a default branch, it pins the remote
ref object ID and pages history reachable from that exact head. It counts the
full 60-day window inside each selected repository, including earlier activity.
Candidate commits use **author UTC date**, not committer date. Full details
verify the author date, parentage, untruncated message and recognized
`Co-authored-by: Name <email>` trailers and the single literal
`&lt;email&gt;` delimiter form returned by ADO. Other encoded or mixed forms
remain incomplete. A commit qualifies when its author or coauthor email belongs
to the confirmed alias set. Merge commits remain in
the count. A candidate authored after an earlier cutoff stays in the pinned
cache and is admitted only once a later cutoff reaches it. A missing or
malformed detail does not become zero.

The duplicate key is organization plus repository GUID plus commit ID. A
shared commit ID in two genuinely different repositories is two repository
contributions under this definition. The source checks overlapping project
inventory so the same repository cannot be counted twice through two project
aliases. The PR key is organization/project scope plus repository GUID plus PR
ID. The repository category callback determines work/personal/unclassified
independently of the authenticated account.

Disabled repositories remain explicit visibility gaps; they are not assigned
zero commits. A verified repository with no default branch has no reachable
default-head commits. Previously observed repository IDs and explicitly
configured remotes remain expected scope: disappearance from a later inventory
or an unexplained empty first inventory stays partial or stale, not zero.
Unselected repositories may contain commit-only activity that the allowlist did
not observe. Provider-wide totals remain partial with known selected subtotals;
selected repository rows may become exact only after their own pinned history
is complete. A missing or ambiguous configured name never selects a substitute.
Missing refs, incomplete pages, expired authentication,
budget exhaustion and malformed coauthor evidence keep exact totals null.
Exact PR totals also require verified repository visibility; a complete PR
page scan against an unverified empty inventory yields a known zero prefix,
not an exact zero. Known typed subtotals contain only observed PR pages and
completely reconciled repositories. A new incomplete scan may retain the prior
exact rows as `stale`
with their original day capture times. Source and collection coverage disclose
the incomplete reason; a stale row is not a current pass.

## Bounded continuation

Each refresh uses at most 180 seconds overall, 42 seconds and 50 GETs per
project, 8 GETs per repository slice, and 20 seconds per request. Existing
pinned scans receive rotating slices before a newly selected repository opens;
remaining project budget can give them further slices in the same call. A
project continues in the next envelope's
private `state`; only the collector consumes it. Each commit page is at most
100 records, and a repository scan stops after at most 1,000 pages. Complete
selected-repository proof does not certify activity in unselected repositories.

Once a repository has a complete pinned-head result, an unchanged head reuses
it. **Any changed head gets a complete new pinned-history traversal.** The
previous head cannot bound reachability: a newly merged side branch may appear
after it in the API's commit sequence. The changed-head result replaces the
old result only after the full traversal finishes. This catches late merges,
old author dates and force pushes without relying on `fromDate`/`toDate`
server filtering. A resumed scan finishes its immutable pin even if the branch
advances. A final ref mismatch keeps the complete pinned DAG proof privately,
marks current coverage incomplete, and starts a full traversal of the new head.
Only previously checked immutable commit details are reused during that full
traversal; every reachable commit ID is still enumerated, so a side branch
after the old head is counted. An absent old head classifies the new graph as
rewritten and old counts cannot enter it. UTC window rollover refreshes identity,
inventory and PR pages for the new cutoff while retaining only incomplete
repository scans whose ID and default branch still match that inventory.
Completed pinned proofs remain cached. Neither a request budget nor a force
push can turn an unscanned portion into a certified zero.

The private state, account identities and repository names stay in the local
usage snapshot. Public PR text and logs must not include the user's private
organization data. The separate canonical Activities reader validates the
version, identities, dates, counts and coverage before showing totals.
The existing 300-second refresh cadence stays serialized. A warm refresh under
60 seconds is an advisory target, requiring measured cold, unchanged-head and
small-new-commit runs on the reviewed scoped source.

## Verification

`scripts/local_usage_ado.py.test.ts` invokes the Python suite through normal
Vitest selection; `python3 scripts/local_usage_ado.test.py` runs it directly.
The suite uses a pure synthetic argv transport.
It covers all PR states, UTC boundary, author and coauthor attribution, merge
commits, budget resumption, pinned-head reuse, force push, identity mismatch,
disabled/missing repositories and malformed creator/trailer evidence. The
frozen private ADO reference proves one pinned repository's 23 target-day
commits, including 13 merges, and the inventory shows 1,100 visible
repositories with 477 disabled and 13 lacking a default branch. That reference
is **not** an all-work total. A new authenticated end-to-end ADO capture and
cross-account migration remain separate integration evidence.
