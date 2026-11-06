// @vitest-environment happy-dom
import { act, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { CompanionAccountState } from "../types/ogb";
import { PAIRING_RENEW_MS } from "./PhonePairingQr";
import { PhoneSetupFlowView, usePhoneSetupController, type CompanionState } from "./PhoneSetupFlow";

const HOSTED = "https://c-opaque.openmausbot.com";
const token = (letter: string) => `omb_pair_${letter.repeat(43)}`;

function View() {
  const c = usePhoneSetupController();
  return createElement("div", null,
    createElement(PhoneSetupFlowView, { controller: c }),
    createElement("span", { "data-pairing-link": true }, c.pairingLink ?? ""));
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setLocale("en");
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  vi.useRealTimers();
  host.remove();
  delete (globalThis as { ogb?: unknown }).ogb;
});

it("renews through one stable controller timer while polling and rejects a foreign replacement", async () => {
  let state: CompanionState = { enabled: true, keepAwake: false, port: 8810, devices: [], pairing: null,
    endpoints: [{ kind: "hosted", url: HOSTED, priority: 0 }],
    e2e: { enabled: true, relay: "connected", node: null, descriptor: { v: 1, k: "a".repeat(87) } } };
  const account: CompanionAccountState = { available: true, status: "ready", email: "ada@example.com", endpoint: HOSTED };
  const valid = new Set<string>();
  const bridge = {
    companion: {
      state: vi.fn(async () => state),
      start: vi.fn(async () => state),
      pairing: vi.fn(async (open: boolean) => {
        state = { ...state, pairing: open ? { code: "123456", token: token("b"), expiresAt: Date.now() + 120_000 } : null };
        if (state.pairing) valid.add(state.pairing.token);
        return state;
      }),
      renewPairing: vi.fn(async () => {
        state = { ...state, pairing: { code: "654321", token: token("c"), expiresAt: Date.now() + 120_000 } };
        valid.add(state.pairing.token);
        return state;
      }),
    },
    companionAccount: { state: vi.fn(async () => account), prepare: vi.fn(async () => account) },
  };
  (globalThis as { ogb?: unknown }).ogb = bridge;
  flushSync(() => root.render(createElement(View)));
  await vi.waitFor(() => expect((host.querySelector("button[data-phone-pairing-action]") as HTMLButtonElement)?.disabled).toBe(false));
  flushSync(() => (host.querySelector("button[data-phone-pairing-action]") as HTMLButtonElement).click());
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Device pairing QR code"]')).not.toBeNull());
  expect(host.querySelector("[data-pairing-link]")?.textContent).toContain(token("b"));

  for (let second = 0; second < PAIRING_RENEW_MS / 1_000 - 1; second += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  }
  expect(bridge.companion.renewPairing).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(bridge.companion.renewPairing).toHaveBeenCalledOnce();
  expect(bridge.companion.pairing).toHaveBeenCalledTimes(1);
  expect(host.querySelector("[data-pairing-link]")?.textContent).toContain(token("c"));
  expect(host.querySelector('[aria-label="Device pairing QR code"]')).not.toBeNull();
  expect(valid).toEqual(new Set([token("b"), token("c")]));

  state = { ...state, pairing: { code: "999999", token: token("d"), expiresAt: Date.now() + 120_000 } };
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(host.querySelector('[aria-label="Device pairing QR code"]')).toBeNull();
  expect(host.textContent).toContain("code changed");
});
