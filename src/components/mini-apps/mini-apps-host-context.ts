import { createContext } from "react";

export type MiniAppsRequest = { id: string; nonce: number };
export type MiniAppsAttach = (slot: HTMLDivElement, request?: MiniAppsRequest) => () => void;

export const MiniAppsHostContext = createContext<MiniAppsAttach | null>(null);
