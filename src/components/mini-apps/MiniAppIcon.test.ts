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
