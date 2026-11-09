# Bounded GitHub contribution repair

`scripts/repair-local-usage-github.py` operates only on the private
`~/.local/share/mymausbot/usage/github-profile-v1.json` sidecar. It reuses the
collector, bounded replacement and OS target lock from `local_usage_github.py`.
It does not deploy helpers, change configuration or scheduling, collect Tokens,
refresh legacy aggregates, publish reports or restart the App.

Source preparation is separate from production data admission. Before executing
any command below, Lead must have accepted the contribution definition/source and
reference reconciliation, independent repair review/QA and the data-admission
record. The admitted private operation configuration must explicitly opt in to
`githubContributionSource: "github-profile-v1"`. Source changes alone do not
complete a repair or activate the installed helper's configuration.

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
persistent `github-profile-v1.lock` file, introduce a second lock or assume a
previous inventory proves that no new writer exists. An active writer causes
immediate refusal.

## Prepare and review

The default remains seven inclusive China dates. Only an independently admitted
60-day restoration uses `prepare --days 60`; no other span is accepted. This flag
does not enable the source or change a scheduler. Existing seven-day plans keep
the same format and validation. The selected span is bound by the exact start/end
dates in the immutable capture and plan; apply cannot change it.


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
a new 0700 directory. On POSIX, each directory entry in the snapshot hierarchy
is synced in its parent before the plan is returned, including existing ancestors
that might remain from interrupted preparation. It does not replace the target.
An interrupted preparation without `plan.json` is unusable; preserve evidence and
prepare a new directory.
Never commit or publish these private files, raw records or configuration.

Review the printed plan SHA256, source/runtime identity, before/after hashes,
capture cutoff, active stable account scopes and exact inclusive operation dates.
The capture day plus preceding six (default) or 59 (`--days 60`) China calendar
dates are recomputed from execution time, with today partial. For example, an
execution on November 9 covers November 3–9 by default, or September 11–November 9
with the explicit 60-day span. A later execution requires a new capture/plan.
The UTC guard date is never an additional replacement date. Unknown or invalid sources refuse the
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
A repeated application preserves the same bytes and completes directory sync
even if a previous attempt was interrupted after rename. It preserves earlier
history and inactive source partitions through the existing bounded replacer; it never
turns old-definition history into comparable new-definition observations.

After an admitted real application, independently read every admitted persisted day (7 or 60)
through the provider from a clean, exact reviewed main checkout, with its source
commit and actual sidecar path recorded. Reconcile typed references and their
date/coverage limits, verify earlier-history hashes and unrelated Token,
report/config/archive paths, and record installed source/version separately.
The old installed reader does not consume this source: source-provider readback
must be identified separately from live App display. Updating or installing the
App is not a prerequisite for admitted data application. Rendered UI acceptance
remains pending until a reader that consumes this source is actually in use;
synthetic persistence tests establish neither production nor live UI acceptance.

For rollback, using the same reviewed source/runtime and original private plan:

```sh
python3 scripts/repair-local-usage-github.py restore \
  --operation-dir "$OPERATION_DIR" --plan-sha256 "$REVIEWED_PLAN_SHA256"
```

Restore is available after the capture day and after interruption before/after
replacement. It restores exact prior bytes, or removes only the newly created
target when the snapshot records initial absence, syncing its parent after
deletion on POSIX. Repeated restore also syncs the parent before success,
including after an interrupted rename or deletion. It refuses a later writer's
changes instead of losing them. The immutable snapshot survives both operations;
do not discard it until independent reconciliation and recovery acceptance.

For isolated synthetic regression only, run:

```sh
python3 scripts/repair-local-usage-github.test.py
```

Production capture/apply/restore, actual-reader readback and UI verification
remain pending until their separate admission and execution evidence exist.
