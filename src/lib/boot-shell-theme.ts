import type { SkinChoice, SkinId } from "./skins";

/** Canvas background (`--color-app`) for every skin in `src/styles.css`, used for `<meta name="theme-color">` and the
 * pre-React boot shell so standalone PWAs paint with zero dark/light flash. */
export const SKIN_CANVAS_HEX: Record<SkinId, string> = {
  midnight: "#121212",
  atelier: "#f5f1eb",
  foundry: "#100e0b",
  lagoon: "#dfeceb",
  graphite: "#111214",
  linen: "#eceff3",
  dusk: "#121014",
  daylight: "#fcfcfc",
  meadow: "#ffffff",
  pop: "#fdf5ea",
  halloween: "#110d16",
  diwali: "#100d1f",
  aurora: "#0b0c0b",
};

export const DARK_SKINS: ReadonlySet<SkinId> = new Set<SkinId>([
  "midnight",
  "foundry",
  "graphite",
  "dusk",
  "halloween",
  "diwali",
  "aurora",
]);

export interface BootThemeResolution {
  skin: SkinId;
  themeColor: string;
  colorScheme: "dark" | "light";
}

function isKnownSkinId(value: unknown): value is SkinId {
  return typeof value === "string" && Object.hasOwn(SKIN_CANVAS_HEX, value);
}

export function resolveBootTheme(
  storedChoice: string | null | undefined,
  prefersDark: boolean,
): BootThemeResolution {
  const skin: SkinId =
    storedChoice && storedChoice !== "system" && isKnownSkinId(storedChoice)
      ? storedChoice
      : prefersDark
        ? "midnight"
        : "daylight";
  return {
    skin,
    themeColor: SKIN_CANVAS_HEX[skin],
    colorScheme: DARK_SKINS.has(skin) ? "dark" : "light",
  };
}

export function resolveBootMetaThemeColor(
  storedChoice: string | null | undefined,
  prefersDark: boolean,
): string {
  return resolveBootTheme(storedChoice, prefersDark).themeColor;
}

export function resolveThemeColorForSkin(skin: SkinId | SkinChoice, prefersDark = true): string {
  return resolveBootTheme(skin, prefersDark).themeColor;
}

export function syncDocumentThemeColor(skin: SkinId): void {
  if (typeof document === "undefined") return;
  const color = SKIN_CANVAS_HEX[skin] ?? SKIN_CANVAS_HEX.midnight;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", color);
  }
}

export function canSkipBlockingLocaleLoad(tag: string | undefined): boolean {
  if (!tag) return true;
  const normalized = tag.trim().toLowerCase();
  return normalized === "" || normalized === "en" || normalized.startsWith("en-");
}
