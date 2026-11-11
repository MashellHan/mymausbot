import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { chromeForTestingPin, installChromeForTesting } from "../../server/browser/chrome/install.ts";
import { installedChrome } from "./control-omb-ui.ts";
import { fixtureChrome } from "./fixture-chrome.ts";

vi.mock("./control-omb-ui.ts", () => ({ installedChrome: vi.fn(), UI_TOOLS_DIR: "/fixture-tools" }));
vi.mock("../../server/browser/chrome/install.ts", () => ({ chromeForTestingPin: vi.fn(), installChromeForTesting: vi.fn() }));
const directory = mkdtempSync(join(tmpdir(), "omb-fixture-chrome-"));
const explicit = join(directory, "testing-browser");
beforeEach(() => {
  vi.resetAllMocks();
  writeFileSync(explicit, "synthetic executable");
  vi.mocked(installedChrome).mockReturnValue(null);
});
afterEach(() => { rmSync(explicit, { force: true }); });
afterAll(() => { rmSync(directory, { recursive: true, force: true }); });

it("keeps an explicit browser and rejects a missing override instead of silently changing browsers", async () => {
  await expect(fixtureChrome({ OMB_CDP_CHROME: explicit })).resolves.toBe(explicit);
  await expect(fixtureChrome({ AGENT_BROWSER_EXECUTABLE_PATH: explicit })).resolves.toBe(explicit);
  vi.mocked(installedChrome).mockReturnValue("/cached/browser");
  await expect(fixtureChrome({ OMB_CDP_CHROME: join(directory, "missing") })).rejects.toThrow("does not exist");
  expect(installChromeForTesting).not.toHaveBeenCalled();
});

it("reuses the testing-browser cache without probing the system browser or downloading again", async () => {
  vi.mocked(installedChrome).mockReturnValue("/cached/testing-browser");
  await expect(fixtureChrome({})).resolves.toBe("/cached/testing-browser");
  expect(installChromeForTesting).not.toHaveBeenCalled();
});

it("uses the existing verified installer for a cold cache and fails on an unsupported platform", async () => {
  const pin = { version: "1", platform: "fixture", bytes: 42, sha256: "0".repeat(64) };
  vi.mocked(chromeForTestingPin).mockReturnValue(pin);
  vi.mocked(installChromeForTesting).mockResolvedValue("/installed/testing-browser");
  await expect(fixtureChrome({}, directory)).resolves.toBe("/installed/testing-browser");
  expect(installChromeForTesting).toHaveBeenCalledWith({ dataDir: directory, pin });
  vi.mocked(chromeForTestingPin).mockReturnValue(null);
  await expect(fixtureChrome({})).rejects.toThrow("No Chrome for Testing is pinned");
});
