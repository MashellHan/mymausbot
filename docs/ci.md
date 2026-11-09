# CI job selection

An ordinary PR runs one cached Ubuntu `static` setup/check job and the
current-head `CI` gate. Applicable typecheck, locale validation, lint and
source guards run beside the fixed 26-file security/data/dispatch core and at
most four portable affected test files. `qa-plan.json` and the log list
additional affected files deferred to full validation, including browser,
Electron and expensive E2E tests. QA holds and independent review still apply.

The first attempt targets five minutes from run creation, including queue and
setup. A rerun uses its current attempt start and retains the original age as
diagnostic. An overrun is an advisory process-scan case: successful checks stay
green, and the gate waits for required work. Actual failures, missing required
execution and unreadable controls remain quality decisions.

Full validation uses **macOS only**: four Vitest shards with
`OMB_VITEST_E2E=all`, plus the selected macOS specialist jobs. Windows and
Ubuntu full suites and platform smokes are retired. Ordinary Ubuntu fast
checks and platform builds/publication retain their separate boundaries.
The legacy `windows` label requests wider macOS validation, as do `ci:full`
and `qa:repair`; it does not select Windows runners.

`scripts/ci-scope.mjs` maps the full merge-base diff, including deletions and
both paths of renames, to affected contracts. Several areas select the union
of their checks; explicit full requests use `FULL_SCOPE`.

| Area | Paths | Mapped contracts |
| --- | --- | --- |
| docs | root Markdown, `docs/`, `apps/docs/`, `.github/FUNDING.yml` | documentation tests |
| locales | non-English `src/locales/*.json`, locale tests | build and locale tests |
| web | remaining `src/`, `public/`, preview pages | build, Vitest and renderer smoke |
| script tests | `scripts/**/*.test.*` | Vitest, renderer smoke and browser identity |
| server | `server/`, `shared/`, `enterprise/`, `companion/`, `evals/`, `skills/`, `deploy/`, Dockerfile and imported renderer modules | build, Vitest, evals, open-source edition, Electron/server smoke, renderer smoke, browser identity and driver |
| desktop | `electron/`, `build/`, `electron-builder.yml`, `index.html` | server contracts, including computer-control modules |
| control plane | `cloudflare/control-plane/` | control-plane checks, workerd tests, broker typecheck/tests and dry run |
| broker | `cloudflare/composio-broker/` | build and control-plane job with broker typecheck/tests |
| relay | `relay/` | Relay typecheck, tests, fuzz and dependency audit |
| shared E2E vectors | `companion/src/e2e/vectors/` | server and Relay contracts |
| everything | workflows, dependency/toolchain configuration, scripts and unknown paths | full selection |

The build includes typecheck, Electron syntax and the production UI build.
The ordinary PR retains applicable static checks and defers the production
build. English copy is a web change because every renderer test reads it;
other catalogs retain their mapped locale subset. Relay has its own lockfile.
The selector tests preserve the renderer/server import and locale boundaries.

## Lanes: pull requests, main and the full lane

| Event | Lane | What runs |
| --- | --- | --- |
| Ordinary `pull_request` | fast | cached Ubuntu static checks, fixed core and bounded affected files, plus required `CI` |
| Explicit wider PR request | full | selected full macOS validation with current-head review and QA holds |
| Runtime `push` to main | full | `FULL_SCOPE`, including four macOS all-E2E shards and specialist jobs |
| `merge_group` | main or full | combined-source macOS validation selected for the integration |
| Guarded docs-only or version-only main push | scoped | smaller selection only with the existing prior-commit or exact merge-group evidence |
| Daily schedule or `workflow_dispatch` | full | complete macOS selection; the daily schedule is `0 21 * * *` UTC, 05:00 Asia/Shanghai |

Runtime main pushes retain full validation even after a merge-group gate.
Docs/version-only guards prevent a coalesced main push from hiding untested
runtime changes. Missing diffs or unreadable CI evidence widen the selection;
unreadable PR controls cannot produce a fast pass.

The required `CI` job binds its selection artifact to the same run, revision
and producing attempt. It checks current PR controls, applicable QA holds and
every selected required job. Failed-job reruns retain valid successful
execution from the same immutable run, with each job's newest attempt taking
precedence. PR pushes supersede that PR's older checks. The independent
process scan records timing overruns without failing or cancelling the gate.

## Vitest shards

The full matrix has four macOS shards, with at most four matrix jobs running
at once and one test file per worker. Each shard collects portable and host
E2E files with `OMB_VITEST_E2E=all`; the previous macOS `host` subset is
insufficient evidence for this selection. Individual OS-specific tests retain
their platform guards. Retiring a platform does not verify its old failures.

Electron unit tests run before the long Vitest block on the first shard.
Broker tests have one owner in the control-plane job. A cheap deterministic
failure therefore appears before the full shard's Vitest work.

`scripts/testing/duration-sequencer.ts` assigns files by recorded duration,
slowest first, to the least-loaded shard. The weights in
`scripts/testing/vitest-shard-weights.json` retain their platform keys for
historical reproduction; current full runs use `darwin`. An unlisted unit
file costs one second in the estimate, and an unlisted E2E file uses the
median recorded E2E duration. Missing or renamed weighted files are checked
by the existing sequencer tests.

Refresh weights from representative completed runs when measured shards drift:

```sh
node scripts/testing/update-shard-weights.mjs --run <run id> --run <run id> --run <run id>
```

To reproduce a current full shard, check out its exact revision, install the
locked dependencies, then use its shard and environment values. For example:

```sh
OMB_VITEST_E2E=all OMB_VITEST_SUBSET= OMB_VITEST_WORKERS=1 pnpm exec vitest run --shard=3/4
```

For an older run, use that run's checkout, platform, shard count and `all` or
`host` mode. Historical Linux/Windows results and macOS host-only results
keep their original coverage; they cannot stand in for the new all-E2E run.
A full suite's wall time must be measured after portable E2E moves to macOS;
removing 16 matrix jobs alone does not establish its new duration.

## macOS runners

The account's macOS capacity is shared by the four shards and specialist
jobs. Ordinary PRs use Ubuntu and do not wait for that fan-out. Full runs
retain the packaged-server and Electron smokes in one macOS job; browser,
renderer, eval, control-plane, Relay and open-source checks use their selected
jobs. Queue time and job time are recorded separately.

`ci-stop-closed.yml` cancels only a closed PR's `ci-pr-<number>` group.
Main, merge-group, nightly and manual runs keep separate concurrency groups.

## Windows

Windows and Ubuntu full-platform tests, packaged-server/CUA smokes and
browser matrices are absent from the current automated full selection.
Their build and publication workflows retain artifact/resource, signing and
release-integrity checks applicable to the platform. Existing local/manual
diagnostic recipes remain available for an explicitly selected platform.
The `windows` label is a compatibility name for an explicit full macOS request.
Old platform failures retain their evidence and disposition until a real
repair, verification or reviewed coverage decision addresses them.

## Browser driver (S4)

`browser driver S4 (<os>)` runs the omb-cdp conformance suites
(`server/browser/cdp/s4-*.e2e.test.ts`) against real Chrome: snapshots across
out-of-process frames and closed shadow roots, every action, dialogs,
downloads, popups and tabs, both evaluation worlds, waiting, the calibrated
identity against the headed browser and across page, worker, service worker,
frame and request headers, Chrome exiting after its controller is killed, and
the latency targets. Each suite records every CDP command its browsers were
sent and fails on `Runtime.enable`, `Runtime.addBinding`, `Console.*`,
`Debugger.*`, `Profiler.*` or an evaluation in the page's own world that the
test did not ask for. The unit tests in the vitest shards hold the same rule
without a browser: the method guard refuses those methods and no driver
source names them.

The same job runs the new browser's suites on that Chrome:
`server/browser/checklist.e2e.test.ts` (the design's checklist items the
browser service owns: tools and refs, sign-ins kept across a restart of the
browser, erase and temporary profiles, uploads, downloads, dialogs, popups,
HTTP sign-in, a person's hold, restart and idle close) and
`server/browser/viewers/viewers.e2e.test.ts` (the page filling the viewer
at the screen's device scale, resizes, presets, acknowledged frames, a
scroll ending on a sharp frame, and the phone's v1 live view against its
golden from agent-browser), `server/browser/passkey-wall.e2e.test.ts` (a
sign-in shaped like Google's that stops at a passkey or a security key: the
bot's notice, the request ending at once as unavailable, Try another way, the
options and a code, and no passkey registered) and
`server/browser/viewers/stream-v2.e2e.test.ts`
(the panel's WebSocket stream through its routes: a 1600x1000 panel getting a
1600x1000 page and 3200x2000 frames on a 2x screen, the page's file picker
answered by an upload, a dropdown list drawn by the viewer, a download served
to it, the page's cursor and copied text).

- The job uses the macOS runner's installed Google Chrome
  (`OMB_CDP_E2E=1`) in wider integration, daily and release validation.
  Ordinary PRs defer it. Linux image-runtime and Windows browser test legs
  are retired from this job.
- It is advisory, outside the `CI` gate, until it has run green for a while.
- The latency targets hold wherever Chrome itself can meet them. The suite
  also times Chrome alone in the same run (the same binary started bare and
  showing a page; a frame and the same mouse events with none of the driver's
  checks), and where Chrome alone is slower, as on GitHub's macOS VM (0.7-1.5
  s to start, 60-75 ms to click, against 0.3 s and 33 ms on a Mac), the driver
  may add only its budget to that.
- On macOS the job locks the runner's Google Chrome app before the suites and
  fails if its version changed: the image's Chrome is older than Google's
  release, and the GoogleUpdater it starts swaps the new version into the app
  about a minute and a half after Chrome first runs, in the middle of the
  suites.
- Locally: `OMB_CDP_CHROME=<chrome executable> pnpm exec vitest run
  server/browser/cdp/s4- server/browser/checklist.e2e server/browser/passkey-wall.e2e
  server/browser/viewers/viewers.e2e server/browser/viewers/stream-v2.e2e` (or
  `OMB_CDP_E2E=1` for the installed Google Chrome). Without either the suites
  skip. `OMB_CDP_TEST_TMP` moves the throwaway profiles.
- `pnpm bench:browser-stream` measures the panel's stream on the installed
  Google Chrome with this computer's display: frame and page sizes, input to
  photon, frame rate, bytes and CPU. It is not part of CI.

## Main and releases

Main's pushes keep one CI run going and one waiting. Each merge replaces the
waiting run, and the running one always finishes, so a burst of merges costs
two runs instead of one per merge (fifteen queued behind each other in October
2026, with the release waiting behind them). Every other run has a group no
push can join, so nothing a merge does cancels it: a merge group is named by
its own ref, and the nightly run and each manual run (the release branch's CI
and the release lane among them) by their event and branch.

`release.yml` requires full macOS CI evidence for the pinned release source,
while platform builds proceed independently. A passing gate and all four
`vitest (macos-latest, all shard N/4)` jobs establish the Vitest coverage.
Scoped runs, missing shards and the historical macOS `host` selection do not.
The script accepts, in order:

1. a completed full run on the release commit;
2. a completed full run on a commit with the identical git tree;
3. the parent's proof when the release changes only `package.json`'s version.

Without that proof, `scripts/release-ci.mjs` starts one manual CI run on the
pinned commit in a temporary `release-ci/v<version>` branch. Its concurrency
group is separate from main. A real red verdict stops release; the existing
failed-job recovery can reuse valid successful work from the same run.
When every failed job never acquired a runner, the release lane can request
its existing one bounded failed-job retry. Main's run is never rerun in place
by that recovery, because it could displace a newer main push.
`ship_without_ci` remains the explicit emergency release input.

Windows/Linux platform test and smoke legs are removed from package/release
workflows. Platform builds, native resource checks, signing and publication
integrity remain required where applicable. These checks do not claim runtime
test coverage for a retired platform.

## Flaky tests and execution timeouts

Known flaky tests are listed in `scripts/testing/ci-retry-list.json`: file,
full test name (describe blocks and test joined with ` > `), owner, the
evidence, and the date it was listed. In CI only (`CI=true`), the repo's
vitest runner (`scripts/testing/ci-retry-runner.ts`) gives each listed test
two retries; nothing else is retried, and local runs never retry. Retries
are bounded per file: once a listed test fails all three attempts, that is a
real failure, and the file's later listed tests get no retry. Otherwise a
regression that breaks a whole fixture (six listed tests share
`server/delta-context.e2e.test.ts`) would triple their wall time and push the
shard past its execution cap, and a timed-out job loses the failing
tests' annotations and this summary. The cost: a real flake listed after a
broken test in the same file is not retried in that run. A listed
test that needed a retry is written to the vitest job's summary and raised as
a warning annotation (`scripts/testing/ci-retry-summary.mjs`), so a flake
that passed is still seen. Fix the test, then delete its entry;
`scripts/testing/ci-retry-list.test.ts` fails on an entry whose test no longer
exists.

Execution timeouts bound a hung test, setup or job; they are separate from
the ordinary PR's advisory five-minute performance target. Collect measured
macOS all-E2E durations before tuning shard balance or execution limits.
A timing scan case does not erase the actual result or close a useful PR.

## Linux on Boat

While `BOAT_CI=on`, eligible owner-authored and owner-started main/merge-group
runs can use one `boat-xlarge` VM for `static`, named `typecheck + lint (Boat)`.
Ordinary PRs remain on hosted Ubuntu. Daily/manual runs and ineligible actors
use GitHub-hosted static checks. Full tests remain separate macOS jobs;
Boat does not absorb Linux full-test lanes under this policy.

The existing allow-list, owner checks and one-start boundary remain in the
workflow. `boat ci` and the Boat dashboard expose job logs. Set `BOAT_CI` to
`off` to select hosted runners for subsequent eligible runs; classify an
existing runner outage separately from test failures.

## Required check

The repository requires the single GitHub Actions check named `CI`.
Changing that job name requires coordinated branch-protection changes;
otherwise GitHub can wait for a check that no workflow produces.

## Merge queue

The workflow supports `merge_group` and validates its combined source on
current main. The active personal repository's strict branch protection
requires each normally merged PR to include current main, so sequential
merges can require branch updates and repeated CI.

For compatible, independently accepted changes, Lead can compose the original
commits into one focused integration PR, review actual conflicts and new risks,
and validate that combined head once. Preserve meaningful commits and source
binding. An unchanged composition does not justify replaying every source
review, test or package build.

A hosted GitHub merge queue requires repository support and an explicit
configuration decision. Its concurrency must fit the shared macOS capacity;
old Linux/Windows job counts are not a capacity estimate for this policy.
Runtime pushes retain full validation, and closed-PR cleanup touches only that
PR's own concurrency group.

## MausBot fork validation rhythm

The fork adds shared local planning, shadow admission, daily full QA at 05:00
Asia/Shanghai, trusted issue reporting and a Lead queue. See
[MausBot validation](MAUSBOT-VALIDATION.md)
for commands, exact boundaries, holds, recovery and rollout evidence.
