import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { MiniAppSummary } from "../../../shared/mini-apps";
import { MiniAppIcon, iconKindForApp } from "./MiniAppIcon";

const mojo = { id: "01d8d54b-5b1c-4e8d-be21-e60aa6e42fc7", slug: "mojo" } as MiniAppSummary;

it("identifies the existing Mojo without classifying unrelated app IDs as Mojo", () => {
  expect(iconKindForApp(mojo)).toBe("mojo");
  expect(iconKindForApp({ ...mojo, id: "other" })).toBeNull();
  expect(renderToStaticMarkup(createElement(MiniAppIcon, { kind: iconKindForApp(mojo), app: mojo }))).toContain('data-mini-app-icon="mojo"');
  expect(renderToStaticMarkup(createElement(MiniAppIcon, { kind: null, app: { ...mojo, id: "other" } }))).toContain('data-mini-app-icon="custom"');
  expect(renderToStaticMarkup(createElement(MiniAppIcon, { kind: null, app: { ...mojo, slug: "other" } }))).toContain('data-mini-app-icon="custom"');
});

it.each([{ props: {}, plate: "h-6 w-6" }, { props: { large: true }, plate: "h-9 w-9" },
  { props: { launcher: true }, plate: "h-14 w-14" }])("keeps the flame legible on a $plate plate", ({ props, plate }) => {
  const html = renderToStaticMarkup(createElement(MiniAppIcon, { kind: null, app: mojo, ...props }));
  expect(html).toContain(plate);
  expect(html).toContain("lucide-flame");
  expect(html).toContain("background-color:#a8402e");
  expect(html).toContain("color:#f6d177");
});

it("renders microsoft preset with 4-color SVG tiles, lucide presets, emojis, custom tones, and fallback default icon", () => {
  const base = { ...mojo, id: "custom-app", slug: "work-secretary" };

  for (const [props, plate] of [[{}, "h-6 w-6"], [{ large: true }, "h-9 w-9"], [{ launcher: true }, "h-14 w-14"]] as const) {
    const msHtml = renderToStaticMarkup(createElement(MiniAppIcon, {
      kind: null,
      app: { ...base, icon: { kind: "preset", name: "microsoft", tone: "#0078d4" } },
      ...props,
    }));
    expect(msHtml).toContain('data-mini-app-icon="preset:microsoft"');
    expect(msHtml).toContain(plate);
    expect(msHtml).toContain('viewBox="0 0 20 20"');
    expect(msHtml).toContain('fill="#f25022"');
    expect(msHtml).toContain('fill="#7fba00"');
    expect(msHtml).toContain('fill="#00a4ef"');
    expect(msHtml).toContain('fill="#ffb900"');
    expect(msHtml).toContain("#0078d4");
  }

  const briefcaseHtml = renderToStaticMarkup(createElement(MiniAppIcon, {
    kind: "bookkeeping",
    app: { ...base, shippedTemplateKind: "bookkeeping", icon: { kind: "preset", name: "briefcase", tone: "#123456" } },
  }));
  expect(briefcaseHtml).toContain('data-mini-app-icon="preset:briefcase"');
  expect(briefcaseHtml).toContain("lucide-briefcase");
  expect(briefcaseHtml).toContain("#123456");

  const emojiDefaultHtml = renderToStaticMarkup(createElement(MiniAppIcon, {
    kind: null,
    app: { ...base, icon: { kind: "emoji", value: "📊" } },
    large: true,
  }));
  expect(emojiDefaultHtml).toContain('data-mini-app-icon="emoji"');
  expect(emojiDefaultHtml).toContain("h-9 w-9");
  expect(emojiDefaultHtml).toContain("bg-inset");
  expect(emojiDefaultHtml).toContain('aria-hidden="true">📊</span>');

  const emojiTonedHtml = renderToStaticMarkup(createElement(MiniAppIcon, {
    kind: null,
    app: { ...base, icon: { kind: "emoji", value: "🚀", tone: "#ff5500" } },
    launcher: true,
  }));
  expect(emojiTonedHtml).toContain('data-mini-app-icon="emoji"');
  expect(emojiTonedHtml).toContain("h-14 w-14");
  expect(emojiTonedHtml).toContain("#ff5500");
  expect(emojiTonedHtml).not.toContain("bg-inset");

  const fallbackHtml = renderToStaticMarkup(createElement(MiniAppIcon, {
    kind: null,
    app: { ...base, icon: null },
  }));
  expect(fallbackHtml).toContain('data-mini-app-icon="custom"');
  expect(fallbackHtml).toContain("lucide-app-window");

  const unknownPresetHtml = renderToStaticMarkup(createElement(MiniAppIcon, {
    kind: null,
    app: { ...base, icon: { kind: "preset", name: "unknown-preset" } as unknown as MiniAppSummary["icon"] },
  }));
  expect(unknownPresetHtml).toContain('data-mini-app-icon="custom"');
  expect(unknownPresetHtml).toContain("lucide-app-window");
});
