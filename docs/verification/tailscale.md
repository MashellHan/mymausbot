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
