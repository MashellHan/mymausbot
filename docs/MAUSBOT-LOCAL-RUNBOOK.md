# Local MausBot build and recovery

Keep the official `/Applications/OpenMausBot.app`, the user's data and paired
devices intact. Build products and private handoff evidence stay outside Git.
The initial local arm64 bundle is `release/mac-arm64/OpenMausBot.app`, version
0.1.139, with Electron 43.7.9 and CUA Driver 0.28.2.

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
codesign --verify --deep --strict --verbose=2 release/mac-arm64/OpenMausBot.app
OMB_SMOKE_DIST="$PWD/release/mac-arm64/OpenMausBot.app/Contents/Resources/server" node scripts/smoke-packaged-server.mjs
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

The repository hook runs `pnpm lint`, `pnpm typecheck` and `pnpm i18n:check`.
If the shell cannot find pnpm, use the already cached pnpm 10.33.0 executable
by adding its directory to that push process's PATH. Do not reinstall packages,
change the lockfile/global configuration or skip the hook to repair PATH.
