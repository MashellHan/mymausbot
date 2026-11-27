// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { appVersion } from "@/lib/app-links";
import { StoreProvider } from "@/state/store";
import { fullContext, pageById } from "./settings-index";
import { SettingsPageHeader, overviewStatus } from "./SettingsPageHeader";

beforeEach(() => {
  setLocale("en");
  (window as unknown as { ogb: unknown }).ogb = { app: { version: "9.8.7", ownPage: false } };
});

afterEach(() => {
  delete (window as unknown as { ogb?: unknown }).ogb;
  setLocale("en");
});

describe("overviewStatus on a Cloud's page in the desktop window", () => {
  it("names the desktop app's version for This computer", () => {
    expect(overviewStatus({ name: "This computer", kind: "computer", color: null, named: false })).toContain("9.8.7");
  });

  it("names the page's own version for the Cloud", () => {
    const line = overviewStatus({ name: "My Cloud", kind: "cloud", color: null, named: false });
    expect(line).toContain(appVersion());
    expect(line).not.toContain("9.8.7");
  });
});

describe("SettingsPageHeader browser titles and avatar fallback", () => {
  const place = { name: "Mac mini", kind: "server" as const, color: null, named: true };

  it("titles app as General in browser Simple mode and This app in browser Advanced mode", () => {
    const simple = renderToStaticMarkup(createElement(StoreProvider, null, createElement(SettingsPageHeader, {
      page: pageById("app"), ctx: fullContext({ desktop: false, here: false, home: false, advanced: false }), place, narrow: false,
    })));
    expect(simple).toMatch(/<h2[^>]*>General<\/h2>/);
    expect(simple).not.toContain("This browser");

    const advanced = renderToStaticMarkup(createElement(StoreProvider, null, createElement(SettingsPageHeader, {
      page: pageById("app"), ctx: fullContext({ desktop: false, here: false, home: false, advanced: true }), place, narrow: false,
    })));
    expect(advanced).toMatch(/<h2[^>]*>This app<\/h2>/);
    expect(advanced).not.toContain("This browser");
  });

  it("uses the UserRound fallback icon instead of '?' in account scope line when nameless", () => {
    const html = renderToStaticMarkup(createElement(StoreProvider, null, createElement(SettingsPageHeader, {
      page: pageById("account"), ctx: fullContext({ desktop: false, here: false, home: false, client: true, advanced: false }), place, narrow: false,
    })));
    expect(html).toContain('data-you-avatar-fallback=""');
    expect(html).not.toContain(">?<");
  });
});
