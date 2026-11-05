# Local Mini Apps verification

Use synthetic fixtures only. Do not exercise promotion, publication, backup,
restoration or deletion against the running personal workspace.

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
