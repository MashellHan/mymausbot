// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TailscaleFunnelConnection } from "../lib/tailscale-funnel";
import { ServerPairingCard } from "./ServerPairingCard";

const fx = vi.hoisted(() => ({ api: vi.fn(), copy: vi.fn(), session: { kind: "loopback" } as Record<string, unknown> }));
vi.mock("@/state/store", async original => ({ ...await original<typeof import("@/state/store")>(), api: (...args: unknown[]) => fx.api(...args) }));
vi.mock("../lib/session", async original => ({ ...await original<typeof import("../lib/session")>(), readSessionState: async () => fx.session }));
vi.mock("@/lib/copy-text", () => ({ copyText: (...args: unknown[]) => fx.copy(...args) }));
vi.mock("qrcode.react", () => ({ QRCodeSVG: ({ value }: { value: string }) => createElement("svg", { "data-qr-value": value }) }));

const ORIGIN = "https://computer.tail123.ts.net";
const CREDENTIAL = `omb_pair_${"a".repeat(43)}`;
let host: HTMLDivElement, root: Root, funnel: TailscaleFunnelConnection;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][data-pair-dialog="code"]');
const qr = () => dialog()?.querySelector<SVGElement>("[data-qr-value]") ?? null;
const click = async (selector: string) => { await act(async () => { host.querySelector<HTMLButtonElement>(selector)!.click(); }); };
const render = async (props: Partial<Parameters<typeof ServerPairingCard>[0]> = {}) => {
  await act(async () => { root.render(createElement(ServerPairingCard, { funnel, ...props })); });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fx.session = { kind: "loopback" };
  fx.copy.mockReset().mockResolvedValue("copied");
  fx.api.mockReset().mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path === "/api/auth/sessions") return { sessions: [] };
    if (path === "/api/config") return {};
    if (path === "/api/auth/pairing" && options?.method === "POST") return { id: "pair-fixture", code: "AAAABBBBCCCC", credential: CREDENTIAL, expiresAt: Date.now() + 300000, serverName: "Fixture computer", url: null, hint: "No public URL" };
    throw new Error(`Unexpected request: ${path}`);
  });
  funnel = { checking: false, state: { status: "ready", origin: ORIGIN }, refresh: vi.fn().mockResolvedValue({ status: "ready", origin: ORIGIN }) };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
  expect(dialog()).toBeNull();
});

it("creates a client-only native QR using a freshly verified origin and the one-time credential", async () => {
  const fresh = `${ORIGIN}:8443`;
  vi.mocked(funnel.refresh).mockResolvedValue({ status: "ready", origin: fresh });
  await render({ simple: true });
  expect(host.querySelector("[data-phone-pairing-action]")).toBe(host.querySelector("[data-funnel-pairing-action]"));
  await click("[data-funnel-pairing-action]");
  expect(funnel.refresh).toHaveBeenCalledOnce();
  const pairing = fx.api.mock.calls.find(([path]) => path === "/api/auth/pairing")!;
  expect(JSON.parse(pairing[1].body)).toEqual({ scopes: ["client"] });
  expect(vi.mocked(funnel.refresh).mock.invocationCallOrder[0]).toBeLessThan(fx.api.mock.invocationCallOrder[fx.api.mock.calls.indexOf(pairing)]!);
  const link = new URL(qr()!.getAttribute("data-qr-value")!);
  expect(link.protocol).toBe("openmausbot:");
  expect(link.host).toBe("pair");
  expect(link.searchParams.get("address")).toBe(fresh);
  expect(link.searchParams.get("token")).toBe(CREDENTIAL);
  expect(link.searchParams.get("name")).toBe("Fixture computer");
  expect(link.searchParams.has("code")).toBe(false);
  expect(dialog()?.textContent).toContain("phone app");
  expect(document.body.textContent).not.toContain(CREDENTIAL);
  expect(document.body.textContent).not.toContain("AAAABBBBCCCC");
  const copy = [...dialog()!.querySelectorAll("button")].find(button => button.textContent === "Copy link")!;
  await act(async () => { copy.click(); });
  expect(fx.copy).toHaveBeenCalledWith(link.href);
});

it("keeps native Funnel pairing available without taking another flow's focus", async () => {
  await render({ reveal: false, focusRequest: 1 });
  expect(host.querySelector("[data-phone-pairing-action]")).toBeNull();
  expect(document.activeElement).not.toBe(host.querySelector("[data-funnel-pairing-action]"));
  expect(fx.api.mock.calls.filter(([path]) => path === "/api/auth/pairing")).toHaveLength(0);
  await render({ reveal: true, focusRequest: 1 });
  expect(host.querySelector("[data-phone-pairing-action]")).toBe(host.querySelector("[data-funnel-pairing-action]"));
  await click("[data-funnel-pairing-action]");
  const pairing = fx.api.mock.calls.find(([path]) => path === "/api/auth/pairing")!;
  expect(JSON.parse(pairing[1].body)).toEqual({ scopes: ["client"] });
});

it("clears the old QR and does not issue another credential when verification fails", async () => {
  await render(); await click("[data-funnel-pairing-action]"); expect(qr()).not.toBeNull();
  vi.mocked(funnel.refresh).mockResolvedValue({ status: "unavailable", reason: "unverified" });
  await click("[data-funnel-pairing-action]");
  expect(qr()).toBeNull();
  expect(fx.api.mock.calls.filter(([path]) => path === "/api/auth/pairing")).toHaveLength(1);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Check Tailscale");
  funnel = { ...funnel, state: { status: "unavailable", reason: "unverified" } };
  await render();
  expect(host.querySelector("[data-phone-pairing-action]")).toBe(host.querySelector("[data-funnel-pairing-action]"));
  expect(host.querySelector("[data-funnel-pairing-action]")?.textContent).toBe("Check again");
});

it("refreshes the server device list while the native invitation is open", async () => {
  await render(); await click("[data-funnel-pairing-action]");
  fx.api.mockResolvedValueOnce({ sessions: [{ id: "native-phone", label: "Fixture iPhone", scopes: ["client"], lastSeenAt: Date.now(), expiresAt: Date.now() + 86400000 }] });
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(host.textContent).toContain("Fixture iPhone");
  expect([...host.querySelectorAll("button")].some(button => button.textContent === "Remove")).toBe(true);
});

it("removes an expired native QR and rejects malformed native credentials", async () => {
  await render(); await click("[data-funnel-pairing-action]");
  await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
  expect(qr()).toBeNull();
  expect(dialog()?.textContent).toContain("expired");
  fx.api.mockResolvedValueOnce({ credential: "invalid", expiresAt: Date.now() + 300000 });
  await click("[data-funnel-pairing-action]");
  expect(qr()).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Create a new code");
});

it("keeps browser/admin pairing separate and hides native creation from non-owners, portal members and cloud homes", async () => {
  await render();
  const browser = [...host.querySelectorAll("button")].find(button => button.textContent === "Pair a phone")!;
  await act(async () => { browser.click(); });
  expect(funnel.refresh).not.toHaveBeenCalled();
  expect(JSON.parse(fx.api.mock.calls.find(([path]) => path === "/api/auth/pairing")![1].body)).toEqual({ scopes: ["admin", "client"] });
  expect(dialog()?.textContent).toContain("AAAABBBBCCCC");
  await render({ cloudHome: true }); expect(host.querySelector("[data-funnel-pairing-action]")).toBeNull();
  await act(async () => { root.unmount(); }); root = createRoot(host);
  fx.api.mockImplementation(async (path: string) => path === "/api/config" ? { membership: { pairingCodes: false } } : { sessions: [] });
  await render({ initialPairingCodes: false }); expect(host.querySelector("[data-funnel-pairing-action]")).toBeNull();
  await act(async () => { root.unmount(); }); root = createRoot(host);
  fx.session = { kind: "session", id: "phone", scopes: ["client"] };
  await render(); expect(host.querySelector("[data-funnel-pairing-action]")).toBeNull();
});
