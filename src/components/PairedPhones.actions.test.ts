// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { PairedPhones } from "./PairedPhones";
import { usePhoneSetupController, type CompanionState } from "./PhoneSetupFlow";

function View() {
  const c = usePhoneSetupController();
  return createElement("div", null,
    c.state && createElement(PairedPhones, { c, state: c.state }),
    c.error && createElement("p", { role: "alert" }, c.error));
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete (globalThis as { ogb?: unknown }).ogb;
});

it("keeps a phone visible after a failed or unavailable revoke and announces only confirmed removal", async () => {
  let state: CompanionState = { enabled: true, keepAwake: false, port: 8810, pairing: null, devices: [{
    id: "phone-1", name: "Ada", createdAt: Date.now(), lastSeenAt: Date.now(), cloudDesktopAccess: false,
  }] };
  let fail = true;
  const bridge = { state: vi.fn(async () => state), revoke: vi.fn(async () => {
    if (fail) throw new Error("save failed");
    state = { ...state, devices: [] };
    return state;
  }) };
  (globalThis as { ogb?: unknown }).ogb = { companion: bridge };
  flushSync(() => root.render(createElement(View)));
  await vi.waitFor(() => expect(host.textContent).toContain("Ada"));
  flushSync(() => (host.querySelector("button[aria-expanded]") as HTMLButtonElement).click());
  const remove = () => [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Remove phone") as HTMLButtonElement;

  remove().click();
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("save failed"));
  expect(host.textContent).toContain("Ada");
  expect(host.textContent).not.toContain("Removed Ada");

  delete (globalThis as { ogb?: unknown }).ogb;
  remove().click();
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("desktop"));
  expect(host.textContent).toContain("Ada");

  (globalThis as { ogb?: unknown }).ogb = { companion: bridge };
  fail = false;
  remove().click();
  await vi.waitFor(() => expect(host.querySelector('[role="status"]')?.textContent).toContain("Ada"));
  expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(host.querySelector("li")).toBeNull();
  expect(bridge.revoke).toHaveBeenCalledTimes(2);
});
