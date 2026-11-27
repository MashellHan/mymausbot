// The trap is module scope: the page list is built once at import time, so it holds keys, and a label resolved there
// would keep the boot language.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { en, locales } from "@/locales";
import { StoreProvider } from "@/state/store";

// No DOM here: the screen only asks whether the desktop bridge is there, so an empty window answers as a browser tab
// does.
beforeAll(() => {
  (globalThis as { window?: unknown }).window ??= {};
  // The skin picker reads the attribute main.tsx stamps before first paint.
  (globalThis as { document?: unknown }).document ??= { documentElement: { dataset: {} } };
});

// Analytics (mocked below) boots PostHog on import, which wants a real browser.
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, useInterfaceMode: () => "advanced", setAdvancedMode: () => {}, setInterfaceMode: vi.fn() }));
vi.mock("@/lib/analytics", () => ({
  analyticsEnabled: () => false,
  setAnalyticsEnabled: () => {},
}));

async function renderSettings(): Promise<string> {
  const { SettingsModal } = await import("./SettingsModal");
  return renderToStaticMarkup(createElement(StoreProvider, null, createElement(SettingsModal)));
}

afterEach(() => {
  setLocale("en");
});

describe("Settings in another language", () => {
  const NAV = ["settings.page.bots", "settings.page.desktops", "settings.page.spending", "settings.page.data", "settings.page.account",
    "settings.page.app", "settings.section.general", "settings.section.appearance", "settings.section.phoneDevices"] as const;
  const MODE = ["settings.interfaceMode.title", "settings.interfaceMode.raw", "settings.interfaceMode.simple", "settings.interfaceMode.advanced"] as const;

  async function renderAppearance(): Promise<string> {
    const [{ AppearancePage }, { SettingsShellContext }, { fullContext }] = await Promise.all([
      import("./settings/pages/AppPages"),
      import("./settings/settings-shell"),
      import("./settings/settings-index"),
    ]);
    return renderToStaticMarkup(
      createElement(StoreProvider, null,
        createElement(SettingsShellContext.Provider, {
          value: { ctx: fullContext({ desktop: false, here: false, home: false }), place: { name: "My Cloud", kind: "cloud", color: null, named: true }, page: "appearance", anchor: null, go: () => {} },
        }, createElement(AppearancePage))),
    );
  }

  it("renders in the language the picker selected, and re-renders in the next one", async () => {
    for (const locale of ["pt-br", "ja"] as const) {
      setLocale(locale);
      const html = await renderSettings();
      for (const key of NAV) {
        expect(locales[locale][key], `${locale} ${key}`).toBeTruthy();
        expect(html, `${locale} ${key}`).toContain(locales[locale][key]!.replaceAll("&", "&amp;"));
      }
      const appearance = await renderAppearance();
      for (const key of MODE) {
        expect(locales[locale][key], `${locale} ${key}`).toBeTruthy();
        expect(appearance, `${locale} ${key}`).toContain(locales[locale][key]!.replaceAll("&", "&amp;"));
      }
    }
    expect(await renderSettings()).not.toContain(locales["pt-br"]["settings.page.bots"]!);
  });

  it("stays English when no language is picked", async () => {
    setLocale("en");
    const html = await renderSettings();
    for (const key of NAV) expect(html, key).toContain(en[key].replaceAll("&", "&amp;"));
    const appearance = await renderAppearance();
    for (const key of MODE) expect(appearance, key).toContain(en[key].replaceAll("&", "&amp;"));
  });

  it("has no page picker of its own: the nav is the list, and the dialog keeps its name", async () => {
    const html = await renderSettings();
    expect(html.match(/<select\b[^>]*>/g)).toBeNull();
    expect(html).toMatch(/<nav[^>]*aria-label="Settings"/);
    expect(html).toContain('id="app-settings-title" class="sr-only"');
  });
});
