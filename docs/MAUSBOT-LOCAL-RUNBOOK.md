# Local MausBot build and recovery

The reviewed Activities `contributions-v2` source uses the existing scheduled
helper installation. Follow [its finite migration and rollback recipe](MAUSBOT-CONTRIBUTIONS-MIGRATION.md)
before calling the new reader/data operation delivered; source and App packaging
alone do not establish recurring capture or account reconciliation.
The Beijing-day reader requires a new signed App from reviewed, merged source.
After isolated package acceptance, the data operator stages a private capture,
binds a fresh final plan to current live bytes, and coordinates a serial App
switch and data apply under the existing finite writer exclusion. Restore that
same 300-second writer only after the package owner is idle and the data apply
and readback have completed.

Keep the official `/Applications/OpenMausBot.app`, the user's data and paired
devices intact. Build products and private handoff evidence stay outside Git.
Follow [the current validation policy](MAUSBOT-VALIDATION.md) and assign one
package/update owner. The historical initial local arm64 bundle was
`release/mac-arm64/OpenMausBot.app`, version
0.1.139, with Electron 43.7.9 and CUA Driver 0.28.2.

## Current delivery entry points

Use the current private job and its existing guarded switch/rollback workflow.
Before compilation, run `pnpm check:delivery request <job>/rebuild-request.json`.
This read-only preflight requires the source checkout/commit/tree/ref, lockfile
hash, App version, distinct package/normal/official App paths, Downloads purpose
and environment identity. It checks clean source and the pinned ref/lock against
the request. Fetch the source ref before binding it. Supply the actual current
request; do not copy a previous acceptance receipt as a build request.

Check the selected scheduled interpreter, arguments and environment before
building. Migration accepts the scheduled absolute `AZURE_CONFIG_DIR` only when
it exactly matches the selected directory; without that variable it retains
the default. Preserve `PYTHONDONTWRITEBYTECODE=1` when scheduled. Do not repair
a mismatch by changing authentication routing or falling back to a Keychain.

Use the shared helper checks in switch, recovery and installed postflight callers:

```text
pnpm check:delivery installed-helpers <canonical-installed-directory> <source-hashes.json>
pnpm check:delivery signed-helpers <canonical-package-directory> <source-hashes.json>
```

The hashes document maps every bound Python source filename to its SHA-256.
Installed helpers may contain CPython caches for those exact names, including
hyphenated script names. Unknown caches, source changes, unsafe permissions,
symlinks and hardlinks fail. Signed package helpers remain cache-free.

Run one `pnpm build`; it includes `pnpm typecheck`. The compiler keeps separate
UI/server incremental state in this worktree and revalidates changed inputs.
Do not run raw `tsc -b` or a second full typecheck as an additional prerequisite.
For a necessary development-only check, select `--project ui` or `--project
server`; CI and `--fresh` always start without compiler state. Keep existing
emitting server/companion builds and required native/package checks.

Before a new Electron fixture run, execute `pnpm check:fixtures`. Reuse the
existing async launcher and phase-specific bounds. A first-use UI change needs
an empty-profile interaction, not only an already populated screenshot. Source
rendering and actual packaged preload/startup evidence serve different checks;
carry unchanged visual evidence instead of repeating its complete matrix.

Canonicalize fixture directories with filesystem `realpath` before constructing
sandbox rules; `/tmp` may name `/private/tmp` on macOS. Put sandbox canaries and
startup inside the same cleanup boundary. If a collector parses Node test
output, select `--test-reporter=tap` explicitly instead of assuming the default
reporter. Record phase durations and retain failed attempts in the existing job.

The guarded switch's read-only postflight uses these shared comparisons:

```text
pnpm check:delivery routines <before-routines.json> <after-routines.json>
pnpm check:delivery inventory <before-inventory.json> <after-inventory.json>
```

Routine configuration stays exact; known scheduler/check metadata and the
startup identity may advance. Existing run identities, authority, source and
established result/execution routes remain intact while status/output may
progress and new runs may appear. A queued check with no prior check key or
execution may acquire its prompt/key and initial result route; a new Routine
result route requires a matching new run or queued-check allocation. Existing
keys and routes cannot be replaced or removed. Unknown configuration stays exact.
Other migrations, route repairs, receipt changes or scheduled definition changes
need explicit evidence and owner review. A failed comparison holds acceptance;
it is not by itself a reason to roll back or overwrite newer runtime data.
Inventory comparison permits only missing/null `shippedTemplateKind`; changed
IDs, revisions, grants or publishers fail. Use the same comparisons in the
recovery workflow. Keep configuration, credentials, paired sessions, phone,
signature and actual-package checks; these helpers neither perform nor approve
an App mutation. Prepare rollback before an already authorized switch.

Retain stage start/end, source and outcome in the existing job log. A stage
failure resumes at the failed stage only if its inputs remain valid. Keep the
original failure and the original request-to-delivery clock across corrections.
The assigned installer completes the already authorized quit, copy, launch and
postflight sequence without another role handoff between successful stages.
Escalate actual findings; elapsed-time targets are advisory, not failure gates.

A finite switch hold covers mutations and every new or recovery App launch.
Check actual writer exclusion and expiry after any blocking probe, immediately
before opening the intended binary. Once that launch succeeds inside the hold,
read-only postflight does not require renewing its expiry. Keep actual writer
and scheduler exclusion until the installer finishes preservation checks and
explicitly becomes idle; the existing operator then restores the same job.
Another write or launch still needs current admission. A readback failure does
not authorize a restart, rollback or overwrite of newer user state.

For a closed SQLite database, inspect an owned copy with its complete WAL,
bound to unchanged source bytes before and after copying. Let SQLite create
sidecars only in that copy. A read-only open of the closed original may fail
when its WAL/SHM disappeared; `immutable=1` is not a substitute for reading
pending WAL data. Never assume another database's WAL is empty. After launch,
browser caches may change, including during graceful quit: check their safe paths, ownership and permissions
once, while retaining exact static credential and prelaunch checks. Do not
compare two mutable snapshots taken across an unrelated bundle hash.

Run the signed package check in a disposable profile with
`pnpm verify:private-file-credentials --app <absolute-signed-app> --evidence <absolute-private-evidence-dir>`.
It records one attempt per run and the elapsed time since the first attempt.
For a closed data copy, use `pnpm check:delivery closed-sqlite <canonical-source-dir> <canonical-owned-copy-dir>`;
`pnpm check:delivery private-storage <canonical-temp-fixture-root> postlaunch`
checks the private root without comparing changing browser content. That command
accepts only canonical, owner-only `omb-private-file-e2e-*` temporary roots;
it does not inspect an installed live profile.
The packaged fixture takes a stable-credential snapshot immediately before
quit, waits for its owned process group to exit, then uses `private-storage`
with `postquit <before-quit.json>` to compare the marker and all non-browser
records. A normal browser flush may change browser bytes; the resulting closed
snapshot becomes the exact expectation for the next launch. Never reuse a
running browser digest as a closed-profile expectation, or accept changed or
missing stable credentials. The closed comparison alone does not prove process
exit. Live switch and rollback callers must establish that boundary and bind
their backup to the closed profile before copying or relaunching.

## Resume an existing package

Read the current job's `build.log`, `finished` and `exit-code` before doing
anything. A packaging failure after successful compilation is not a reason to
download dependencies or rebuild the whole application.

The initial job completed the frozen-lockfile install, Electron syntax check,
UI/server/companion/updater builds, native resource staging, server smoke and
arm64 packaging. With `CSC_IDENTITY_AUTO_DISCOVERY=false`, electron-builder
skipped signing. Its final verification failed with:

```text
code has no resources but signature indicates they must be present
```

For this local bundle, the installed `@electron/osx-sign` 1.3.3 signed nested
code and the outer application with the ad-hoc identity `-`, then verified it.
The options were `identityValidation: false`, `platform: "darwin"`,
`version: "43.7.9"`, `preAutoEntitlements: false`,
`preEmbedProvisioningProfile: false` and `strictVerify: true`.
Every file used `build/entitlements.mac.plist`, `hardenedRuntime: true` and
`timestamp: "none"`. No Developer ID or notarization is claimed. Do not copy
the official app's signature or apply a blanket recursive signing command.

Verify the completed bundle without changing it:

```sh
codesign --verify --deep --strict --verbose=2 release/mac-arm64/mymausbot.app
OMB_SMOKE_DIST="$PWD/release/mac-arm64/mymausbot.app/Contents/Resources/server" node scripts/smoke-packaged-server.mjs
```

The package smoke copies the server outside the checkout and uses disposable
homes and data directories. It covers health, proxy paths, MCP, CLI, backup
worker, container shutdown, desktop compile-cache reuse and the enterprise
layer. A first run timed out during startup; the unchanged smoke passed on
retry. Retain both logs rather than reporting the first attempt as successful.

## Desktop fixture and native resources

Follow `docs/verification/README.md`. The initial desktop acceptance used a
fresh HOME, `--user-data-dir`, `OMB_DATA_DIR` and webhook port, with no inherited
credentials. An outer macOS fixture sandbox denied real user-data and agent
configuration paths, outbound non-loopback connections, the CUA SDK and the
installed CuaDriver app. The nested Chromium sandbox was disabled for that
fixture because macOS rejects its second sandbox initialization.

`OMB_SMOKE_TEST=1` verified the production preload, renderer URL, embedded
server and owner mutation capability. The fixture waited for React to leave
its initial connection screen, captured only its own onboarding page and
verified its owned processes exited. The title is read from the packaged
`ui/index.html`; it is `MausBot`. A fresh profile creates `environment-id`,
`messages.db` and `runtime.db`; `config.json` need not exist before a save.

The desktop fixture's CUA-unavailable result is intentional: its sandbox makes
the SDK path unreadable. It does not establish a missing resource or prove
computer control. A separate disposable probe loaded the actual packaged SDK
with the packaged Electron executable in Node mode and the bundled native
library path. It verified the SDK exports and `cua-driver --version` without
requesting macOS permissions or starting a computer-control host. Actual
permission grants, screen actions and microphone use remain separate checks.

## Handoff evidence and rollback

The private build job holds `signing.json`, `codesign-verify.log`, package-smoke
logs, `cua-resource-probe.json`, `isolated-app-startup.json`, its log and
screenshot, and `pre-switch-backup-path.txt`. Never publish the job's actual
conversation/task path, identifiers, private configuration or backup contents.

Write `local-app-ready.json` atomically only after signature, package smoke,
isolated startup and native resource checks pass. Record the actual App path,
hashes, commands, results, evidence paths and fixture limits. The mounted
computer operator coordinates the switch and recovery; the lead does not quit
the app that owns the current conversation. Preserve the official application
as the rollback target and the verified pre-switch backups as private records.

The final feature App has its own output path and receipt. Do not overwrite
the initial bundle while it is running. `feature-delivery-ready.json` records
all five outcomes only when code, required checks, independent review and the
locally runnable feature artifact are ready; it is not a merge authorization.

## Required push checks

The repository hook runs changed-file lint and applicable locale/source guards
through `scripts/pre-push-check.mjs`, with a 30-second budget. The full typecheck
is CI's responsibility. Retain the hook and do not duplicate it immediately
before pushing. If pnpm is absent from PATH, use the existing verified toolchain
for that process; do not reinstall dependencies, change the lockfile/global
configuration or bypass checks to repair PATH.

## Process clock and PR recovery

Timing and queue-age targets produce advisory scan findings. They never alone
fail a merge/delivery gate, close a useful PR, cancel a pipeline or discard a
successful validation result. Follow the validation policy's process scan and
recovery mechanism; retain actual quality/source/security checks.

On 2026-11-09, closure audit found #106 explicitly closed under the fixed
24-hour disposition policy. Its accepted PhoneRegistry fixture improvement was
still absent from main, so the same PR was reopened with its branch/head and
prior evidence preserved. #103 had been closed after successful selected checks
exceeded the five-minute gate target; its complete final commit later reached
main through #110, so recovery records that verified supersession instead of
repeating the implementation. Process issue #119 tracks the rule correction,
remaining #106 adoption work and Lead's capacity-based follow-through.
