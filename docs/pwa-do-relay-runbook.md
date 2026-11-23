# Mobile PWA + DigitalOcean Relay Deployment & Verification Runbook

This runbook covers deploying and verifying the zero-persistence DigitalOcean HTTP/SSE-over-WSS relay (`https://relay.mxhan.com`), the Cloudflare Pages PWA (`https://mausbot.mxhan.com`), and the owner's always-on Mac mini running `mymausbot`.

## Security & Data-Isolation Invariants

- **Mac mini is the sole source of truth:** All bots, threads, attachments, model credentials, and `DATA_DIR` files remain strictly on the local Mac mini.
- **Zero persistence on DO & Cloudflare:** `pwa-relay` holds only in-memory active WebSocket streams and buffers; Caddy error logs scrub `?ticket=`, `Authorization`, `Cookie`, and client IP fields and disable access logging.
- **Fail-closed bridge boundary:** Public requests route exclusively to `PINNED_HOST_ID`, return `503 mac_offline` immediately when the Mac mini is offline, and require `pwa: true` single-use pairing credentials (`client` scope) on `POST /api/pair`.

---

## 1. DigitalOcean Droplet Setup (`relay.mxhan.com`)

Choose a low-latency region close to the user and Mac mini (for example, Singapore `sgp1` or Hong Kong).

### 1.1 Firewall & Host Prerequisites

1. Open inbound TCP `22` (SSH), `80` (ACME HTTP-01), and `443` (HTTPS / WSS). Keep port `8080` bound to `127.0.0.1` only.
2. Install Docker Engine and the Docker Compose plugin (`docker compose version`).
3. Clone or copy the repository onto the Droplet (for example `/opt/openmausbot`).

### 1.2 Generate the Mac Bridge Secret & `relay.env`

1. Generate a 256-bit bridge secret on a trusted machine (do **not** commit or log it):

   ```bash
   BRIDGE_SECRET=$(openssl rand -hex 32)
   echo -n "$BRIDGE_SECRET" | shasum -a 256
   ```

2. Create `/opt/openmausbot/pwa-relay/deploy/relay.env` from `pwa-relay/deploy/relay.env.example`:

   ```dotenv
   PWA_RELAY_DOMAIN=relay.mxhan.com
   PWA_ORIGIN=https://mausbot.mxhan.com
   PINNED_HOST_ID=mac-mini
   HOST_TOKEN_HASHES=<64-char-sha256-hex-from-step-1>
   ```

3. Build the `pwa-relay` container image and start `pwa-relay` + `caddy`:

   ```bash
   cd /opt/openmausbot/pwa-relay/deploy
   docker build -f Dockerfile -t omb-pwa-relay:latest ..
   PWA_RELAY_IMAGE=omb-pwa-relay:latest docker compose up -d
   ```

4. Validate Caddy configuration and relay health:

   ```bash
   docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
   curl -sS https://relay.mxhan.com/healthz
   # Expected before Mac connects: {"ok":true,"hostConnected":false}
   ```

---

## 2. Cloudflare DNS, Cloudflare Pages (`mausbot.mxhan.com`) & Optional Worker Proxy

### 2.1 Cloudflare DNS

1. Add an `A` record for `relay.mxhan.com` pointing to the DigitalOcean Droplet IPv4 address.
   - Recommended: **DNS only** (gray cloud) so TLS and WebSockets terminate directly at Caddy with zero proxy buffering or extra hops.
2. Attach custom domain `mausbot.mxhan.com` to your Cloudflare Pages project.

### 2.2 Cloudflare Pages Build

Configure the Cloudflare Pages project:

- **Build command:** `pnpm install --frozen-lockfile && pnpm build`
- **Build output directory:** `dist`

`pnpm build` runs `vite build` and automatically copies `deploy/pwa-cf/public/_headers` to `dist/_headers` alongside `dist/manifest.webmanifest` and `dist/sw.js`. That guarantees:

- `/`, `/index.html`, and `/sw.js` are served with `Cache-Control: no-cache` so service worker updates propagate immediately.
- `/assets/*` hashed bundles are served with `Cache-Control: public, max-age=31536000, immutable`.
- Strict `Content-Security-Policy` allows `https://relay.mxhan.com`, `wss://relay.mxhan.com`, and `blob:` receipt previews while blocking framing and object embeds.

Verify locally after `pnpm build`:

```bash
ls -l dist/_headers dist/manifest.webmanifest dist/sw.js
```

### 2.3 Optional Same-Origin API Proxy Worker (Independently Deployable / Revertible)

By default, the PWA talks directly to `https://relay.mxhan.com`. If a network environment benefits from same-origin `/api/*` routing on `https://mausbot.mxhan.com/api/*`:

1. Copy `deploy/pwa-cf/wrangler.toml.example` to `deploy/pwa-cf/wrangler.toml` (git-ignored or local).
2. Deploy only the Worker route:

   ```bash
   npx wrangler deploy -c deploy/pwa-cf/wrangler.toml
   ```

3. `deploy/pwa-cf/worker-proxy.ts` enforces `cf: { cacheTtl: 0, cacheEverything: false }`, strips `Cookie` / `CF-*` / `X-Forwarded-*` headers, logs nothing, and forces `Cache-Control: no-store`.
4. To revert immediately without touching Pages or the DO relay, delete the `mausbot.mxhan.com/api/*` Worker route in Cloudflare Dashboard or run `npx wrangler delete -c deploy/pwa-cf/wrangler.toml`.

---

## 3. Mac mini (`mymausbot`) Setup

### 3.1 Keep-Awake Power Profile

Run once on the Mac mini so lid/display idle never suspends the outbound bridge WebSocket:

```bash
sudo pmset -c sleep 0 disksleep 0 powernap 1 autorestart 1
```

Inside the Electron desktop app, enabling the PWA bridge acquires an independent `powerSaveBlocker("prevent-app-suspension")` hold tied to server readiness and bridge enablement.

### 3.2 Configure the Mac PWA Bridge & Mint a Pairing Invite

1. Open **mymausbot** on the Mac mini and go to **Settings -> Phone -> Fast Mobile PWA Relay** (backed by `GET/PUT /api/pwa-bridge`, `POST /api/pwa-bridge/rotate-secret`, and `POST /api/pwa-bridge/invite`).
2. Set:
   - **Relay URL:** `https://relay.mxhan.com`
   - **Host ID:** `mac-mini` (must match `PINNED_HOST_ID` in `relay.env`)
   - **PWA Origin:** `https://mausbot.mxhan.com`
   - **Default Bot (optional):** e.g., `accounting`
3. Paste or rotate the bridge secret so its SHA-256 matches `HOST_TOKEN_HASHES` on the DO Droplet, then toggle **Fast Mobile PWA Relay** on.
4. Confirm `https://relay.mxhan.com/healthz` now reports `{"ok":true,"hostConnected":true}`.
5. Click **Generate Pairing Link / QR** to mint a single-use `https://mausbot.mxhan.com/#pair=...` invite (includes `?bot=<id>` if a default bot is selected).

---

## 4. iOS Standalone Pairing & Real-Device Acceptance Checklist

### 4.1 iOS "Add to Home Screen" Pairing Flow

1. Open the minted `https://mausbot.mxhan.com/#pair=...` URL in iOS Safari (or scan the QR code).
2. Wait for pairing to complete (`POST /api/pair` exchanges the 256-bit single-use credential for a `client`-scoped Bearer token stored in IndexedDB `omb-pwa-v1` and clears `#pair=` from `location.hash`).
3. Tap **Share -> Add to Home Screen** and launch **mymausbot** from the iOS Home Screen icon.
4. Confirm the standalone window boots directly into the cached workspace without re-prompting for pairing.

### 4.2 Real-Device Verification Matrix

| Check | Procedure | Pass Criteria |
| --- | --- | --- |
| **Cold launch `< 300ms`** | Force-close the standalone iOS PWA, turn on Airplane Mode (or launch normally), tap Home Screen icon. | Cached shell + `omb-pwa-v1` snapshot render bots, recent transcript, and enabled composer in `< 300ms` without blocking on `/api/*`. |
| **Live connect `< 3s`** | Launch online from cold state. | Initial `GET /api/snapshot` + `POST /api/events/ticket` + SSE `/api/events` settle in `< 3s` and reconcile cleanly. |
| **Spent ticket resume after iOS backgrounding** | Send the standalone PWA to the iOS app switcher for `> 60s`, then bring it back to foreground. | `pageshow` / `visibilitychange` mints a fresh single-use ticket (`POST /api/events/ticket`) and resumes SSE without 403/re-pair prompts. |
| **`503 mac_offline` + auto-retry** | Stop `mymausbot` on Mac mini (or toggle bridge off), send a message from iPhone, then restart Mac mini bridge. | Relay answers `503 mac_offline` in `< 50ms`; message shows queued/failed state in transcript, survives reload, and drains FIFO with the same `sendId` when Mac returns. |
| **Receipt photo compression & offline upload** | Go offline, attach a full-resolution camera photo (`> 1280px`), tap Send, inspect bubble, then reconnect. | Image resizes to `<= 1280px` WebP/JPEG (`0.82`), renders local `blob:` thumbnail immediately, uploads once via `POST /api/attachments?uploadId=...`, freezes `composedText`, and delivers without `409`. |
| **SW update preserves outbox** | Queue an offline message, deploy a new `sw.js` cache prefix, reload online. | New SW activates (`Cache-Control: no-cache` on `/sw.js`) while `omb-pwa-v1` outbox items remain intact and drain normally. |
| **IndexedDB quota handling** | Fill browser storage / simulate `QuotaExceededError` on snapshot persistence. | UI surfaces a non-fatal warning and keeps live messaging operational without crashing boot or outbox. |
| **Launch target selection** | Open `/?bot=<id>`, test pinned bot toggle, and cold-reopen with no `?bot=`. | Precedence resolves `?bot=` -> `pinnedBotId` -> `lastBotId` / `lastThreadId`. |
