# Mini Apps screenshot evidence

Captured on 2026-11-05 with the real Computer panel and Mini App host in Electron
43.7.9 (Chromium 150), using `node --experimental-strip-types scripts/verify-mini-apps.ts --check`.
All records, app titles, bots and network probes belong to a disposable synthetic
fixture. No personal ledger or production workspace appears here.

| Capture | Scenario |
| --- | --- |
| [Desktop context](desktop-context.png) | Peer Computer tab, app navigation and bookkeeping at 960 pixels, dark English UI |
| [Light theme](desktop-light.png) | Chinese UI at 960 pixels |
| [Narrow details](mobile-details.png) | 360-pixel desktop panel scrolled to trend and original entries |
| [Inflow category](inflow-category.png) | Income-only category selected; one entry and exact inflow/net totals |
| [Stale report](stale.png) | A temporary sync failure retains prior data and identifies it as stale |
| [Installation](install.png) | Physical source preview, selected editing assistant and column mappings |

The 14 desktop assertions passed. Every capture was opened and checked after
content and painting settled. Narrow panels are desktop evidence; browser and
phone Mini Apps support is not part of this release. The source fixture retains
duplicate rows and separates missing, blank and known currencies.

Publication timestamps are fixture output. A second synthetic bookkeeping app
is installed during the full verification flow to exercise the generic registry.
See [the verification recipe](../../verification/mini-apps.md) for reproduction
and [the feature guide](../../mini-apps.md) for scope and runtime limits.
