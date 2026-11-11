import { createContext, useContext } from "react";

export const RawPresentation = createContext(false);
export const useRawPresentation = (): boolean => useContext(RawPresentation);
