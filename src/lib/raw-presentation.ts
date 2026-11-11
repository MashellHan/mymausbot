import { createContext, useContext, type CSSProperties } from "react";
import type { MausColor } from "./mascot";
import { userBubbleStyle } from "./user-bubble-tone";

export const RawPresentation = createContext(false);
export const useRawPresentation = (): boolean => useContext(RawPresentation);

export function rawUserBubbleStyle(color: MausColor, main: boolean): CSSProperties {
  const style = userBubbleStyle(color, { flat: true });
  return main ? { ...style, backgroundColor: "#1c1c1c", backgroundImage: "none", "--color-bubble-user": "#1c1c1c", "--color-bubble-user-ink": "#ffffff", "--color-ink": "#ffffff" } as CSSProperties : style;
}
