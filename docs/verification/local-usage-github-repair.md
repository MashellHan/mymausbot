# Bounded GitHub contribution repair

`scripts/repair-local-usage-github.py` operates only on the private
`~/.local/share/mymausbot/usage/github-profile-v1.json` sidecar. It reuses the
collector, bounded replacement and OS target lock from `local_usage_github.py`.
It does not deploy helpers, change configuration or scheduling, collect Tokens,
refresh legacy aggregates, publish reports or restart the App.

Source preparation is separate from production data admission. Before executing
any command below, Lead must have accepted the contribution definition/source and
reference reconciliation, independent repair review/QA and the data-admission
record. The existing private configuration must explicitly opt in to
`githubContributionSource: "github-profile-v1"`. Source changes alone do not
complete a repair or authorize an installation.

## Preconditions and writer inventory

Use the reviewed clean source commit with its recorded Python version. The entry
binds its own module and both adjacent contribution modules to that Git commit,
and the external collector's exact bytes to the supplied SHA256. Only its existing
`run` and `remote_category` functions are used; its refresh entry is not called.
Record the installed helper/source identity separately from this operation.

Immediately before preparation, recheck every actual writer: interval job
ProgramArguments, installed wrapper bytes, opt-in configuration, enabled nightly
callers and any manual writer. Legacy callers without the new source module do
not write this sidecar; their presence alone does not require stopping unrelated
jobs. Any caller writing this target must use the same OS lock. Do not remove its
persistent `.lock` file, introduce a second lock or assume a previous inventory
proves that no new writer exists. An active writer causes immediate refusal.

## Prepare and review

After admission, choose a new operation directory outside the live target tree,
under a private parent. Substitute the actual admitted configuration/collector
paths and independently verified collector hash:

```sh
python3 scripts/repair-local-usage-github.py prepare \
  --config "$CONFIG_PATH" --collector "$COLLECTOR_PATH" \
  --collector-sha256 "$COLLECTOR_SHA256" --operation-dir "$OPERATION_DIR"
```

Preparation is a dry-run: it queries the authenticated typed source and retains
an exact private `before.bin` snapshot (or explicit initial absence),
`capture.json`, bounded `after.json` and immutable `plan.json`, all mode 0600 in
a new 0700 directory. It does not replace the target. An interrupted preparation
without `plan.json` is unusable; preserve evidence and prepare a new directory.
Never commit or publish these private files, raw records or configuration.

Review the printed plan SHA256, source/runtime identity, before/after hashes,
capture cutoff, active stable account scopes and exact inclusive operation dates.
The capture day plus preceding six China calendar dates are recomputed from the
current execution time, with today partial. For example, an execution on November
9 covers November 3–9; a later execution requires a new capture/plan. The UTC guard
date is never an eighth replacement date. Unknown or invalid sources refuse the
repair, rather than producing zero. Existing stable account changes also refuse.

The definition remains `github-profile-v1`: PRs are the visible current-nonfork
subset projected from creation instants onto China dates; commits retain Profile
bucket labels. Exact China commit totals, complete private/email coverage and
global SHA uniqueness remain uncertified. Typed exact counts and comparisons in
the reader remain null. See [the source contract](local-dashboard.md).

## Apply, read back and recover

```sh
python3 scripts/repair-local-usage-github.py apply \
  --operation-dir "$OPERATION_DIR" --plan-sha256 "$REVIEWED_PLAN_SHA256"
```

Apply verifies the reviewed plan/payload/source bytes, current execution date and
capture cutoff under the same target lock. It refuses target changes since the
snapshot, then atomically replaces only that sidecar and checks persisted bytes.
A repeated application of the same plan is a no-op. It preserves earlier history
and inactive source partitions through the existing bounded replacer; it never
turns old-definition history into comparable new-definition observations.

After an admitted real application, independently read all seven days through
the actual host provider and rendered UI, reconcile typed references with their
date/coverage limits, verify earlier-history hashes and unrelated Token,
report/config/archive paths, and record installed source/version separately.
Synthetic persistence tests do not establish this actual-reader/UI acceptance.

For rollback, using the same reviewed source/runtime and original private plan:

```sh
python3 scripts/repair-local-usage-github.py restore \
  --operation-dir "$OPERATION_DIR" --plan-sha256 "$REVIEWED_PLAN_SHA256"
```

Restore is available after the capture day and after interruption before/after
replacement. It restores exact prior bytes, or removes only the newly created
target when the snapshot records initial absence. It refuses a later writer's
changes instead of losing them. The immutable snapshot survives both operations;
do not discard it until independent reconciliation and recovery acceptance.

For isolated synthetic regression only, run:

```sh
python3 scripts/repair-local-usage-github.test.py
```

Production capture/apply/restore, actual-reader readback and UI verification
remain pending until their separate admission and execution evidence exist.
