import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

// React's hooks are replayed by hand.
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], revealed: [] as unknown[], takePairOnOpen: vi.fn(), api: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useRef: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = { current: initial }; return f.values[index]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("../lib/phone-pairing", () => ({ takePairOnOpen: () => f.takePairOnOpen(), revealPhonePairing: (root: unknown) => { if (!root) return false; f.revealed.push(root); return true; } }));
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), api: (...args: unknown[]) => f.api(...args) }));
import { ServerPairingCard } from "./ServerPairingCard";

const admin = { kind: "session" as const, id: "s", label: "Mac", scopes: ["admin", "client"], expiresAt: 1 };
const REVEAL = 1; // the effect after the session read

function render(props: Parameters<typeof ServerPairingCard>[0]) {
  f.index = 0; f.effects = [];
  renderToStaticMarkup(createElement(() => ServerPairingCard(props)));
  f.effects[REVEAL]!();
}
const root = () => f.values.find((value) => value && typeof value === "object" && "current" in value && (value as { current: unknown }).current === null) as { current: unknown } | undefined;

beforeEach(() => {
  f.values = []; f.index = 0; f.effects = []; f.revealed = [];
  f.takePairOnOpen.mockReset().mockReturnValue(false);
  f.api.mockReset().mockResolvedValue({ code: "fixture-code", expiresAt: 1 });
});

it("reveals the drawn card once for each request, and never for a plain visit", () => {
  const card = { id: "card" };
  render({ initialSession: admin, focusRequest: 0 });
  root()!.current = card;
  render({ initialSession: admin, focusRequest: 0 });
  expect(f.revealed).toEqual([]);
  render({ initialSession: admin, focusRequest: 1 });
  expect(f.revealed).toEqual([card]);
  render({ initialSession: admin, focusRequest: 1 });
  expect(f.revealed).toEqual([card]);
  render({ initialSession: admin, focusRequest: 2 });
  expect(f.revealed).toEqual([card, card]);
});

it("waits for the card to be drawn before it counts the request as done", () => {
  render({ focusRequest: 1 });
  expect(f.revealed).toEqual([]);
  const card = { id: "card" };
  root()!.current = card;
  render({ focusRequest: 1 });
  expect(f.revealed).toEqual([card]);
});

it("reveals again after Settings went elsewhere and came back on a new request", () => {
  const card = { id: "card" };
  render({ initialSession: admin, focusRequest: 1 });
  root()!.current = card;
  render({ initialSession: admin, focusRequest: 1 });
  render({ initialSession: admin, focusRequest: 0 });
  render({ initialSession: admin, focusRequest: 1 });
  expect(f.revealed).toEqual([card, card]);
});

it.each([
  { team: "Acme", initialSession: { ...admin, team: { id: "team-acme", name: "Acme", role: "admin" } } },
  { initialSession: admin, initialPairingCodes: false },
  { initialSession: admin, funnel: { checking: false, state: { status: "ready" as const, origin: "https://fixture.ts.net" }, refresh: vi.fn() } },
])("reveals without creating an admin invitation when another pairing contract owns the page: %j", (props) => {
  render({ ...props, focusRequest: 0 });
  const card = { id: "owned-pairing" };
  root()!.current = card;
  f.takePairOnOpen.mockReturnValue(true);
  render({ ...props, focusRequest: 1 });
  expect(f.revealed).toEqual([card]);
  expect(f.api).not.toHaveBeenCalled();
  expect(f.takePairOnOpen).not.toHaveBeenCalled();
});

it("creates the ordinary personal invitation once for an explicit desktop pair request", async () => {
  render({ initialSession: admin, focusRequest: 0 });
  root()!.current = { id: "personal-pairing" };
  f.takePairOnOpen.mockReturnValueOnce(true);
  render({ initialSession: admin, focusRequest: 1 });
  await Promise.resolve();
  render({ initialSession: admin, focusRequest: 1 });
  expect(f.api).toHaveBeenCalledExactlyOnceWith("/api/auth/pairing", { method: "POST", body: JSON.stringify({ scopes: ["admin", "client"] }) });
  expect(f.takePairOnOpen).toHaveBeenCalledOnce();
});
