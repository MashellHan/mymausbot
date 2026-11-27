import { describe, expect, it, vi } from "vitest";
import { attemptStaleModuleAutoReload, isStaleModuleError } from "./stale-module-recovery";

describe("stale-module-recovery", () => {
  it("recognizes WebKit/Chromium dynamic module import errors", () => {
    expect(isStaleModuleError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isStaleModuleError(new Error("Failed to fetch dynamically imported module: https://mausbot.mxhan.com/assets/App-abc.js"))).toBe(true);
    expect(isStaleModuleError(new Error("Regular runtime error"))).toBe(false);
  });

  it("clears shell caches and reloads once, then enforces cooldown to prevent reload loops", async () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    };
    const reload = vi.fn();
    const clearCaches = vi.fn(async () => {});

    expect(attemptStaleModuleAutoReload(new TypeError("Importing a module script failed."), {
      now: 100_000,
      storage,
      reload,
      clearCaches,
    })).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(clearCaches).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);

    // Within 15s cooldown: do not trigger another reload loop
    expect(attemptStaleModuleAutoReload(new TypeError("Importing a module script failed."), {
      now: 105_000,
      storage,
      reload,
      clearCaches,
    })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);

    // After cooldown expires: allow recovery again
    expect(attemptStaleModuleAutoReload(new TypeError("Importing a module script failed."), {
      now: 120_000,
      storage,
      reload,
      clearCaches,
    })).toBe(true);
  });
});
