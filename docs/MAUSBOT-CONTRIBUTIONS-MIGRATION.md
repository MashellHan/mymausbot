# Versioned Activities source migration

The primary Activities contract is `contributions-v2`. GitHub Profile and ADO
collectors provide separate, authenticated 60-day envelopes. The existing
300-second launchd job remains the only recurring writer; local Token collection
and legacy diagnostic caches retain their own definitions.

The original production data operator stages privately while the existing
300-second writer continues, then prepares a fresh final plan from the actual
live pre-state under a finite writer exclusion. Source review, current-head CI
and a signed App containing `Contents/Resources/usage-helpers` precede staging.
Keep the previous App, helper files, configuration, source cache, credentials
and routine state available for rollback. The App installer and the data
operator do not switch or migrate concurrently.

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
substitute for the virtual environment. The install candidate keeps
`githubHelper` bound to the exact scheduled installed helper. A separate
capture-only config binds it to the exact signed package resource executable.
The file-auth helper equality and symlink checks remain in force in both paths.
Run the outer migration with `-B`. Capture and its Python workers explicitly
set `PYTHONDONTWRITEBYTECODE=1` in their sanitized environments, so importing
signed package helpers does not create `.pyc` or `__pycache__` in the package.

The new config adds `stableId` to each configured GitHub Profile and adds
the exact candidate `privateRepositories` values and account helper. The
signed helper set includes `local_usage_profile_private.py`. No stale
`visibilityProof` field is carried forward. The same candidate adds
`adoPrincipals`, `adoAuthorEmails` and
`primaryContributionSource: "contributions-v2"`. It keeps the legacy mixed
`authorEmails` field unchanged for its existing consumers. The ADO author list
contains only independently confirmed corporate aliases; it is never inferred
from the legacy mixed list or current token alone.

`capture --plan-dir <staging-plan>` uses the validated, immutable read-only
schema-3 snapshot backup as the first raw ADO continuation seed. Its old UTC
totals and timestamp-free PR rows never become Beijing totals. Later captures
prefer the validated private `candidate-cache.json`, so partial GitHub history
and ADO proof advance instead of restarting. A corrupt, unsafe or incompatible
candidate stops capture. Each call checks the signed helpers, scheduled runtime,
config, immutable seed and exact source identity. The live cache may advance
under the existing writer during private staging; capture neither reads its new
generation nor publishes to it. Missing first-eight-hour coverage and old PR
creation instants need bounded reconstruction. Unknown coverage stays partial.
Once the signed package bytes are frozen, this private staging may overlap the
package owner's isolated acceptance. Neither activity switches the App or
publishes a live cache; both must finish before the serial delivery gate.

Use the reviewed scheduled virtual environment interpreter for the outer
entry and bind every input explicitly. The `prepare` arguments apply to both
the staging plan and a fresh final plan:

```text
<venv-python> -B scripts/migrate-local-contributions.py prepare \
  --plan-dir <private-plan> --config <current-config> --cache <current-cache> \
  --helpers-dir <installed-helpers> --app <signed-app> --launch-agent <current-plist> \
  --evidence-dir <frozen-identity-evidence> --ado-author-proof <pinned-author-proof> \
  --private-profile-candidate <verified-private-candidate> \
  --expected-private-profile-sha256 <candidate-hash> --collector <scheduled-collector> \
  --azure-config-dir <scheduled-azure-dir> --python <venv-python> \
  --ado-author-email <verified-alias>
<venv-python> -B scripts/migrate-local-contributions.py capture --plan-dir <private-plan>
```

Repeat `--ado-author-email` for each separately verified scoped alias. Repeat
the `capture` command while its private continuation is incomplete. Keep its
plan directory owner-only outside the repository and do not read credentials
through a default broker or keychain.

When staging is ready for its honestly qualified coverage, run `seal --plan-dir
<staging-plan>`. It validates the Beijing envelopes, source IDs, cutoff,
continuation and account/principal bindings, then records the immutable plan
hash and actual coverage. Keep that sealed plan as evidence. Under the finite
writer exclusion, prepare a **new** `<final-plan>` from the current live bytes,
then run:

```text
<venv-python> -B scripts/migrate-local-contributions.py adopt-staged --plan-dir <final-plan> --staged-plan-dir <staging-plan> --expected-staged-plan-sha256 <staged-sealed-hash>
<venv-python> -B scripts/migrate-local-contributions.py capture --plan-dir <final-plan>
<venv-python> -B scripts/migrate-local-contributions.py seal --plan-dir <final-plan>
```

Adoption requires the exact staged hash, compatible signed helper hashes,
scheduled runtime, capture/install configuration and source identities. It
copies the validated staged candidate to the private final plan only. The final
capture reconciles the current bounded head/cutoff from that continuation;
it does not repeat completed history. Review and QA bind the **final** sealed
plan, its actual before hashes and candidate hash. A changed live target after
final binding needs a fresh plan, not an edit to a sealed plan. Expired writer
exclusion never permits a mutation.

Under the finite execution exclusion, the operator runs `apply --plan-dir
<final-plan> --expected-plan-sha256 <reviewed-final-hash>`. The tool verifies that
the launchd plist, signed helper bytes, config, cache and backups still match
the plan. It installs helpers first, then atomically replaces the versioned
cache, then enables the new config last. Every destination is either at its
reviewed before or candidate hash, so an interrupted apply can resume without
adding counts. An already enabled `contributions-v2` config whose bytes equal
the final candidate is a valid helper/cache upgrade; the distinct-config
premature-enable guard still rejects an incomplete first install. Repeating a
completed apply is unchanged. The lock file keeps
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

Use only private plan directories and do not place real account IDs, source
snapshots or author aliases in the repository or PR body. Synthetic tests cover
identity mismatch, a machine with no clones, repeat private capture, staged
continuation adoption, lock lifetime, interrupted apply, identical-config
upgrade, external changes, idempotency and guarded rollback.
