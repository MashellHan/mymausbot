# Local Mini Apps verification

Use synthetic fixtures only. Do not exercise promotion, publication, backup,
restoration or deletion against the running personal workspace.

## Library discovery and navigation

Start with an empty isolated registry. The library must show Bookkeeping, Daily X
AI digest, GitHub activity, Agent Team and Usage without claiming they are
installed. Opening the library must not publish records, grant access or create
an Automation. Follow the existing explicit owner installers and check their
real prerequisites, including unknown unconnected Bot Data and reports with no
published edition. Keep a custom app with a colliding slug and verify it is not
overwritten or silently classified as a shipped app.

Check that owner-recorded `shippedTemplateKind` survives a bot's HTML update,
version changes, archive and restore without granting any new reads. Legacy
records remain unmarked, and bots cannot assign or change this metadata. Carry
the existing native identity, grant and revision tests when their code is
unchanged.

Verify the single row of installed apps, distinct shipped icons, the custom-app
fallback and the accessible **All apps** surface. Exercise keyboard selection,
Escape/close and focus return. Measure the actual panel bounds at 960, 400 and
360 pixels before capturing light/dark and English/Chinese evidence; a query
parameter or screenshot filename is not width evidence. Drive the existing
separator or window geometry rather than changing production resize behavior
for a fixture. Include a realistic complete App window with chat and Computer
panels together to check overlap in both the row and expanded-library states.

Use the affected contract tests and the existing renderer fixture once on stable
source. Package acceptance uses an isolated profile and the actual production
preload. Normal-App delivery checks the installed source and real inventory
read-only; templates visible in the catalog are not installed-instance evidence.

## Built-in Agent Team and Usage

Use the existing synthetic dashboard snapshots with an isolated Mini Apps
registry. Install both entries through the library, open them and compare their
values with the old tabs on the same captured data. Keep Bookkeeping and both
report apps installed to check that their ordinary HTML path still works.

The focused contracts are:

```sh
pnpm exec vitest run server/mini-apps/registry.test.ts server/routes/mini-apps.test.ts server/routes/local-dashboard.test.ts server/local-dashboard.e2e.test.ts server/mini-apps/mini-apps.e2e.test.ts src/components/AgentActivityDetails.test.ts src/components/mini-apps/DashboardInstall.test.ts src/components/mini-apps/MiniAppDashboard.test.ts src/components/mini-apps/MiniAppsPanel.test.ts
```

Exercise owner disclosure and grants, an app reading an ungranted resource,
paired/service denial, and a pending read during archive, revision change or
revocation. An old registry without the dashboard column must migrate with no
grant. Archive and workspace restore clear grants; rollback cannot revive them.
An explicit owner reinstall retains the archived app's ID and history.
After restore or explicit revocation, an active built-in entry must offer a
visible repair action and require an owner regrant before showing live data.
Verify the same app ID after repair and refusal of an unrelated custom app with
the same slug. Persistent built-in identity alone must never authorize a read.

In the renderer, check folded activity and an initially unselected office,
two-second team refresh, five-minute Usage refresh, and cancellation on hide or
unmount. Offline data must remain unavailable or stale, and authorization loss
must clear old observations. Check keyboard navigation, light/dark themes and
English/Chinese at 960, 400 and 360 pixels. Built-in views must require the
native guard and current installed revision; HTML markers or a matching title
must never activate this path. Bot discovery may reveal metadata and editing
limits, never dashboard snapshots or self-grant authority.

Reuse existing evidence for unchanged shared views and provider validation.
Run the new lifecycle and adapter contracts once on stable combined source;
composition alone does not require another suite, build or visual pass. These
fixtures do not establish packaged or live App acceptance.

## Contracts and lifecycle

```sh
pnpm exec vitest run server/application-write.test.ts server/data/admission.test.ts server/data/catalog.test.ts server/data/named-query.test.ts server/data/mini-app-data.test.ts server/mini-apps/registry.test.ts server/mini-apps/mini-apps.e2e.test.ts server/app-docs.test.ts
```

The lifecycle fixture launches the real server and native DuckDB in an isolated
home. It loads a synthetic ledger with duplicates, multiple currencies and invalid
values; promotes it; installs bookkeeping and inventory through the same registry;
exercises bot authoring tools, owner/source reads, publisher/tool revocation and
paired-device rejection; updates Data; publishes and rolls back templates; restarts;
deletes the producer; and exports, stages and restores an encrypted workspace backup.
It also checks archived publisher writes, delegated binding expansion, revoked
publisher grants after restore, and an explicit owner regrant.

Data tests exercise the promotion journal, cancellation, checkpoint failure,
backup admission, revision consistency, schema changes, bounded reads, lossless
decimal values and scoped cursors. Existing Data engine, tools and route tests
remain part of acceptance.

## Reports and existing Automations

```sh
pnpm exec vitest run shared/report-mini-app.test.ts server/mini-apps/report-store.test.ts server/mini-apps/report-e2e.test.ts src/components/mini-apps/report-template.test.ts src/components/mini-apps/ReportInstall.test.ts src/components/mini-apps/MiniAppsPanel.test.ts
```

The report fixture starts an isolated server with the scripted fake engine and
creates one synthetic producer with no Data tables. It creates two local
Automations, prepares their empty retained report source through the owner route,
and installs the shipped X AI and GitHub templates with the server-resolved
producer grant. Both apps initially have no edition.

It then starts actual Automation runs through the routine API. Those turns call
`mini_app_report`, publish to the shared retained dataset and keep their normal
chat output. A repeated run keeps the original edition receipt and Data revision;
an explicit conflicting publication fails, and a late older edition adds history
without replacing Current. The fixture checks independent report queries, tool
revocation, restart persistence and expiry of the old turn capability. These are
synthetic runs, not evidence that a person's existing routine has been changed or
executed.

The store tests cover atomic complete editions, the nominal scheduled China day,
URL/date validation and empty bootstrap. Template and installer tests cover
server-resolved producer identity, stable installation, current/history paging,
coverage labels and refresh handling. The package owner separately verifies all
three apps and Data refresh in the production renderer against an isolated
synthetic workspace. Do not substitute component tests for packaged acceptance.

## Real desktop renderer

```sh
node --experimental-strip-types scripts/verify-mini-apps.ts --check
```

The parent owns a disposable server, local HTTP sink and temporary Electron
profile. The child mounts the real Computer panel and Mini App host. All source
data and malicious navigation probes are synthetic. It checks guarded navigation
against an unguarded control, browser capability gating, normal named queries,
light/dark rendering at 960/400/360-pixel panel widths, filters, duplicate rows,
income-only categories, trend controls, Data refresh without remount, stale
freshness labels and recovery, app switching,
template rollback, source preview and completing installation with explicit column
mappings and an editing assistant.

The sink records HTTP requests and TCP connections. A hostname canary and isolated
NetLog check DNS hints; resolver rules prevent that synthetic hostname from leaving
the fixture machine. A separate control verifies the resolver trace can detect an
attempt. The production Blink setting disables DNS speculation; the fixture also
checks that applying it preserves an existing Blink setting. These probes cover
the listed HTTP, TCP, DNS and navigation paths, not every possible browser channel.
The fixture never receives production credentials or real ledger rows.

Screenshots and `mini-apps-result.json` are written under `.impeccable/review/`.
Capture waits for stable content and painted host/frame updates. Inspect the
captured files before treating them as visual evidence. A checked synthetic
sample is kept in [the PR screenshot set](../pr-screenshots/mini-apps/README.md).
The script
stops its exact children and removes its temporary data; the server log remains
at the path printed at startup.

Use `pnpm check:plan` and `pnpm check:ready` for the current merge-base diff,
supplying the Mini Apps contract paths with `--test` until they have an area
mapping. This change touches authorization, persistence and native behavior;
it requires full relevant CI. Additional checks include full lint, typechecking,
locale validation, catalog wire tests, source/route ratchets, Electron bridge
tests, a renderer build and the packaged-server smoke. Reuse unchanged results
and let normal push hooks own their checks. Passing these fixtures
does not mean the user's installed app or financial dataset has been changed.
