// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionState } from "@/lib/session";

const fixture = vi.hoisted(() => ({
  profile: undefined as { name?: string; email?: string; avatarUrl?: string } | undefined,
  session: { kind: "loopback" } as SessionState,
}));

vi.mock("@/state/store", () => ({
  api: vi.fn(async () => ({})),
  useStore: () => ({
    state: { config: { profile: fixture.profile }, routines: [], webhooks: [], routineRuns: [], bots: [], activeView: "chat" },
    dispatch: vi.fn(),
  }),
}));
vi.mock("@/lib/session", async (original) => ({
  ...(await original<typeof import("@/lib/session")>()),
  readSessionState: async () => fixture.session,
}));
vi.mock("./SidebarPhoneButton", () => ({ useSidebarPhoneStatus: () => ({ kind: "unavailable" }) }));

import { SidebarProfileMenu } from "./SidebarProfileMenu";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  fixture.profile = undefined;
  fixture.session = { kind: "loopback" };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const mount = async (props: Parameters<typeof SidebarProfileMenu>[0] = { iconOnly: true, circle: true }) => {
  await act(async () => { root.render(createElement(SidebarProfileMenu, props)); });
  await act(async () => { await Promise.resolve(); });
};

it("renders UserRound (no ?) in both the iconOnly circle trigger and the opened menu header when profile has no name or email", async () => {
  await mount({ iconOnly: true, circle: true });
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  expect(trigger.querySelector("svg.lucide-user-round")?.getAttribute("width")).toBe("18");
  expect(trigger.textContent).not.toContain("?");

  await act(async () => { trigger.click(); });
  const menu = document.body.querySelector<HTMLElement>('[role="menu"]')!;
  expect(menu).not.toBeNull();
  const headerAvatar = menu.querySelector<HTMLElement>('[data-avatar="initials"]')!;
  expect(headerAvatar.querySelector("svg.lucide-user-round")?.getAttribute("width")).toBe("16");
  expect(headerAvatar.textContent).not.toContain("?");
});

it("renders profile initials instead of UserRound once a named profile is loaded", async () => {
  fixture.profile = { name: "Ada Lovelace" };
  await mount({ iconOnly: true, circle: true });
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  expect(trigger.querySelector("svg.lucide-user-round")).toBeNull();
  expect(trigger.textContent).toContain("AL");

  await act(async () => { trigger.click(); });
  const headerAvatar = document.body.querySelector<HTMLElement>('[role="menu"] [data-avatar="initials"]')!;
  expect(headerAvatar.querySelector("svg.lucide-user-round")).toBeNull();
  expect(headerAvatar.textContent).toBe("AL");
});
