# Mobile PWA (`mausbot.mxhan.com`) + DigitalOcean Relay (`relay.mxhan.com`) Design

Date: 2026-11-23
Base: `origin/main` (`3648c997b`)
Owner: `menha` (Mac mini desktop host, Singapore/Hong Kong DigitalOcean droplet, Cloudflare `mxhan.com`)

## 1. Goal & Constraints

Deliver a mobile PWA experience at `https://mausbot.mxhan.com` tailored for quick expense/accounting capture while keeping all bots, credentials, and data strictly on the owner's always-plugged-in Mac mini desktop app (`mymausbot`):

1. **< 300ms UI & Always-Enabled Chat Box**: Opening the installed PWA renders the cached conversation immediately and enables the chat composer without blocking on network hydration or server connection.
2. **< 3s Live Connect**: Replace the >10s native companion discovery (`LAN` / `Tailscale` / `Noise_NKpsk0` + `Yamux`) with a browser-native HTTPS/SSE connection to a DigitalOcean relay (`https://relay.mxhan.com`) wired to a pre-established outbound WebSocket tunnel from the Mac mini desktop app.
3. **Zero Lost Entries (`Outbox` + `failed` / `resending` / Retry)**: Sending while disconnected, offline, or when the Mac is unreachable persists the message locally in IndexedDB first, marks failures visibly instead of deleting the optimistic bubble, preserves per-thread FIFO order across tabs, and supports automatic and manual retry reusing the server's `sendId` and `uploadId` idempotency.
4. **Accounting-First Ergonomics**: Remember the user's last opened bot/thread and support pinning a default accounting bot so opening the PWA lands directly in the accounting chat; preserve compressed receipt image attachments in the local Outbox.
5. **No Bot Execution or Data Persistence on DO**: The DigitalOcean relay never runs bots, stores messages or attachments on disk, or retains Mac session tokens.

## 2. Target Network, Trust & Retention Topology

```text
[Phone PWA: https://mausbot.mxhan.com] (Cloudflare Pages + Service Worker + IndexedDB)
   |
   |  HTTPS/2 + TLS 1.3 (fetch + EventSource)
   |  Auth: Authorization: Bearer omb_sess_<token>  |  SSE: fresh single-use ?ticket=<streamTicket>
   v
[DigitalOcean SG/HK Droplet: https://relay.mxhan.com] (Caddy 443 -> Node PWA Bridge Relay)
   ^
   |  Persistent outbound WSS tunnel (wss://relay.mxhan.com/v1/bridge, omb-pwa-bridge.v1)
   |  15s ping/pong heartbeat + 1s jittered auto-reconnect + Mac host token auth
   |
[Home Mac mini: mymausbot Desktop App] (Always plugged in + pmset + powerSaveBlocker)
   -> Sanitizes & allowlists requests, enforces remote-only auth, dispatches to server/index.ts `handleRequest`
```

### Trust & Retention Contract

1. **DO Trusted-Operator Relay Contract (Explicit TLS Termination Boundary)**:
   - Unlike the existing E2E binary splicing relay (`relay/src/splice.ts`) which splices Noise-encrypted bytes, browser `fetch` and `EventSource` terminate TLS at Caddy (`relay.mxhan.com`). Therefore, Caddy and the DO Node bridge process can observe HTTP paths/queries, headers (`Authorization`), pairing POST bodies, SSE `?ticket=` queries, and message/attachment bodies in memory while forwarding.
   - **Zero-Persistence & Zero-Leakage Guarantees on DO** (and optional Stage 8 Cloudflare Worker):
     - **No disk persistence**: No SQLite, Redis, temp files, or payload buffers written to disk; all frames stream in memory only with bounded per-stream buffers.
     - **Log redaction**: Caddy disables access logs (`log { discard }`) or logs only timestamp/status without query strings (`?ticket=`), `Authorization`, `Cookie`, or bodies. Node logs only connection/stream lifecycle counters and error codes — never `Authorization`, pairing credentials, tickets, URLs with query strings, or request/response bodies.
     - **No edge caching**: Neither DO nor any optional Cloudflare Worker uses `caches.default`, KV/R2/D1, or `Cache-Control` caching for `/api/*` responses.
2. **Mac Ingress Fail-Closed, Header Scrubbing & Allowlist (`server/pwa-bridge.ts`)**:
   - Requests arriving over the WSS bridge are injected into `handleRequest` using a virtual socket where `socket.remoteAddress === undefined && socket.remoteFamily === undefined`, so `ipcPeer(req)` is `true` and `isProxied(req)` (`server/request-auth.ts:191`) is **always** `true` — loopback owner trust is never granted. Proxied requests missing valid credentials follow `server/request-auth.ts:730` (`403` missing credential; `401` invalid/revoked Bearer).
   - Match `server/phone-relay.ts:309` scrubbing: strip `cookie`, all `x-openmausbot-*` / `x-omb-*` owner/internal headers, and all `PROXY_HEADERS` (`server/request-auth.ts:184`) supplied by the client. Set `req.headers.host = "pwa-bridge.invalid"` and `req.headers["x-forwarded-for"]` solely from the relay-attested client IP.
   - Enforce a **strict method + path allowlist** on the Mac bridge ingress before calling `handleRequest`, rejecting internal/local-only endpoints (`/api/internal/*`, `/api/local-computer`, `/api/desktop-viewer/*`, `/api/setup-import/*`, `/api/auth/sessions` management unless explicitly permitted, etc.) with `403`.
   - Enforce the desktop managed remote-access policy (`managedRemoteAccessRefusal`) so enterprise/managed locks cannot be bypassed.
   - Never expose `bridgeSecret` in any settings read response (return `hasBridgeSecret: boolean` only).
3. **Explicit `client`-Scoped, PWA-Bound Credential-Only Pairing**:
   - `sessions.openPairing()` (`server/sessions.ts:371`) defaults to `[...SCOPES]` (`admin` + `client`) and `exchange()` (`server/sessions.ts:451`) grants whatever scopes are stored on the matched invite. Therefore, PWA invites MUST be minted with `scopes: ["client"]` AND marked `pwa: true`, and bridge-originated `POST /api/pair` MUST only redeem `pwa: true` invites with `isPairingCredential` (256-bit secret), explicitly refusing regular 6-digit codes and non-PWA / `admin` invites.
   - Pairing link uses a URL fragment:
     `https://mausbot.mxhan.com/#pair=<base64url(json({ relayUrl, credential, defaultBotId? }))>`
     so Cloudflare Pages static hosting and browser referrer headers never receive the credential. (Note: the subsequent `POST ${relayUrl}/api/pair` still sends the credential over TLS 1.3 to the trusted DO relay.)
   - The PWA validates `relayUrl` strictly (`https://` origin matching an explicit allowlist or configured `relay.mxhan.com` pattern, rejecting `http:` / `javascript:` / unexpected hosts), immediately clears `location.hash` via `history.replaceState`, persists a stable `pairRequestId` per pairing attempt (`pairRequestId` on the `POST /api/pair` wire body), and—because `/api/pair` returns `{ token, device, serverName }` without `environmentId` or `scopes`—immediately validates `GET ${relayUrl}/api/auth/session` and `GET ${relayUrl}/.well-known/openmausbot/environment` with the new Bearer token to capture `{ environmentId, sessionId: id, scopes }` before activating the pairing in IndexedDB.
4. **CORS & Cache Headers on Every Response (Not Just Preflight)**:
   - In cross-origin mode (`https://mausbot.mxhan.com` -> `https://relay.mxhan.com`), DO MUST attach:
     - `Access-Control-Allow-Origin: https://mausbot.mxhan.com` (exact configured `PWA_ORIGIN`, never `*`)
     - `Vary: Origin`
     - `Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS`
     - `Access-Control-Allow-Headers: Authorization, Content-Type, x-omb-background`
     - `Access-Control-Expose-Headers: Retry-After`
     - `Access-Control-Max-Age: 86400`
     - `Cache-Control: no-store` (on all API responses, pairing, media, and relay-generated errors)
   - Attach CORS + `Cache-Control: no-store` headers on **all** responses: `OPTIONS` preflight, `2xx` JSON, `4xx`/`5xx` upstream errors, `503 mac_offline`, binary `/api/attachments/*` & `/api/files/*`, and `text/event-stream` SSE streams, forwarding `Retry-After` from upstream responses.
   - Optional Stage 8: a Cloudflare Worker route on `mausbot.mxhan.com/api/*` proxying to `relay.mxhan.com/api/*` eliminates CORS preflights as an independent rollback unit.

## 3. Protocol: DO HTTP/SSE-over-WSS Bridge (`v1`)

Keep the existing E2E binary splicing relay (`relay/`) untouched. Implement the PWA HTTP/SSE bridge as an isolated package `pwa-relay/` wired explicitly into `scripts/ci-scope.mjs` (including `fastChecks` on fast PRs), `scripts/qa/contracts.mjs` (`MERGE_JOBS` + `NAMES` for protected `gate` enforcement), `scripts/check.mjs`, and `.github/workflows/ci.yml`:

- **Single-Host Pinned Listener & Mac -> DO Control/Stream WebSocket** (`GET /v1/bridge`, subprotocol `omb-pwa-bridge.v1`):
  - The DO deployment is pinned to one configured `PINNED_HOST_ID` and authenticates `hostId` + `bridgeToken` against `sha256` digests in `HOST_TOKEN_HASHES` using `timingSafeEqual`. Public HTTP requests route exclusively to `PINNED_HOST_ID` and fail closed (`503 mac_offline`) whenever that host is disconnected.
  - Single active socket per `hostId`: a newer authenticated socket closes any stale socket (`4409 replaced`) and immediately fails/closes all of the old socket's in-flight HTTP/SSE streams so no stale streams hang.
  - Multiplexed JSON/chunk frames keyed by `streamId` with strict decoded-byte and frame-size caps:
    - `req.open`: `{ type: "req.open", streamId, method, path, headers, remoteAddr }`
    - `req.body`: `{ type: "req.body", streamId, chunkB64, eof }` (hard cap `MAX_BODY_BYTES = 12 MiB` counted on **decoded** bytes to cover `IMAGE_MAX_BYTES = 10 MiB` + framing; separately bound individual WebSocket frame payloads to `MAX_FRAME_BYTES = 512 KiB` via chunked streaming; fail `413` if exceeded)
    - `req.cancel`: `{ type: "req.cancel", streamId }` (emitted immediately when browser aborts `fetch` or closes `EventSource`)
    - `res.head`: `{ type: "res.head", streamId, status, headers }`
    - `res.body`: `{ type: "res.body", streamId, chunkB64, eof }` (backpressure-aware bounded write queue; drop/cancel stalled streams rather than growing unbounded memory)
    - `ping` / `pong`: 15s keepalive; missing 2 pongs tears down the dead tunnel.
- **Timeouts & Fast Fail**:
  - Host disconnected -> immediate HTTP `503` `{ "error": "Mac host is offline", "code": "mac_offline" }` in `< 50ms`.
  - Standard API header deadline: `5_000ms` (configurable; `30_000ms` for upload paths `/api/attachments`, `/api/files`). Once `res.head` for `text/event-stream` is committed, the stream stays open without a short read timeout and flushes chunks immediately (`X-Accel-Buffering: no`, `Cache-Control: no-store`).

## 4. Mac Mini Desktop App Integration

1. **Outbound Bridge Client (`server/pwa-bridge.ts`)**:
   - Reads config (`enabled`, `relayUrl`, `hostId`, `bridgeSecret`, `pwaOrigin`, `defaultBotId`) from `DATA_DIR`.
   - Connects outbound over WSS with jittered exponential backoff (`500ms -> 1s -> 2s -> 5s`), heartbeat watchdog, and clean stream cancellation into `handleRequest`.
   - Exposes admin-only desktop routes to read masked config/status (`enabled`, `relayUrl`, `hostId`, `hasBridgeSecret`, `status`, `lastConnectedAt`, `lastError`), update config, toggle on/off, and mint a `client`-scoped `#pair=` link.
2. **Independent Keep-Awake Lifecycle (`electron/main.mjs`)**:
   - Give the PWA bridge its own `powerSaveBlocker("prevent-app-suspension")` hold tied to the server utility process + bridge-enabled state — **decoupled** from `stopDesktopCompanion` and companion crash handlers (`electron/main.mjs:696,711`) so stopping/crashing native companion routes never drops PWA keep-awake.
   - Add a small Settings → Phone & devices card (`PhonePage.tsx`) to configure `relay.mxhan.com`, see live Mac↔DO status, and display/copy the `#pair=` QR link.
   - Document Mac mini `pmset` settings (`sudo pmset -c sleep 0 disksleep 0 powernap 1 autorestart 1`) in the Stage 8 runbook.

## 5. Complete Browser Transport, App Shell & State Separation

1. **Unified Remote Transport (Every Network Path Covered)**:
   - Route ALL authenticated HTTP calls through a shared remote transport resolver (`remoteFetch` / `apiBaseUrl` + `Authorization: Bearer <token>`):
     - `api()` (`src/state/api.ts`)
     - `readSessionState()` (`src/lib/session.ts:44`) and `noteRefusedRequest()` (`src/lib/session-ended.ts`)
     - Raw upload/delete fetches in `src/lib/composer-attachments.ts` (`/api/attachments?uploadId=...`, `/api/files?uploadId=...`, `DELETE /api/attachments/...`) and `sendRead` in `src/state/store.tsx` (`/api/bots/.../read`)
     - Relative media URLs (`attachmentImageUrl`, `attachmentAudioUrl`, bot `avatarUrl` `/api/attachments/...`): in remote PWA mode, fetch via authenticated `remoteFetch` into cached object (`blob:`) URLs so `<img src>` / `<audio src>` work cross-origin with Bearer auth without ever embedding tokens in query strings.
2. **Single-Use Stream Ticket Renewal (`src/lib/live-events.ts`)**:
   - Because `sessions.redeemStreamTicket` (`server/sessions.ts:801`) deletes each ticket immediately on first use, `live-events.ts` MUST request a fresh ticket (`POST /api/auth/stream-ticket` with `Bearer`) on **every** initial connect and **every** reconnect.
   - Preserve the SSE replay `cursor` (`since`), always `closeSource()` the prior `EventSource` before creating the next, and guard against concurrent `connect()` calls while awaiting a ticket.
   - On `EventSource` error, probe `readSessionState()`: if `401`/`unauthenticated`, stop reconnecting and surface re-pair (keeping the local outbox intact); if `503`/unreachable, stay in backoff reconnect.
3. **Fix `readSessionState` Fallback Bug (`src/lib/session.ts:44-75`)**:
   - Currently any `200` non-JSON body (e.g., Cloudflare Pages `index.html` fallback) parses as `{}` and falls through to `{ kind: "loopback" }`!
   - Require `content-type` starting with `application/json` and an explicit `record.kind === "session"` or `record.kind === "loopback"` (and in remote PWA mode, only accept `record.kind === "session"`, returning `{ kind: "unreachable" }` on HTML/unexpected 200 responses).
4. **Non-Blocking Boot & Session-Partitioned IndexedDB Cache (`src/main.tsx`, `src/lib/pwa-cache.ts`, `src/state/store.tsx`)**:
   - In `src/main.tsx`, when a valid PWA pairing record (`auth` + `environmentId` + `sessionId`) exists in IndexedDB, mount `<App />` immediately without awaiting network `readSessionState()`; verify the session asynchronously in parallel.
   - Because each `/api/pair` generates a fresh `sessionId` (`server/sessions.ts:478`), partition all IndexedDB stores (`prefs`, `snapshot`, `outbox`) by `ownerKey = ${relayUrl}::${environmentId}::${sessionId}`. A new pairing never reads a prior session's cached transcript or silently drains a prior session's queued messages; any unsent/failed outbox drafts left in a paused/ended prior session remain safely stored under that prior `ownerKey` and are surfaced only via an explicit user-confirmed recovery prompt ("Previous session unsent entries (N) — Import & Resend / Discard") so nothing is ever lost or silently drained under the wrong session.
   - `hydrateFromCache` populates initial display (`cachedHydrated: true`, `hydrated: true` visually) while keeping `connected: false` and `liveSyncing: true` for `LiveConnectionStrip`.
   - Live `hydrate` (`store.tsx:3033`) replaces authoritative server transcripts while re-overlaying any unresolved IndexedDB `outbox` items (`queued` / `sending` / `failed` / `resending` / `rejected`) whose `sendId` is not yet in the server snapshot, and revalidating target `botId`/`threadId` before draining.
   - **Prevent Scroll Hijack on Rehydrate**: `use-transcript-viewport.ts:264` forces bottom-follow when `newestId?.startsWith("optimistic-")`. Only trigger that auto-scroll for messages newly sent in the active session (`justSent` nonce), not when restoring persisted outbox bubbles on startup/rehydrate. Preserve existing `id.startsWith("optimistic-")` guards on edit, fork, and branch-switch.
5. **Service Worker (`public/sw.js`)**:
   - Cache static app-shell assets only (`index.html`, hashed JS/CSS chunks, icons, `manifest.webmanifest`) on HTTPS web origins (skipping Electron `window.ogb` and dev server).
   - **Never** intercept or cache `/api/*` or SSE `/api/events`. Ensure SW updates never clear IndexedDB (`omb-pwa-v1`).
6. **Accounting Entry & Composer Availability (`Composer.tsx`)**:
   - Selection precedence on launch: explicit `?bot=` param -> `pinnedBotId` (when `openPinnedOnLaunch` is enabled, e.g. Accounting bot) -> `lastBotId` / `lastThreadId`, with a 1-tap header pin shortcut.
   - In offline/disconnected remote PWA mode, allow drafting and queueing in `Composer` on cached-known threads without waiting for `connected` or `awaitingThreadSnapshot`, while preserving real execution/approval guards (`blocking`) and viewer/permission locks.

## 6. Durable Outbox State Machine (`src/state/pwa-outbox.ts` + `store.tsx`)

```text
  [User presses Send] -> Persist in IndexedDB `outbox` (tx seq, sendId, rawText, attachments[])
         |
         v
    (queued) ---[Web Lock head-of-line per threadId]---> (sending)
         ^                                                  |
         |                      +---------------------------+---------------------------+
         |                      v                           v                           v
         |               [202 message OR             [503/502/504/429/          [400/403/404/413/415 OR
         |                202 queued:true OR          timeout/network]          409 sendId-conflict]
         |                SSE sendArrived]                  |                           |
         |                      |                           v                           v
         |                      v                        (failed)                   (rejected)
         |                   (sent)                 (401 pauses drain;          (retryable: false;
         |             (remove outbox entry;         outbox preserved           server error shown;
         |              reconcile queueId/msg)       for re-pairing)            Discard/Copy/Edit)
         |                                                  |
         +-----[auto (SSE open/online/visible) or Retry]--- (resending)
```

### Key Rules

1. **Acceptance (`202` + `queued`) & `sendId` Idempotency**:
   - `POST /api/bots/:id/messages` returns `202` with either `{ ok: true, threadId, message }` or `{ ok: true, threadId, queued: true, queueId, reason }` (`server/routes/bot-messages.ts:354`, `store.tsx:2399`). Both mean **accepted by the server**: remove the item from `outbox` and reconcile into `messageAdded` or `pendingQueued` so a retry never double-submits.
   - Persist an immutable request payload and `sendId` on creation and reuse them identically on every retry.
   - **External System Boundary**: `sendId` (`server/send-idempotency.ts`) guarantees at-most-once **message acceptance** into the bot transcript. If the accounting bot posts to an external ledger/API/MCP tool during its turn, exact-once external posting requires its own idempotency key inside that bot/tool.
2. **Per-Thread Transactional Sequence, Cross-Tab FIFO Fencing & Crash Recovery**:
   - Assign a monotonic `seq` inside the IndexedDB `readwrite` transaction when enqueueing.
   - Drain each `threadId` under a single cross-tab owner using `navigator.locks.request("omb-outbox:" + ownerKey + ":" + threadId, ...)` paired with a fenced lease record `{ leaseOwner, leaseToken, leaseExpiresAt }` in IndexedDB (`outbox_leases`) (using IndexedDB + `BroadcastChannel` lease coordination when `navigator.locks` is unavailable). Every state mutation (`sending` -> `failed`/`sent`, `resending`, advancing `seq`) MUST verify inside the IndexedDB `readwrite` transaction that `(leaseOwner === myOwner && leaseToken === myToken)`, so a suspended tab waking after takeover cannot corrupt queue state or advance the drain.
   - **Crash/Tab-Kill Recovery for `sending` Head**: If a tab dies mid-request leaving the head item in `sending` or `resending`, it stays at the head (`seq` order preserved). When the next drain owner acquires the lock and increments `leaseToken` (or a stale lease expires), it checks `sendArrived` via live snapshot/SSE and otherwise transitions that head item to `resending` using the **exact same `sendId`** and payload—never letting newer `queued` items overtake it.
   - **Strict Head-of-Line Blocking**: While a `threadId` head item is `sending`, `resending`, `failed`, or `rejected`, newer `queued` items in that thread stay `queued` until the head succeeds or is explicitly discarded by the user.
3. **Exact Status Error Classification**:
   - Retryable (`failed`, `retryable: true`): `503` (`mac_offline`), `502`, `504`, `500` (ambiguous server error—retry with the exact same `sendId` so `acceptedSendMatch` deduplicates if the first attempt actually committed), `429` (honoring `Retry-After` header or backoff), `409` with retryable transient codes (`"settling"`, `"thread_busy"`, `"guarded_busy"` per `server/index.ts:7560-7580`), `AbortError`/timeout (`5_000ms` text / `30_000ms` upload), and network errors. **Never** dispatch `optimisticMessageRemoved` on these failures.
   - Auth paused (`failed`, `retryable: true`, `authPaused: true`): `401` (or session-revoking `403`). Pause all outbox drains and prompt re-pair while preserving every queued/failed item in IndexedDB.
   - Non-retryable (`rejected`, `retryable: false`): `400`, `404`, `413`, `415`, `403` permission/bot refusal, and `409` terminal conflicts/caps (`sendId already belongs to another message`, `"thread_limit"`, `bot_limit`, `bot_paused`, `guarded_branch`). Keep visible with the server error message and `Edit & Resend` / `Copy` / `Discard` actions.
4. **Durable Attachment Upload Pipeline (`?uploadId=`)**:
   - `server/routes/threads.ts:343` takes raw image bytes at `POST /api/attachments?uploadId=<uuid>` (idempotent per `uploadId`, max `10 MiB`), and `composeMessage(text, attachments)` embeds `<attached-image path="..." name="..." />` in `message.text` (`src/lib/composer-attachments.ts:458`).
   - Compress images client-side (max edge `1280px`, WebP/JPEG `0.82`) and persist `{ uploadId, name, mime, compressedBlob, uploadedPath?: string }` inside the IndexedDB outbox item BEFORE upload.
   - During drain: upload any image lacking `uploadedPath` via `POST /api/attachments?uploadId=${uploadId}` (`30s` timeout) and persist `uploadedPath` back to IndexedDB immediately. Once all attachments have `uploadedPath`, freeze and persist `composedText = composeMessage(rawText, attachments)` onto the outbox record BEFORE posting `POST /api/bots/:id/messages`. Retain `compressedBlob` until message acceptance (`202` / `sendArrived`) so partial failures never change `uploadId`, `path`, or `composedText` (preventing `409 sendId` conflicts).
5. **Auto-Retry & Manual Controls**:
   - Auto-retry triggers on SSE `open`/`hello`, `window` `online`, and `document.visibilitychange` (`visible`), capped at 3 automatic retries per failure episode (`1s -> 3s -> 8s` jittered backoff, honoring `429 Retry-After`).
   - Inline bubble controls: `Queued`, `Sending…`, `Failed · Tap to retry` (+ `Discard`), `Resending…`, `Not sent · <reason>` (+ `Discard`), plus `Retry all (N)` on `LiveConnectionStrip`.

## 7. Staged PR Plan Summary (8 Small, Rollback-Safe Stages)

1. **`[Stage 1]`** Dormant DO HTTP/SSE-over-WSS Bridge Relay (`pwa-relay/` + bounded streams/cancellations + full-response CORS + redacted logging + CI job).
2. **`[Stage 2]`** Mac Bridge Ingress & Pairing Contract (`server/pwa-bridge.ts` fail-closed `ipcPeer` + header scrub + allowlist + `client`-scoped `/api/pair` + config/status routes + tests).
3. **`[Stage 3]`** Electron Bridge Keep-Awake & Settings Pairing UI (`electron/main.mjs` independent bridge keep-awake + `PhonePage` card + `#pair=` link/QR).
4. **`[Stage 4]`** PWA Online Remote Transport & Pairing (`#pair=` exchange with `relayUrl` validation + `pairRequestId`, Bearer across `api()` / `readSessionState` / media blobs, `readSessionState` JSON fix, async single-use `stream-ticket` in `live-events.ts`, session probe on SSE error).
5. **`[Stage 5]`** App-Shell Cache, Partitioned Snapshot Boot & Accounting Entry (`main.tsx` non-blocking boot, partitioned IndexedDB cache, `sw.js` static-only cache, `pinnedBotId` / `lastBotId` routing, offline drafting in `Composer`, `LiveConnectionStrip`).
6. **`[Stage 6]`** Durable Text Outbox & Retry UI (IndexedDB `outbox` with tx `seq`, Web Locks per-thread FIFO, `queued`/`sending`/`failed`/`resending`/`rejected`, `202 queued` + `409`/`429`/`401` handling, scroll-hijack fix, inline Retry/Discard + `Retry all`).
7. **`[Stage 7]`** Durable Receipt Attachments in Outbox (client image compression, persisted `uploadId` + `compressedBlob` + `uploadedPath` + frozen `composedText` before message POST, partial-failure retention).
8. **`[Stage 8]`** Deployment Templates & Verification Runbook (`deploy/pwa-cf/_headers`, optional `worker-proxy.ts` as its own rollback unit, DO Caddy/Compose, Mac `pmset` + iOS standalone verification).
