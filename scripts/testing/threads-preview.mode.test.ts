// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rendered = vi.hoisted(() => [] as Array<string | null>);
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: () => rendered.push(localStorage.getItem("omb-advanced-mode")) }) }));
vi.mock("../../src/App", () => ({ default: () => null }));

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
};

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  values.clear();
  vi.stubGlobal("localStorage", storage);
  rendered.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

async function enter(search: string) {
  vi.resetModules();
  vi.stubGlobal("location", { search });
  await import("./threads-preview");
  return (await import("../../src/lib/interface-mode")).readAdvancedMode();
}

describe("isolated threads preview mode", () => {
  it("selects Simple before rendering when the fixture asks for it", async () => {
    expect(await enter("?fixtureMode=simple")).toBe(false);
    expect(rendered).toEqual(["0"]);
    expect(localStorage.getItem("omb-email-gate")).toBe("skipped");
  });

  it("retains the existing Advanced default for fixtures without the opt-in", async () => {
    expect(await enter("")).toBe(true);
    expect(rendered).toEqual([null]);
    expect(localStorage.getItem("omb-email-gate")).toBe("skipped");
  });

  it("retains onboarding's fresh-install Simple choice", async () => {
    expect(await enter("?onboarding=1")).toBe(false);
    expect(rendered).toEqual(["0"]);
    expect(localStorage.getItem("omb-email-gate")).toBeNull();
  });
});
