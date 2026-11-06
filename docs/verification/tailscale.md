# Tailscale standalone CLI discovery

The macOS app executable chooses GUI or CLI mode from its environment.
Finder-launched OMB processes must set `TAILSCALE_BE_CLI=1`, including when
using the self-hosted server's `tailscale serve` support. No installed wrapper,
interactive shell, or change to the user's environment is required.

## Offline verification

```sh
pnpm exec vitest run companion/test/tailscale-cli.test.ts companion/test/listener.test.ts companion/test/endpoints.test.ts companion/test/control.test.ts server/tailscale.test.ts
```

The fixture starts a real loopback companion control server with disposable
device storage and synthetic network interfaces. Every CLI launch is routed to
an offline child process; it never runs the installed Tailscale or changes a
real tailnet. Without the CLI environment flag the child exits successfully
with GUI startup text, reproducing the reported failure.

Assertions cover:

- `POST /tailscale/refresh` recovering a MagicDNS name after a failed probe.
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
