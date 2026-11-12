// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { appVersion } from "@/lib/app-links";
import { ServerUpdateRow } from "./ServerUpdateRow";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: { connected: true } }) }));

it("keeps the app title, current server version and usable check action in the extracted row", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const version = appVersion();
  fixture.api.mockImplementation(async (path: string) => {
    if (path === "/api/updates/check") return { current: version, install: "git", available: false };
    if (path === "/api/updates/server") return null;
    throw new Error(`Unexpected request: ${path}`);
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(ServerUpdateRow, { title: `mymausbot v${version}` })); });
    expect(host.textContent).toContain(`mymausbot v${version}`);
    expect(host.textContent).toContain("You're up to date");
    const check = [...host.querySelectorAll("button")].find(button => button.textContent === "Check for updates")!;
    expect(check).toBeDefined();
    const before = fixture.api.mock.calls.filter(([path]) => path === "/api/updates/check").length;
    await act(async () => { check.click(); });
    expect(fixture.api.mock.calls.filter(([path]) => path === "/api/updates/check")).toHaveLength(before + 1);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    vi.unstubAllGlobals();
  }
});
