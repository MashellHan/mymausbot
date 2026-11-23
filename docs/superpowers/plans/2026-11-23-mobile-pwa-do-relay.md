# Mobile PWA + DO Relay Staged Implementation Plan

> **For agentic workers:** Implement exactly one Stage per focused PR from freshly fetched `origin/main` in an isolated worktree. Prefix every commit and PR title with `[Stage N]` so history and rollbacks stay traceable. Write all PR titles, descriptions, code, and comments in English only (`CONTRIBUTING-FORK.md`).

**Spec:** `docs/superpowers/specs/2026-11-23-mobile-pwa-do-relay-design.md`

**Goal:** Deliver a <300ms-open, <3s-connect mobile PWA (`https://mausbot.mxhan.com`) backed by a Singapore/Hong Kong DigitalOcean relay (`https://relay.mxhan.com`) and the owner's always-on Mac mini desktop app, with an always-enabled chat composer and a durable IndexedDB outbox (`queued` / `sending` / `failed` / `resending` / `rejected`).

---

## Stage 1 — `[Stage 1]` Dormant DO HTTP/SSE-over-WSS Bridge Relay + Required CI Gate

**Branch:** `feat/stage1-pwa-bridge-relay`
**PR Title:** `[Stage 1] Add HTTP/SSE-over-WSS bridge relay package and required CI gate`

### Scope & Files
- Create isolated package `pwa-relay/` (keeping `relay/` untouched):
  - `pwa-relay/package.json`, `pwa-relay/pnpm-lock.yaml`, `pwa-relay/tsconfig.json`
  - `pwa-relay/src/config.ts`: env config (`BRIDGE_PORT`, `BRIDGE_HOST`, `PINNED_HOST_ID`, `HOST_TOKEN_HASHES`, `PWA_ORIGIN`, `UPSTREAM_HEADER_TIMEOUT_MS=5000`, `UPLOAD_HEADER_TIMEOUT_MS=30000`, `MAX_BODY_BYTES=12582912`, `MAX_FRAME_BYTES=524288`, `MAX_CONCURRENT_STREAMS=128`).
  - `pwa-relay/src/wire.ts`: versioned frame types (`omb-pwa-bridge.v1`: `hello`, `req.open`, `req.body`, `req.cancel`, `res.head`, `res.body`, `ping`, `pong`).
  - `pwa-relay/src/bridge.ts`:
    - Single-host pinned WebSocket registry (`PINNED_HOST_ID`): public requests route exclusively to `PINNED_HOST_ID` and fail closed (`503 mac_offline`) when absent; a newer authenticated socket closes any stale socket (`4409 replaced`) and immediately fails/closes all in-flight streams of the replaced socket; 15s heartbeat; zero disk persistence; redacted logging (never logs `Authorization`, `?ticket=`, credentials, or bodies).
    - HTTP/SSE multiplexer (`503 mac_offline` in `<50ms` when disconnected, bounded per-stream buffers, unbuffered SSE streaming with immediate `req.cancel` on client close, `413` over `MAX_BODY_BYTES` on decoded bytes, `MAX_FRAME_BYTES` per WS chunk).
    - Complete response headers on **every** response (`OPTIONS`, `2xx`, `4xx`/`5xx`, `503`, binary, `text/event-stream`): `Access-Control-Allow-Origin: <PWA_ORIGIN>`, `Vary: Origin`, `Access-Control-Allow-Headers: Authorization, Content-Type, x-omb-background`, `Access-Control-Expose-Headers: Retry-After`, `Cache-Control: no-store`, and upstream `Retry-After` forwarding.
  - `pwa-relay/src/main.ts`: HTTP server entrypoint with `/healthz` (`{ ok, hostConnected }`) and SIGTERM drain.
  - `pwa-relay/deploy/Caddyfile`, `pwa-relay/deploy/compose.yaml`, `pwa-relay/deploy/Dockerfile`, `pwa-relay/deploy/relay.env.example` (Caddy access logging disabled/redacted so `?ticket=` and headers never hit disk).
  - `pwa-relay/test/bridge.test.ts`: contract tests for auth rejection, pinned-host routing, `4409` takeover closing old in-flight streams, REST proxy round-trip, SSE chunk streaming & client cancel, `503 mac_offline`, header timeout, decoded `12 MiB` body cap & `512 KiB` frame cap, zero disk/log leak, `Cache-Control: no-store`, `Retry-After` exposure, and CORS headers on preflight/errors/SSE.
- Required test & CI gate wiring:
  - `scripts/ci-scope.mjs`: add `"pwa-relay"` to `SELECTABLE_JOBS`, `EVERY_CHECK`, map `/^pwa-relay\// -> "pwa-relay"`, AND add `"pwa-relay"` to `fastChecks` (line 349) so ordinary fast PRs touching `pwa-relay/` also require the `pwa-relay` job.
  - `scripts/qa/contracts.mjs`: add `"pwa-relay"` to `MERGE_JOBS` and `NAMES` so the protected `gate` enforces `pwa-relay` and rejects skipped/failed runs (plus contract test in `scripts/qa/`).
  - `scripts/check.mjs`: run `pnpm --dir pwa-relay test` when `pwa-relay/**` changes or `--test pwa-relay/test/...` is passed.
  - `.github/workflows/ci.yml`: add `pwa-relay` job (frozen lockfile, `pnpm audit --prod --audit-level high`, `pnpm check`, `pnpm test`) and wire it into the protected `gate` job.

### Acceptance & Checks
- `cd pwa-relay && pnpm check && pnpm test` passes.
- `pnpm check:edit` and `pnpm check:ready` run and pass `pwa-relay` tests automatically.

---

## Stage 2 — `[Stage 2]` Mac Bridge Ingress, Header Scrubbing & PWA-Bound Pairing

**Branch:** `feat/stage2-mac-pwa-bridge-ingress`
**PR Title:** `[Stage 2] Add fail-closed Mac PWA bridge client and PWA-scoped pairing routes`

### Scope & Files
- `server/pwa-bridge.ts`:
  - Outbound WebSocket client connecting to `wss://relay.mxhan.com/v1/bridge` (`omb-pwa-bridge.v1`), jittered reconnect (`500ms -> 1s -> 2s -> 5s`), 15s heartbeat watchdog.
  - Virtual `IncomingMessage` / `ServerResponse` adapter dispatching to `handleRequest`:
    - `socket.remoteAddress === undefined && socket.remoteFamily === undefined` so `ipcPeer(req)` is `true` and `isProxied(req)` is **always** `true` (never loopback trust; missing credentials yield `403` per `server/request-auth.ts:730`, invalid/revoked Bearer tokens yield `401`).
    - Scrub `cookie`, `x-openmausbot-*`, `x-omb-*`, and all `PROXY_HEADERS`; overwrite `host: "pwa-bridge.invalid"` and `x-forwarded-for` from relay-attested client address.
    - Enforce explicit method + path allowlist (blocking `/api/internal/*`, `/api/local-computer`, `/api/desktop-viewer/*`, `/api/setup-import/*`, etc.) and check managed remote-access policy (`managedRemoteAccessRefusal`).
- `server/sessions.ts`, `server/pwa-bridge-config.ts`, & admin routes in `server/index.ts`:
  - Persist `{ enabled, relayUrl, hostId, bridgeSecret, defaultBotId }` in `DATA_DIR` (never return `bridgeSecret` in any GET response; expose `hasBridgeSecret: boolean`).
  - Tag PWA invites explicitly (`pwa: true`, `scopes: ["client"]`) in `sessions.openPairing()` / `exchange()`, and bind bridge-originated `POST /api/pair` exclusively to `pwa: true` invites with `isPairingCredential` (256-bit secret), refusing 6-digit codes and non-PWA / `admin` invites.
- `server/pwa-bridge.test.ts`:
  - Verify real `handleRequest` dispatch over a mock bridge: unauthenticated proxied reads/writes rejected (`403` per `request-auth.ts:730`), invalid Bearer rejected (`401`), spoofed `cookie` / `x-openmausbot-*` / `x-forwarded-for` / `Host: 127.0.0.1` rejected (`403`), regular `admin` invite refused on bridge `POST /api/pair`, `client`-scoped PWA invite succeeds -> `Bearer` -> admin-only routes rejected (`403`), blocked internal paths return `403`, managed remote-access refusal respected, `POST /api/bots/:id/messages`, and SSE `/api/events?ticket=...` + `req.cancel` cleanup.

### Acceptance & Checks
- `pnpm check:edit --test server/pwa-bridge.test.ts` passes.
- `pnpm typecheck --project server` passes.
- `pnpm check:ready` passes.

---

## Stage 3 — `[Stage 3]` Electron Keep-Awake Lifecycle & Desktop Pairing UI

**Branch:** `feat/stage3-electron-pwa-bridge-ui`
**PR Title:** `[Stage 3] Add independent PWA bridge keep-awake and pairing settings UI`

### Scope & Files
- `electron/main.mjs`:
  - Give the PWA bridge its own `powerSaveBlocker("prevent-app-suspension")` hold tied to server utility process readiness + bridge-enabled config, decoupled from `stopDesktopCompanion` and companion crash paths (`electron/main.mjs:696,711`) so native companion stops never drop PWA keep-awake.
- `src/components/settings/pages/PhonePage.tsx` (plus minimal locale keys in `src/locales/`):
  - Add a compact "Fast Mobile PWA Relay" card showing live Mac↔DO bridge status, `relayUrl` / `defaultBotId` configuration, toggle switch, and a button/QR modal for the `https://mausbot.mxhan.com/#pair=...` link.
- Tests:
  - Isolated Electron/keep-awake unit test verifying bridge keep-awake survives `stopDesktopCompanion` and clears cleanly on bridge disable or app shutdown.
  - Settings UI DOM test verifying secret masking and `#pair=` link generation.

### Acceptance & Checks
- `pnpm check:edit` and `pnpm typecheck --project ui` pass.
- `pnpm check:ready` passes.

---

## Stage 4 — `[Stage 4]` PWA Online Remote Transport & Ticket-Safe SSE

**Branch:** `feat/stage4-pwa-remote-transport`
**PR Title:** `[Stage 4] Add remote PWA transport, credential pairing, and ticket-refreshing SSE`

### Scope & Files
- `src/lib/pwa-config.ts`:
  - IndexedDB `omb-pwa-v1` `auth` store (`{ ownerKey, relayUrl, token, deviceId, environmentId, sessionId, serverName }`).
  - `#pair=` URL fragment parser: validates `relayUrl` (`https://` origin against configured/allowed relay origin), strips `location.hash` via `history.replaceState`, persists stable `pairRequestId` per attempt (sent as `pairRequestId` on `POST ${relayUrl}/api/pair`), and **immediately validates** `GET ${relayUrl}/api/auth/session` + `GET ${relayUrl}/.well-known/openmausbot/environment` with the new Bearer token to obtain and verify `{ environmentId, sessionId: id, scopes }` before activating the pairing in IndexedDB.
- `src/state/api.ts`, `src/lib/session.ts`, `src/lib/session-ended.ts`, `src/lib/composer-attachments.ts`, `src/state/store.tsx`:
  - Shared `remoteUrl(path)` + `remoteFetchInit()` helper injecting `Authorization: Bearer <token>` across `api()`, `readSessionState()`, `noteRefusedRequest()`, attachment upload/delete (`uploadWithRetry`), `/api/bots/.../read`, and authenticated `blob:` URL loading for `/api/attachments/*` & `/api/files/*` (`attachmentImageUrl`, `attachmentAudioUrl`, bot avatars).
  - Fix `readSessionState()` (`src/lib/session.ts:44-75`) to require `application/json` and explicit `kind` (`"session"` or `"loopback"`), preventing accidental HTML 200 fallbacks from resolving as `loopback`.
- `src/lib/live-events.ts`:
  - Async ticket acquisition (`POST /api/auth/stream-ticket`) before **every** initial `EventSource` connect and **every** reconnect (since tickets are single-use), preserving `since` cursor, calling `closeSource()` before creating a new `EventSource`, and serializing concurrent connect attempts.
  - On `onerror`, probe `readSessionState()`: if `401`/unauthenticated, stop reconnecting and surface re-pair without wiping IndexedDB outbox; if `503`/network loss, stay in backoff reconnect.
- Tests & Isolated Acceptance Fixture:
  - `src/lib/pwa-config.test.ts` (including `/api/auth/session` validation before pairing activation), `src/lib/session.test.ts` (HTML 200 fallback regression), `src/lib/live-events.test.ts` (fresh ticket per reconnect, `closeSource()` order, `401` probe).
  - Isolated E2E test against local `pwa-relay` + Mac server fixture (does not wait for Stage 8 public deploy).

### Acceptance & Checks
- Against an isolated local `pwa-relay` + Mac server fixture, paired PWA completes `#pair=` -> `/api/auth/session` -> `REST`, `POST`, media blobs, and reconnecting `SSE`.
- `pnpm check:edit` and `pnpm typecheck --project ui` pass.
- `pnpm check:ready` passes.

---

## Stage 5 — `[Stage 5]` Fast-Boot Shell Cache, Session-Partitioned Snapshot & Offline Drafting

**Branch:** `feat/stage5-pwa-fast-boot-cache`
**PR Title:** `[Stage 5] Add session-partitioned snapshot cache, service worker, and offline drafting`

### Scope & Files
- `src/lib/pwa-cache.ts`:
  - Partition `prefs` (`pinnedBotId`, `openPinnedOnLaunch`, `lastBotId`, `lastThreadId`) and `snapshot` (`savedAt`, `bots` trimmed to recent 50 messages, `groups`, `sections`, `config`) by `ownerKey = ${relayUrl}::${environmentId}::${sessionId}`. A new pairing never reads a prior session's cached transcript.
- `src/main.tsx`, `src/state/store.tsx`, `src/lib/app-loading.ts`:
  - When IndexedDB `auth` + `snapshot` exist for the active `ownerKey`, mount `<App />` immediately without blocking on `readSessionState()`, dispatch `hydrateFromCache` (`cachedHydrated: true`), and run live `readSessionState()` + `hydrate()` asynchronously.
  - Selection precedence on open: `?bot=` -> `pinnedBotId` (when `openPinnedOnLaunch` enabled) -> `lastBotId` / `lastThreadId`, plus 1-tap header pin toggle for the accounting bot.
- `src/components/Composer.tsx` & `src/components/LiveConnectionStrip.tsx`:
  - Keep `Composer` enabled for drafting when cached thread is open even while `!connected` or `awaitingThreadSnapshot`, while retaining execution/approval guards (`blocking`) and viewer locks. In Stage 5 (before Stage 6 adds the outbox), submitting while offline preserves the draft in place without clearing it and performs no `POST` call.
  - Non-blocking `LiveConnectionStrip` (`Connecting…`, `Offline`, `Mac offline`).
- `public/sw.js` & `src/lib/pwa-sw.ts`:
  - Register on HTTPS web origins only (never inside Electron `window.ogb` or dev HMR).
  - Cache static shell assets only; explicitly bypass `/api/*` and `/api/events`. Verify SW upgrade leaves `omb-pwa-v1` IndexedDB intact.
- Tests:
  - `src/lib/pwa-cache.test.ts` (`ownerKey` session isolation), `src/state/store.pwa-boot.test.ts` (cached mount + async live reconcile + pinned/last selection), `src/components/Composer.pwa.dom.test.ts` (offline drafting verified via both `Enter` key submit and clicking the Send button: asserts draft stays intact and zero `POST /api/bots/:id/messages` occur before Stage 6 introduces the outbox).

### Acceptance & Checks
- Cold open with cached snapshot paints chat and enables `Composer` in `<300ms` even when the relay is unreachable.
- `pnpm check:edit` and `pnpm typecheck --project ui` pass.
- `pnpm check:ready` passes.

---

## Stage 6 — `[Stage 6]` Durable Text Outbox (`queued`/`sending`/`failed`/`resending`/`rejected`) & Retry UI

**Branch:** `feat/stage6-pwa-text-outbox`
**PR Title:** `[Stage 6] Add persistent IndexedDB text outbox with failed/resending states and FIFO retry`

### Scope & Files
- `src/state/pwa-outbox.ts`:
  - IndexedDB `outbox` store partitioned by `ownerKey = ${relayUrl}::${environmentId}::${sessionId}`, keyed by `sendId`, indexed by `[ownerKey, threadId, seq]` with transactional monotonic `seq` assignment.
  - States: `"queued" | "sending" | "failed" | "resending" | "rejected"` (removed on `"sent"`).
  - Cross-tab per-thread FIFO serialization via `navigator.locks.request("omb-outbox:${ownerKey}:${threadId}")` paired with an IndexedDB fenced lease (`outbox_leases`: `{ leaseOwner, leaseToken, leaseExpiresAt }`, plus `BroadcastChannel` lease coordination when `navigator.locks` is absent). Every queue mutation verifies `(leaseOwner && leaseToken)` inside the IndexedDB `readwrite` transaction so a suspended tab waking after takeover cannot mutate state or advance the drain.
  - Crash recovery for persisted `sending`/`resending` head: stale head stays blocked in `seq` order, checks `sendArrived`, and resumes as `resending` with the exact same `sendId` and payload rather than letting later items overtake.
  - Re-pairing ownership rule: a new pairing (`sessionId`) starts with an empty active outbox and never silently drains a prior session's paused queue; preserved prior-session drafts stay in IndexedDB under the prior `ownerKey` and require explicit user confirmation ("Import & Resend / Discard") to migrate into the newly paired session.
  - Auto-retry coordinator on SSE `open`/`hello`, `window` `online`, and `document.visibilitychange` (`visible`), bounded at 3 auto attempts (`1s -> 3s -> 8s` jittered, honoring `429 Retry-After`).
- `src/state/store.tsx`, `src/state/optimistic-send.ts`, `src/hooks/use-transcript-viewport.ts`:
  - Write immutable text payload + `sendId` to IndexedDB before dispatch; enforce `5_000ms` timeout on text POST.
  - Reconcile BOTH `202 { message }` and `202 { queued: true, queueId }` (as well as SSE `sendArrived`) as accepted (`sent`) so queued server entries are never double-sent.
  - Retryable errors (`503`, `502`, `504`, `500`, `429`, `409` with `settling`/`thread_busy`/`guarded_busy`, timeout, network loss) transition to `failed` (never `optimisticMessageRemoved`); `401` pauses drain while preserving outbox; terminal `400`/`404`/`413`/`415`/`403` and `409` `sendId` conflict/`thread_limit`/`bot_limit`/`bot_paused`/`guarded_branch` transition to `rejected`.
  - Re-overlay unresolved outbox entries after live `hydrate()` (once `botId`/`threadId` revalidated).
  - Update `use-transcript-viewport.ts:264` so restoring persisted `optimistic-*` outbox rows on boot/rehydrate does not hijack scroll position (auto-scroll only on a fresh live send nonce).
- `src/components/ChatView.tsx`, `src/components/RichMessageRow.tsx`, `src/components/LiveConnectionStrip.tsx`, `src/locales/`:
  - Inline status badges & actions (`Queued`, `Sending…`, `Failed · Tap to retry` + `Discard`, `Resending…`, `Not sent · <error>` + `Discard`) and `Retry all (N)` in `LiveConnectionStrip`.
- Tests:
  - `src/state/pwa-outbox.test.ts` (tx `seq`, Web Locks / fenced lease FIFO, stale-owner fencing after takeover, `sending`-head crash recovery, `202 queued` reconciliation, `503`/`500` -> `failed`, `409` retryable vs terminal codes, `429 Retry-After`, `401` + prior-session explicit recovery isolation, reload persistence).
  - `src/components/OutboxBubble.dom.test.ts` & `src/hooks/use-transcript-viewport.test.ts` (scroll preservation on rehydrate).

### Acceptance & Checks
- Sending while offline or on `503 mac_offline` / `500` survives page reload or tab close, displays `Failed`, preserves strict cross-tab per-thread order, and delivers once via the same `sendId` upon reconnect.
- `pnpm check:edit`, `pnpm typecheck --project ui`, and `pnpm check:ready` pass.

---

## Stage 7 — `[Stage 7]` Durable Receipt Attachments in Outbox

**Branch:** `feat/stage7-pwa-attachment-outbox`
**PR Title:** `[Stage 7] Support compressed receipt image queueing and idempotent upload in outbox`

### Scope & Files
- `src/lib/pwa-image-compress.ts`:
  - Client-side canvas compression (max edge `1280px`, WebP/JPEG `0.82`, fallback if already smaller, capped under `10 MiB`).
- `src/state/pwa-outbox.ts` & `src/components/Composer.tsx`:
  - In remote PWA mode, allow attaching receipt images offline by storing `{ uploadId, name, mime, compressedBlob }` directly in the IndexedDB outbox item alongside `rawText`.
  - During outbox drain:
    1. Upload each attachment lacking `uploadedPath` via `POST /api/attachments?uploadId=${uploadId}` (`30_000ms` timeout) and immediately persist `uploadedPath` back to IndexedDB.
    2. Once all attachments have `uploadedPath`, freeze and persist `composedText = composeMessage(rawText, attachments)` onto the IndexedDB record BEFORE calling `POST /api/bots/:id/messages`.
    3. Keep `compressedBlob` until message acceptance (`202` / `sendArrived`) so partial failures never alter `uploadId`, `path`, or `composedText` (preventing `409 sendId` conflicts).
  - Render local `blob:` thumbnail preview on queued/failed receipt bubbles even while offline.
- Tests:
  - `src/state/pwa-outbox-attachments.test.ts` (upload fails -> retry reuses same `uploadId` -> upload succeeds, message POST fails -> retry reuses persisted `composedText` & `sendId` without re-uploading).

### Acceptance & Checks
- Attaching a receipt photo while offline queues locally, survives reload, uploads idempotently once online, and delivers without `409` conflict.
- `pnpm check:edit`, `pnpm typecheck --project ui`, and `pnpm check:ready` pass.

---

## Stage 8 — `[Stage 8]` Cloudflare Pages + DO + Mac Mini Deploy & Verification Runbook

**Branch:** `docs/stage8-pwa-deploy-runbook`
**PR Title:** `[Stage 8] Add Cloudflare Pages headers, optional same-origin Worker proxy, and deploy runbook`

### Scope & Files
- `deploy/pwa-cf/public/_headers` + build hook/copy step (`vite.config.ts` or build script):
  - Copy `_headers` explicitly into the Cloudflare Pages build output (`dist/_headers`) so `sw.js` gets `Cache-Control: no-cache`, hashed assets get `immutable`, and strict CSP allows `https://relay.mxhan.com` + `wss://relay.mxhan.com` + `blob:`.
- `deploy/pwa-cf/worker-proxy.ts` + `deploy/pwa-cf/wrangler.toml.example` (isolated optional same-origin `mausbot.mxhan.com/api/*` -> `https://relay.mxhan.com/api/*` proxy, zero caching/logging, independently deployable/revertible).
- `docs/pwa-do-relay-runbook.md`:
  - Step-by-step setup for Singapore/Hong Kong DO Droplet (`relay.mxhan.com`), Cloudflare DNS + Pages (`mausbot.mxhan.com`), Mac mini `pmset` (`sudo pmset -c sleep 0 disksleep 0 powernap 1 autorestart 1`), iOS standalone "Add to Home Screen" pairing test, and real-device acceptance checklist (cold launch `<300ms`, live connect `<3s`, spent ticket resume after iOS backgrounding, `503 mac_offline` + auto-retry, receipt photo upload, SW update preserving outbox, IndexedDB quota error handling).

### Acceptance & Checks
- `pnpm build` succeeds cleanly with PWA artifacts (`manifest.webmanifest`, `sw.js`, and `_headers` present in build output).
- `pnpm check:ready` passes.
