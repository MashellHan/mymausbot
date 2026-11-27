import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { SKIN_IDS } from "../../shared/app-settings";
import {
  canSkipBlockingLocaleLoad,
  DARK_SKINS,
  resolveBootMetaThemeColor,
  resolveBootTheme,
  SKIN_CANVAS_HEX,
} from "./boot-shell-theme";

const ROOT = resolve(__dirname, "../..");

function parseCssSkinAppColors(stylesCss: string): Record<string, string> {
  const result: Record<string, string> = {};
  const blockPattern = /\[data-skin="([a-z]+)"\]\s*\{([^}]*)\}/g;
  for (const match of stylesCss.matchAll(blockPattern)) {
    const skin = match[1];
    const body = match[2];
    if (!skin || !body) continue;
    const colorMatch = /--color-app:\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(body);
    if (colorMatch?.[1]) {
      result[skin] = colorMatch[1].toLowerCase();
    }
  }
  return result;
}

describe("instant boot shell theme and CSP invariants", () => {
  it("matches every SKIN_IDS entry to its exact --color-app token in src/styles.css", () => {
    const styles = readFileSync(resolve(ROOT, "src/styles.css"), "utf8");
    const parsed = parseCssSkinAppColors(styles);

    for (const skin of SKIN_IDS) {
      expect(SKIN_CANVAS_HEX[skin]).toBeDefined();
      expect(parsed[skin]).toBe(SKIN_CANVAS_HEX[skin].toLowerCase());
    }
  });

  it("keeps index.html free of inline <script> blocks for strict script-src 'self' CSP", () => {
    const html = readFileSync(resolve(ROOT, "index.html"), "utf8");
    const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scriptTags.length).toBeGreaterThanOrEqual(2);
    for (const [, attrs, body] of scriptTags) {
      expect(attrs).toMatch(/\bsrc=/i);
      expect((body ?? "").trim()).toBe("");
    }
    expect(html).toContain('src="/boot-theme.js"');
    expect(html).toContain("data-boot-shell");
  });

  it("resolves system, explicit, and unknown skins deterministically", () => {
    expect(resolveBootTheme("system", true)).toEqual({
      skin: "midnight",
      themeColor: "#121212",
      colorScheme: "dark",
    });
    expect(resolveBootTheme("system", false)).toEqual({
      skin: "daylight",
      themeColor: "#fcfcfc",
      colorScheme: "light",
    });
    expect(resolveBootTheme("atelier", true)).toEqual({
      skin: "atelier",
      themeColor: "#f5f1eb",
      colorScheme: "light",
    });
    expect(resolveBootMetaThemeColor("unknown-skin", false)).toBe("#fcfcfc");
    expect(DARK_SKINS.has("aurora")).toBe(true);
    expect(DARK_SKINS.has("daylight")).toBe(false);
  });

  it("runs public/boot-theme.js safely even when localStorage throws and updates theme-color", () => {
    const source = readFileSync(resolve(ROOT, "public/boot-theme.js"), "utf8");
    let metaContent = "#121212";
    const styleProps: Record<string, string> = {};
    const docEl = {
      dataset: {} as Record<string, string>,
      style: {
        colorScheme: "",
        setProperty: (k: string, v: string) => {
          styleProps[k] = v;
        },
      },
    };
    const sandbox = {
      window: {
        get localStorage() {
          throw new Error("SecurityError");
        },
        matchMedia: () => ({ matches: false }),
      } as Record<string, unknown>,
      document: {
        documentElement: docEl,
        querySelector: () => ({
          setAttribute: (_name: string, value: string) => {
            metaContent = value;
          },
        }),
      },
      performance: { now: () => 42 },
      Object,
      Boolean,
      Date,
    };

    vm.runInNewContext(source, sandbox);
    expect(docEl.dataset.skin).toBe("daylight");
    expect(docEl.style.colorScheme).toBe("light");
    expect(metaContent).toBe("#fcfcfc");
    expect(styleProps["--boot-bg"]).toBe("#fcfcfc");
    expect(sandbox.window.__ombBootTs).toBe(42);
  });

  it("detects when English locale does not need a blocking network pack fetch", () => {
    expect(canSkipBlockingLocaleLoad(undefined)).toBe(true);
    expect(canSkipBlockingLocaleLoad("")).toBe(true);
    expect(canSkipBlockingLocaleLoad("en")).toBe(true);
    expect(canSkipBlockingLocaleLoad("en-US")).toBe(true);
    expect(canSkipBlockingLocaleLoad("zh-CN")).toBe(false);
    expect(canSkipBlockingLocaleLoad("ja")).toBe(false);
  });
});
