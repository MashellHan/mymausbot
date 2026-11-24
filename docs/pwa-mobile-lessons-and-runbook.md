# Mobile PWA, Zero-Persistence Relay, and iOS Delivery Lessons

This document captures the engineering lessons, root causes, and operational practices learned while bringing the remote mobile PWA (`https://mausbot.mxhan.com`), the zero-persistence relay (`pwa-relay`), and the macOS desktop app (`mymausbot`) into reliable daily use across Wi-Fi and mainland China 5G cellular networks.

See [the DO/Cloudflare relay runbook](pwa-do-relay-runbook.md) for the original base setup and [phone web app verification](verification/phone-web-app.md) for layout qualification.

---

## 1. Architecture & Data-Isolation Invariants

- **Mac mini stays the sole source of truth:** Bots, conversation threads, attachments, model credentials, and `sessions.json` remain strictly inside local `DATA_DIR` on the owner's Mac.
- **Zero-persistence relay (`pwa-relay` + Caddy):** The cloud VM forwards HTTP and SSE streams over a single pinned outbound WebSocket (`PINNED_HOST_ID`) and holds only transient in-memory stream state. Caddy disables access logs and strips query tokens (`?ticket=`), `Authorization`, `Cookie`, and client IP fields from error logs.
- **Single-use pairing codes are memory-bound:** Restarting the desktop app clears in-memory pairing codes. Previously minted `#pair=` links immediately fail with `pairing code is wrong or has expired` and require generating a new link in **Settings → Phone**.

---

## 2. Network & 5G Reachability Lessons

### 2.1 Cloudflare Proxied Anycast vs. Direct Origin on China 5G

- **Symptom:** On mainland 5G without a VPN, `https://relay.mxhan.com/healthz` (DNS-only → VM IPv4) loaded reliably, while `https://mausbot.mxhan.com/` (Cloudflare Pages behind proxied orange-cloud Anycast `A` + `AAAA` records) timed out or hung.
- **Cause:** Mobile 5G networks prefer IPv6 and HTTP/3 (UDP 443). Shared Cloudflare free-tier Anycast IPs frequently suffer TCP/TLS stalls or SNI resets on cellular paths, whereas a single DNS-only IPv4 origin in Singapore (`southeastasia`) maintained clean TCP/TLS connectivity.
- **Fix:** Serve the static `dist/` bundle directly from the relay VM's Caddy instance on `443` and switch the frontend DNS record from proxied `CNAME` to **DNS-only (`A` → VM IPv4, no `AAAA`)**. Keep the exact same CSP, `Referrer-Policy`, `X-Frame-Options`, and `Permissions-Policy` headers as `deploy/pwa-cf/public/_headers`.

### 2.2 Compression & Silent `caddy reload` Failures

- **Symptom:** After switching DNS to Caddy, mobile browsers sat on a completely blank black (`#070707` / `#141414` in dark mode) or white (`#fcfcfc` in light mode) screen for many seconds after pairing.
- **Causes:**
  1. `App-*.js` plus its static chunk graph is **~4.17 MB uncompressed** (4.5+ MB with CSS). While `chooseRoot()` in `src/main.tsx` awaits `loadApp()`, `<div id="root"></div>` stays empty, showing only `body`'s background color.
  2. `pwa-relay/deploy/Caddyfile` sets `admin off`, which disables Caddy's admin API (`127.0.0.1:2019`). Running `caddy reload` with `admin off` does not apply configuration edits; `encode zstd gzip` never took effect until the container was restarted.
  3. Inside `ssh ... "bash -s" << 'EOF'`, interactive commands like `docker compose exec` or `sudo` consume the remaining heredoc stdin unless `</dev/null` is passed, silently skipping subsequent restart commands.
- **Fixes:**
  - Always include `encode zstd gzip` for both the relay and static PWA site blocks (cuts `App-*.js` from ~2.85 MB down to ~860 KB).
  - After editing `Caddyfile`, validate and restart explicitly with stdin closed:
    ```bash
    sudo docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile </dev/null
    sudo docker compose restart caddy
    ```
  - Sync `pwa-dist/` atomically (`rsync` to `pwa-dist.new/` and swap directories) whenever frontend commits land on `main` if the frontend is hosted directly by Caddy rather than Cloudflare Pages.

---

## 3. Service Worker, Boot Resilience & Safari/WebKit Pitfalls

### 3.1 Redirected Responses Break Safari Navigation

- Static hosts such as Cloudflare Pages redirect `/index.html` → `/` (`308`). Safari/WebKit rejects Service Worker navigation responses whose `.redirected === true` (`Response served by service worker has redirections`).
- `public/sw.js` strips `.redirected` in `cleanResponse()` by copying status, headers, and body into a fresh `Response` before serving or caching.

### 3.2 Stale Cache-First App Shells Cause Post-Deploy White Screens

- **Symptom:** After deploying a new frontend build, existing Safari or PWA installs loaded a blank white/black screen (`#root` empty).
- **Cause:** A cache-first / stale-while-revalidate Service Worker (`omb-pwa-shell-v3`) served a cached `index.html` that referenced pruned `/assets/index-<old>.js` or `/assets/App-<old>.js` chunks.
- **Fixes (`omb-pwa-shell-v4` in `public/sw.js` and `src/lib/pwa-sw.ts`):**
  1. Serve navigation requests (`/`) **network-first** (`cache: "no-cache"`) with a **400 ms timeout** before falling back to the cached shell so online devices always receive `index.html` matching the current `/assets/*` hashes.
  2. Call `registration.update()` on startup alongside `updateViaCache: "none"` so older Service Workers upgrade promptly.
  3. Self-heal pruned assets: when a `/assets/*` request receives an HTML SPA fallback (`isHtmlResponse(response)`), do not cache it; delete cached `"/"`, trigger one-shot `client.navigate(client.url)` (with a 10 s cooldown), and return `404` to the caller.
  4. Origin requirement: Caddy's static SPA fallback must return `text/html` (`try_files {path} /index.html`) for missing `/assets/*` paths so `isHtmlResponse(response)` triggers self-healing instead of receiving an empty `404`.
  5. Note on transition: if an older Service Worker (`v3`) or HTTP-cached `/sw.js` (`max-age=14400`) is stuck on a device, clearing Safari site data once for the domain resets it cleanly to `v4`.

### 3.3 Boot Error Boundary & IndexedDB Fallbacks

- `src/main.tsx` wraps top-level boot (`bootstrapPwaConfig`, `chooseRoot`, `brandBoot`, `pageLanguage`) in a `.catch()` handler that renders `<PageBoundary>` or a bare DOM **Reload** fallback so startup failures never leave an unrecoverable blank page.
- `openPwaDb()` in `src/lib/pwa-config.ts` bounds `indexedDB.open()` with explicit `timeoutMs` (3000 ms), `blockedMs` (500 ms), and `onversionchange` `db.close()` handlers, and `setPwaAuth()` treats IndexedDB write failures as non-fatal.
- **Auth persistence across kill/reopen (`omb.pwa.auth.v1`):** Some iOS WebKit states delay or reject IndexedDB writes (`SecurityError`), which left reopened sessions hanging or falling back to `"Invalid session response"` HTML from the static SPA host. `src/lib/pwa-config.ts` mirrors `PwaAuthRecord` to `localStorage` (`omb.pwa.auth.v1`) as a synchronous backup, and `src/main.tsx` routes `!isRemotePwaMode()` `"Invalid session response"` fallbacks directly to `<PairPage />`.

---

## 4. iOS Safari vs. Home Screen Standalone PWA Behavior

- **Isolated storage containers:** iOS WebKit isolates Home Screen standalone PWA storage (`IndexedDB`, `localStorage`, cookies) from Safari. Pairing in Safari does **not** carry over to a Home Screen app added either before or after pairing.
- **In-app pairing via pasted `#pair=` URL:** Because a standalone Home Screen window opens at `/` with no `#pair=` hash, `PairPage` (`parsePwaLinkInput` in `src/pair/PairPage.tsx`) accepts full `https://.../#pair=...` URLs (or `#pair=...` fragments) pasted directly into the pairing input box, calls `activatePwaPairing()`, and persists credentials inside the standalone PWA's own storage.
- **Operational tip:** Remind users that each `#pair=` link is single-use; after pairing Safari, generate a second `#pair=` link in **Settings → Phone → Pair PWA** to pair the Home Screen PWA.

---

## 5. Desktop `Settings → Phone` & Local macOS Packaging

### 5.1 Unified `Phone` Settings Layout

- `src/components/settings/pages/PhonePage.tsx` and `src/components/settings/PhoneComputerAndAdvanced.tsx` organize remote access top-to-bottom as:
  1. **Paired:** unified device list combining local companion devices and server sessions (`server/sessions.ts` persists `pwa` and `browser` flags so tags distinguish `PWA`, `Native`, `Computer`, and `Browser`).
  2. **Phone:** `Pair a phone` (with Tailscale Funnel when available) and `Mobile web app via relay` (`PwaBridgeCard` with **Relay settings** above **Pair PWA**, enabled by default via `server/pwa-bridge-config.ts`).
  3. **Computer:** simplified `Pair another computer` panel (`TailnetComputers mode="panel"`), automatically enabled when Tailscale is active.
  4. **Advanced:** default-collapsed disclosure holding `How your phone reaches this computer` and lower-level route toggles.

### 5.2 Local macOS App Delivery

- Install verified desktop builds into `~/Applications/mymausbot.app` using `electron-builder --mac dir --arm64 --publish never` followed by ad-hoc signing (`codesign --force --deep --sign -`), avoiding flaky DMG `hdiutil detach` failures and `/Applications/` admin permission prompts.
- Keep `~/Applications/mymausbot.app` distinct from any older `/Applications/mymausbot.app` copy when launching via Spotlight or Dock, and run `pnpm check:delivery routines` to confirm scheduled routines and existing `~/.openmausbot` state stay intact.

---

## 6. Verification Checklist (Real Browser + Live Headers)

Unit tests with mocked `fetch` / `indexedDB` missed boot hangs, Safari redirect rules, compression regressions, and stale Service Worker asset pruning. Keep these checks in the release loop:

1. **Isolated real-browser PWA E2E:**
   ```bash
   pnpm build
   OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/pwa-remote-ui.e2e.test.ts
   ```
   Covers `#pair=` invite pairing, message send + SSE reply, reload persistence, `localStorage` recovery with blocked `indexedDB`, and `PairPage` link pasting against real `dist/`, `pwa-relay`, and `launchVerificationServer`.
2. **Production header & compression verification (when hosting via Caddy):**
   - `GET /` and `GET /sw.js` return `cache-control: no-cache`, `content-encoding: gzip`, and `omb-pwa-shell-v4`.
   - `GET /assets/App-*.js` returns `content-encoding: gzip` and `cache-control: public, max-age=31536000, immutable`.
   - `GET /assets/nonexistent.js` returns `text/html` from the origin so `omb-pwa-shell-v4` converts it to `404` and triggers `client.navigate` self-healing (verify `0` runtime exceptions in headless Edge/Chromium CDP).
3. **Relay & host health:**
   - `https://relay.mxhan.com/healthz` returns `{"ok":true,"hostConnected":true}`.
   - Local desktop server reports `state: "connected"` on `/api/pwa-bridge`.
