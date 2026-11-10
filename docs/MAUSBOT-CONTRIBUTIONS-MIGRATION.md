# Versioned Activities source migration

The primary Activities contract is `contributions-v2`. GitHub Profile and ADO
collectors provide separate, authenticated 60-day envelopes. The existing
300-second launchd job remains the only recurring writer; local Token collection
and legacy diagnostic caches retain their own definitions.

The original production data operator prepares and applies the migration under
one finite install/data exclusion. Source review, current-head CI and a signed
App containing `Contents/Resources/usage-helpers` precede that operation. Keep
the previous App, helper files, configuration, source cache, credentials and
routine state available for rollback. The App installer and the data operator
must not execute a switch and migration at the same time.

`scripts/migrate-local-contributions.py` takes explicit private paths. Its
`prepare` command reads the current Activities config, the frozen account API
and ADO principal evidence, the frozen private repository candidate, the
statically parsed pinned ADO author proof, the signed
App's helper resources and the existing launchd plist. It writes a private
candidate config, exact pre-state backups and a hash-bound prepared plan. The
plan binds the scheduled Azure virtual environment Python by its invocation
path, the existing wrapper and collector arguments, its environment and working
directory, and the default config, Azure cache and primary snapshot paths.
`capture` uses that same interpreter and runtime with only a private candidate
config and output path; a base Python with the same resolved binary is not a
substitute for the virtual environment.

The new config adds `stableId` to each configured GitHub Profile and adds
the exact candidate `privateRepositories` values and account helper. The
signed helper set includes `local_usage_profile_private.py`. No stale
`visibilityProof` field is carried forward. The same candidate adds
`adoPrincipals`, `adoAuthorEmails` and
`primaryContributionSource: "contributions-v2"`. It keeps the legacy mixed
`authorEmails` field unchanged for its existing consumers. The ADO author list
contains only independently confirmed corporate aliases; it is never inferred
from the legacy mixed list or current token alone.

`capture --plan-dir <private-plan>` uses that candidate config to collect the
two remote sources into the private plan. It does not collect local repositories
or publish a live cache. `seal --plan-dir <private-plan>` validates both envelopes,
their source IDs, 60-day dates and account/principal bindings, then records an
immutable plan hash and each source's actual coverage. A partial source is
reported as partial, never changed to zero. Review and QA accept the exact
sealed plan and hashes before the original operator applies it.

Under the finite execution exclusion, the operator runs `apply --plan-dir
<private-plan> --expected-plan-sha256 <reviewed-hash>`. The tool verifies that
the launchd plist, signed helper bytes, config, cache and backups still match
the plan. It installs helpers first, then atomically replaces the versioned
cache, then enables the new config last. Every destination is either at its
reviewed before or candidate hash, so an interrupted apply can resume without
adding counts. Repeating a completed apply is unchanged. The lock file keeps
one inode across generations; a second writer fails rather than overlapping.
The operator also owns the existing local collector's `.refresh.lock` directory
for this finite transition; an active collector blocks the apply. An interrupted
owner leaves that lock for explicit owner-exit inspection before a resume.

If the exact candidate must be reverted, `rollback` takes the same plan hash
and disables the config before restoring the old cache and helper files. It
refuses to overwrite a newer scheduled capture or any other changed target.
That case needs a fresh recovery plan, not an automatic data rewrite.

After apply, verify the existing launchd `StartInterval` remains 300, observe a
later scheduled capture timestamp and unchanged writer identity, then read the
running App's authenticated owner API. Compare 1/7/30/60 source days, per-account
and per-repository totals, categories, ADO scope, partial/unknown values and
capture cutoff with the accepted source plan. The returned UI and native screen
are separate checks. `check:delivery request`, signing, isolated startup,
inventory/routines comparisons, saved work, the App's exact-PID graceful switch
and rollback continue to govern the one local App update.

Use only a private plan directory and do not place real account IDs, source
snapshots or author aliases in the repository or PR body. Synthetic tests cover
identity mismatch, a machine with no clones, repeat capture, lock lifetime,
interrupted apply, idempotency and guarded rollback.
