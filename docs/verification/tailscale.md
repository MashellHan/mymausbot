# Tailscale

## Standalone CLI discovery

The macOS app executable chooses GUI or CLI mode from its environment.
Finder-launched OMB processes must set `TAILSCALE_BE_CLI=1`, including when
using the self-hosted server's `tailscale serve` support. No installed wrapper,
interactive shell, or change to the user's environment is required.

### Offline verification

```sh
pnpm exec vitest run companion/test/tailscale-cli.test.ts companion/test/listener.test.ts companion/test/endpoints.test.ts companion/test/control.test.ts server/tailscale.test.ts server/tailnet-listener.test.ts server/tailnet-listener.e2e.test.ts electron/tailnet.test.mjs
node --test electron/tailnet-share.node-test.mjs electron/phone-link-routes.node-test.mjs electron/server-probe.node-test.mjs electron/server-address.node-test.mjs
```

The fixture starts a real loopback companion control server with disposable
device storage and synthetic network interfaces. Every CLI launch is routed to
an offline child process; it never runs the installed Tailscale or changes a
real tailnet. Without the CLI environment flag the child exits successfully
with GUI startup text, reproducing the reported failure.

Assertions cover:

- `POST /tailscale/refresh` staying closed: the sidecar never runs Tailscale.
- Advertising `http://fixture.tail1234.ts.net:8787` on the configured companion
  port while preserving the separate hosted HTTPS endpoint.
- Not advertising bare CGNAT IPs as phone routes or opening a pairing window.
- Candidate fallback, clearing stale names, and distinct diagnostics for GUI
  startup, malformed JSON, and a status with no DNS name. Raw output is not logged.
- Explicit CLI mode for self-hosted status, HTTPS Serve, and Serve off.

This proves the discovery/control contract, not a particular customer's
Tailscale installation, iOS transport behavior, or reachability over cellular.
For an end-to-end acceptance check, use a disposable Mac/phone pairing, verify
that Remote access reports the MagicDNS name, then switch the phone from Wi-Fi
to cellular with Tailscale connected on both devices. Keep public tunnel/DNS
failures separate: a hosted URL returning a deployment 404 is not repaired by
successful MagicDNS discovery.

## Native phone pairing over an existing Funnel

The local desktop's **Connect your phone** entry prefers a verified Tailscale
Funnel. **Pair phone app** creates an `openmausbot://pair` QR containing the
server's one-time credential and the verified HTTPS origin. Scan it from the
native phone app's add-computer screen. The phone receives chat and approvals
access; the separate browser/admin pairing action retains its scope selector.

Discovery only reads `tailscale status --json` and `tailscale serve status
--json`. It requires Funnel permission on the exact authority, a single root
proxy to the current loopback harness port, and matching local/public
environment descriptors. It neither starts Funnel nor changes its routes.

```sh
node --test electron/tailscale-funnel.node-test.mjs
pnpm exec vitest run src/components/ServerPairingCard.funnel.dom.test.ts src/components/SettingsModal.serverPairing.test.ts shared/pairing-link.test.ts
```

For integration acceptance, launch an isolated fixture as described in the
verification README. If a disposable Funnel is authorized, record the existing
Serve configuration, route an unused HTTPS port to that fixture, and confirm
the native QR redeems through the public relay. Verify authenticated chat,
reconnection and refusal after session revocation. Remove only that temporary
route and compare the remaining configuration with the recorded original.
Never create a test pairing on the live workspace.

These phones appear under the server's **Paired devices**, where **Sign out**
revokes their sessions. They do not use the companion device registry or its
remote-access switch. The computer must remain on with Tailscale/Funnel running;
the phone needs ordinary internet access. Secure credential entry from the
phone is not offered by this pairing path. Protocol and desktop acceptance do
not replace scanning with an actual iPhone on cellular.

## Snapshot compression through a reverse proxy

Tailscale Funnel can forward directly to the server's loopback HTTP listener.
Forwarded requests use the same JSON compression as the private tunnel
listener: replies of at least 1 KB are gzipped when the client accepts gzip.
Direct loopback requests keep their original response. Forwarding headers do
not grant access; a remote phone still needs its paired session.

```sh
pnpm exec vitest run server/forwarded-json.e2e.test.ts server/harness/tunnel-gzip.test.ts
```

The regression launches an isolated fake-engine workspace, pairs a disposable
client, and requests its initial `/api/bots?messages=50` snapshot through the
real HTTP listener with proxy headers. It checks exact decompressed content,
encoding negotiation, direct loopback behavior, an immediate uncompressed SSE
hello before requesting the snapshot, client scope, and session revocation.
All mutations belong to the fixture; no real phone or workspace is used.

This verifies the server transport contract, not a three-second phone startup.
The native client decides whether connection readiness waits for history
synchronization. Moving that synchronization into the background needs the
corresponding native source and cursor/replay tests so a snapshot cannot
overwrite newer streamed messages.

## Two machines on a tailnet

CI has no Tailscale: `server/tailnet-listener.e2e.test.ts` proves the listener on one of the runner's own addresses.
This script is what proves it on a real tailnet. You need a host (a Mac mini or a Linux box), a client laptop, and for
the last parts a phone and a device that is not on the tailnet. Both computers are signed in to the same tailnet with
MagicDNS on. `$NAME` is the host's MagicDNS name and `$IP` its `100.x` address, from `tailscale status` on the host.
Use a disposable workspace on the host.

### The desktop app as host, without HTTPS certificates

1. Leave HTTPS Certificates off at https://login.tailscale.com/admin/dns.
2. On the host, open Settings → Phone & devices → More ways in. Turn on **Tailscale**, then **Your other computers**.
   Expect `Ready at http://$NAME:8799`.
3. On the host, run `lsof -nP -iTCP:8799 -sTCP:LISTEN`. Expect `127.0.0.1:8799` and the tailnet addresses, and never
   `*:8799`.
4. On the host, create a code on the card under the switch. Expect its link to start with `http://$NAME:8799/pair#code=`.
5. On the client, choose ＋ → Connect to a server and paste the link. Expect the found line to say Tailscale. Connect,
   then send a message and wait for a reply.
6. From the client, check the refusals:
   - `curl -i -H 'Host: evil.example.com' http://$IP:8799/api/health` answers 421.
   - `curl -i -H 'Host: 127.0.0.1:8799' http://$IP:8799/api/bots` answers 421.
   - `curl -i http://$NAME:8799/api/bots` answers 403.
7. From the device that is not on the tailnet, `curl -m 5` the host's LAN address on port 8799. It must fail.

### With HTTPS certificates

1. Turn on HTTPS Certificates, then press **Check again** on the host. Expect `Ready at https://$NAME`.
2. On the host, `tailscale serve status` lists 443 → `http://127.0.0.1:8799`, and `lsof` shows only `127.0.0.1:8799`.
3. Connect the client to `https://$NAME` with a new code. The first request can take several seconds while the
   certificate is issued.
4. Quit the app on the host. `tailscale serve status` is empty again.
5. Serve something of your own on 443 (`tailscale serve --bg 3000`), and start the app. Expect the share to fall back to
   `http://$NAME:8799` and your own serve to be untouched. Remove it with `tailscale serve reset`.

### What the client says when it can't connect

Type the address on the Connect sheet each time.

| Do this | Expect |
|---|---|
| Disconnect Tailscale on the client | Tailscale isn't connected on this computer |
| Type a name from another tailnet | it isn't on this computer's tailnet |
| Quit the app on the host, or put the host to sleep | it's on your tailnet but didn't answer |
| On a Mac client, turn off mymausbot in System Settings → Privacy & Security → Local Network | macOS blocked the connection |

Turn Local Network back on and connect again without restarting the app. The Local Network row is what a packaged build
needs: `NSLocalNetworkUsageDescription` is only in packaged builds.

### A headless server

On a Linux box, run `npx openmausbot serve --tailscale` with certificates on and then off, and once more as a user that
is not Tailscale's operator. With certificates on, expect `https://$NAME`. In the other two runs expect the line that
says it listens on `http://$NAME:8799`, and connect a client with the printed link.

### The phone and the Cloud

1. Pair the phone with the Tailscale route, then move it from Wi-Fi to cellular with Tailscale on. Chats keep working.
2. Turn off **Your other computers** on the host. The client's page stops answering, and the phone keeps working.
3. A MausBot Cloud is not on your tailnet. Lend the host to the Cloud with Tailscale on and confirm it still works over
   the host's own outbound connection.
