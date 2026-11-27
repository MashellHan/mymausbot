// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PHONE_HOME_LAYOUT_KEY,
  PHONE_HOME_LAYOUTS,
  parsePhoneHomeLayout,
  readPhoneHomeLayout,
  resetPhoneHomeLayoutForTests,
  setPhoneHomeLayout,
  subscribePhoneHomeLayout,
} from "./phone-home-layout";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, String(value)); },
  };
}

let storage: Storage;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  resetPhoneHomeLayoutForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetPhoneHomeLayoutForTests();
});

describe("phone-home-layout", () => {
  it("defaults to list and parses valid layout values", () => {
    expect(PHONE_HOME_LAYOUTS).toEqual(["list", "cards", "compact"]);
    expect(parsePhoneHomeLayout(null)).toBe("list");
    expect(parsePhoneHomeLayout("unknown")).toBe("list");
    expect(parsePhoneHomeLayout("list")).toBe("list");
    expect(parsePhoneHomeLayout("cards")).toBe("cards");
    expect(parsePhoneHomeLayout("compact")).toBe("compact");
    expect(readPhoneHomeLayout()).toBe("list");
  });

  it("persists to localStorage and notifies subscribers on update", () => {
    const listener = vi.fn();
    const unsub = subscribePhoneHomeLayout(listener);

    setPhoneHomeLayout("cards");
    expect(storage.getItem(PHONE_HOME_LAYOUT_KEY)).toBe("cards");
    expect(readPhoneHomeLayout()).toBe("cards");
    expect(listener).toHaveBeenCalledTimes(1);

    setPhoneHomeLayout("compact");
    expect(storage.getItem(PHONE_HOME_LAYOUT_KEY)).toBe("compact");
    expect(readPhoneHomeLayout()).toBe("compact");
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
    setPhoneHomeLayout("list");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("reacts to cross-tab storage events for its key", () => {
    const listener = vi.fn();
    const unsub = subscribePhoneHomeLayout(listener);

    storage.setItem(PHONE_HOME_LAYOUT_KEY, "cards");
    window.dispatchEvent(new StorageEvent("storage", { key: PHONE_HOME_LAYOUT_KEY, newValue: "cards" }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readPhoneHomeLayout()).toBe("cards");

    unsub();
  });
});
