// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { browserAvailable, type FeatureFlagConfig } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const view = { current: "browser" };
  vi.stubGlobal("localStorage", { getItem: () => view.current, setItem: () => {} });
  return { config: {} as FeatureFlagConfig & { cloudHome?: boolean }, view,
    dispatch: vi.fn(), flushBotPatches: vi.fn(async () => null) };
});
// These cover the Advanced panel; ComputerPanel.simple.test.ts covers Simple.
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, setAdvancedMode: () => {} }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(async () => ({})),
  useStore: () => ({
    state: { config: { box: { configured: false }, ...fixture.config }, instances: [], computerControl: {}, routines: [], routineRuns: [] },
    dispatch: fixture.dispatch,
    flushBotPatches: fixture.flushBotPatches,
  }),
}));
import { ComputerPanel } from "./ComputerPanel";

afterAll(() => vi.unstubAllGlobals());
const bot = { id: "browser-fixture", name: "Browser fixture", modelSelection: { instanceId: "fixture" } } as Bot;
const render = (config: FeatureFlagConfig & { cloudHome?: boolean }, browser?: boolean) => {
  fixture.config = config;
  return renderToStaticMarkup(createElement(ComputerPanel, { bot: { ...bot, browser } }));
};

describe("Browser panel installation access", () => {
  const missing = { kind: "unavailable", installable: true } as const;

  it("shows the real install panel before the engine is available", () => {
    const config = { features: { browser: true }, browserEngine: missing };
    expect(render(config)).toContain("Install the browser");
    expect(browserAvailable(config)).toBe(false);
  });

  it("retains the global and per-bot opt-in gates", () => {
    expect(render({ browserEngine: missing })).not.toContain("Install the browser");
    expect(render({ features: { browser: true }, browserEngine: missing }, false)).not.toContain("Install the browser");
  });

  it("does not offer an install on unsupported hosts and still shows a ready engine", () => {
    expect(render({ features: { browser: true }, browserEngine: { kind: "unavailable", installable: false } })).not.toContain("The browser isn't installed");
    const ready = render({ features: { browser: true }, browserEngine: { kind: "engine" } });
    expect(ready).toContain("Opening the live browser…");
    expect(ready).not.toMatch(/Loading browser…|Only admins/);
  });

  it("keeps Chrome setup failure and progress visible even when the binary exists", () => {
    const failed = render({ features: { browser: true }, browserEngine: { kind: "engine", installError: "Chrome download failed" } });
    expect(failed).toContain("Chrome download failed");
    expect(failed).toContain("Retry browser installation");
    expect(failed).not.toContain("has its own browser");
    const installing = render({ features: { browser: true }, browserEngine: { kind: "engine", installing: true } });
    expect(installing).toContain("Installing…");
    expect(installing).toContain('disabled=""');
    expect(installing).not.toContain("has its own browser");
  });
});

describe("Computer panel on a narrow screen", () => {
  it("covers the chat while the default-width panel and chat cannot fit side by side", () => {
    const markup = render({});
    const aside = /<aside class="([^"]*)"/.exec(markup)!;
    expect(aside[1].split(" ")).toEqual(expect.arrayContaining(["max-2xl:absolute", "max-2xl:inset-y-0", "max-2xl:right-0", "max-2xl:z-40"]));
    expect(markup).toContain("width:960px;max-width:");
    const separator = /<div role="separator"[^>]*class="([^"]*)"/.exec(markup)!;
    expect(separator[1].split(" ")).toContain("max-2xl:hidden");
  });
});

describe("Computer panel Works on", () => {
  const computerTab = async (config: FeatureFlagConfig & { cloudHome?: boolean }) => {
    fixture.view.current = "computer";
    fixture.config = config;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ComputerPanel, { bot: { ...bot, threadId: "fixture", computer: "off" } })));
      const section = host.querySelector<HTMLElement>('[data-testid="bot-overview-works"]')!;
      const disclosure = section.querySelector("button")!;
      const content = section.querySelector<HTMLElement>("#bot-overview-works-content")!;
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      expect(content.hidden).toBe(true);
      expect(content.querySelector('[role="group"]')).toBeNull();
      await act(async () => disclosure.click());
      expect(disclosure.getAttribute("aria-expanded")).toBe("true");
      expect(content.hidden).toBe(false);
      const places = [...content.querySelectorAll('[role="group"] button')]
        .map((button) => button.querySelector("span span")?.textContent?.trim());
      return { places, text: content.textContent ?? "" };
    } finally {
      await act(async () => root.unmount());
      host.remove();
      fixture.view.current = "browser";
    }
  };

  it("lists this computer and a private desktop on a desktop or self-hosted server", async () => {
    const { places, text } = await computerTab({});
    expect(places).toEqual(["Auto", "Cloud desktop", "Private desktop", "This computer", "Browser", "Off"]);
    expect(text).toContain("Choose where this bot works.");
  });

  it("lists neither on My Cloud, and says why", async () => {
    const { places, text } = await computerTab({ cloudHome: true });
    expect(places).toEqual(["Auto", "Cloud desktop", "Browser", "Off"]);
    expect(text).toContain("Choose where this bot works. It can also use your computer whenever mymausbot is open on it.");
  });
});

describe("Computer panel header", () => {
  it("names its icon-only close button", () => {
    expect(render({})).toContain(`aria-label="${t("computer.close")}"`);
  });
});
