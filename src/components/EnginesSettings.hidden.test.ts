// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ hidden: [] as Array<{ instanceId: string; displayName: string }>, calls: [] as Array<{ path: string; body?: unknown }>, refresh: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { instances: [] }, refreshInstances: fixture.refresh }),
  api: async (path: string, init?: RequestInit) => {
    fixture.calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path === "/api/instances/hidden") return { instances: fixture.hidden };
    fixture.hidden = [];
    return { instances: [] };
  },
}));

const { HiddenEngines } = await import("./EnginesSettings");

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.calls = [];
  fixture.refresh.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const render = async () => {
  await act(async () => root.render(createElement(HiddenEngines)));
  expect(fixture.calls).toContainEqual({ path: "/api/instances/hidden" });
};

describe("hidden providers in Settings", () => {
  it("shows nothing while no provider is hidden", async () => {
    fixture.hidden = [];
    await render();
    expect(host.querySelector("[data-hidden-engines]")).toBeNull();
  });

  it("lists hidden providers, folded, and unhides one with a click", async () => {
    fixture.hidden = [{ instanceId: "hermes", displayName: "Hermes" }, { instanceId: "pi", displayName: "pi" }];
    await render();
    const list = host.querySelector("[data-hidden-engines]")!;
    expect(list.querySelector("summary")!.textContent).toBe("Hidden (2)");
    expect(list.textContent).toContain("Hermes");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-unhide-engine="hermes"]')!.click());
    expect(fixture.calls).toContainEqual({ path: "/api/instances/hermes", body: { hidden: false } });
    expect(fixture.refresh).toHaveBeenCalled();
  });
});
