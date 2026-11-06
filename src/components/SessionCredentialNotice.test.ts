import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { SessionCredentialNotice } from "./SessionCredentialNotice";

afterEach(() => { vi.unstubAllGlobals(); setLocale("en"); });

it("shows the App-run lifetime only in session mode, in either supported language", () => {
  vi.stubGlobal("window", { ogb: { credentialMode: () => "system" } });
  expect(renderToStaticMarkup(createElement(SessionCredentialNotice))).toBe("");
  vi.stubGlobal("window", { ogb: { credentialMode: () => "session" } });
  const english = renderToStaticMarkup(createElement(SessionCredentialNotice));
  expect(english).toContain("only until you quit MausBot");
  expect(english).toContain("Previously saved credentials are left untouched");
  setLocale("zh");
  expect(renderToStaticMarkup(createElement(SessionCredentialNotice))).toContain("退出后需要重新输入");
});
