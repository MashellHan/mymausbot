import { createContext, useContext, type CSSProperties } from "react";
import type { MausColor } from "./mascot";
import { userBubbleStyle } from "./user-bubble-tone";

export const RawPresentation = createContext(false);
export const useRawPresentation = (): boolean => useContext(RawPresentation);

export const rawNeutralBubbleStyle = {
  backgroundColor: "#1c1c1c",
  backgroundImage: "none",
  "--color-bubble-user": "#1c1c1c",
  "--color-bubble-user-ink": "#fcfcfc",
  "--color-ink": "#fcfcfc",
  "--color-ink-secondary": "#c4c4c4",
  "--color-ink-tertiary": "#aaaaaa",
  "--color-panel": "#111111",
  "--color-inset": "#191919",
  "--color-raised": "#2f2f2f",
  "--color-raised-hover": "#3d3d3d",
  "--color-control": "#2f2f2f",
  "--color-hairline": "#707070",
  "--color-accent": "#7fc0ff",
  "--color-accent-text": "#7fc0ff",
  "--color-accent-ink": "#070707",
  "--color-focus": "#7fc0ff",
  "--color-danger": "#ff7788",
  "--color-danger-ink": "#070707",
  "--color-success": "#63b58a",
  "--color-success-ink": "#070707",
  "--bubble-selection": "#555555",
  "--bubble-selection-ink": "#fcfcfc",
} as CSSProperties;

export function rawUserBubbleStyle(color: MausColor, main: boolean): CSSProperties {
  return main ? rawNeutralBubbleStyle : userBubbleStyle(color, { flat: true });
}
