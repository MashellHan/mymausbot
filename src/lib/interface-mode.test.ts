import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const values = new Map<string, string>();
const local = {
  getItem: vi.fn((key: string) => values.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  removeItem: vi.fn((key: string) => { values.delete(key); }),
};

async function launch(simpleOnly = false) {
  vi.resetModules();
  vi.doMock("./simple-only", () => ({ SIMPLE_ONLY: simpleOnly }));
  return import("./interface-mode");
}

beforeEach(() => {
  values.clear();
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => {
  vi.doUnmock("./simple-only");
  vi.unstubAllGlobals();
});

describe("interface mode migration", () => {
  it.each([undefined, "0", "1"])("opens a new or old-boolean installation in Raw (%s) and settles once", async (old) => {
    values.set("omb-installed", "2026-01-01");
    if (old) values.set("omb-advanced-mode", old);
    const first = await launch();
    expect(first.readInterfaceMode()).toBe("raw");
    first.settleInterfaceModeDefault();
    expect(values.get(first.INTERFACE_MODE_KEY)).toBe("raw");
    expect(values.has(first.ADVANCED_MODE_KEY)).toBe(false);
    expect((await launch()).readInterfaceMode()).toBe("raw");
  });

  it.each(["raw", "simple", "advanced"] as const)("keeps explicit %s over relaunch and old markers", async (choice) => {
    values.set("omb-advanced-mode", "1");
    values.set("omb-new-look", "seen");
    const first = await launch();
    first.setInterfaceMode(choice);
    first.settleInterfaceModeDefault();
    const next = await launch();
    expect(next.readInterfaceMode()).toBe(choice);
    expect(next.readAdvancedMode()).toBe(choice === "advanced");
  });

  it("maps explicit legacy switch calls to the canonical choice", async () => {
    const mode = await launch();
    mode.setAdvancedMode(true);
    expect(values.get(mode.INTERFACE_MODE_KEY)).toBe("advanced");
    mode.setAdvancedMode(false);
    expect(values.get(mode.INTERFACE_MODE_KEY)).toBe("simple");
    expect((await launch()).readInterfaceMode()).toBe("simple");
  });

  it("keeps a session choice if writing storage fails", async () => {
    const mode = await launch();
    local.setItem.mockImplementationOnce(() => { throw new Error("quota"); });
    mode.setInterfaceMode("advanced");
    expect(mode.readInterfaceMode()).toBe("advanced");
  });

  it("keeps the restricted Simple-only build in Simple", async () => {
    values.set("omb-interface-mode", "advanced");
    const mode = await launch(true);
    mode.setInterfaceMode("raw");
    expect(mode.readInterfaceMode()).toBe("simple");
    expect(values.get(mode.INTERFACE_MODE_KEY)).toBe("advanced");
  });
});
