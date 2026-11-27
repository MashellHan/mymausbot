export interface PwaShellGateInput {
  remotePwa: boolean;
  remoteClient: boolean;
  calendarFocus?: boolean;
  interfaceMode?: string;
}

/** Whether desktop/cloud-only host chrome (MiniApps, Tours, Cloud onboarding, WindowFrameBar, PlacesRail) should mount. */
export function shouldMountDesktopCloudChrome(input: Pick<PwaShellGateInput, "remotePwa">): boolean {
  return !input.remotePwa;
}

export function shouldMountPlacesRail(input: PwaShellGateInput): boolean {
  return !input.remotePwa && !input.calendarFocus && input.interfaceMode !== "raw";
}

export function shouldMountDesktopRecoveryWrapper(input: Pick<PwaShellGateInput, "remotePwa">): boolean {
  return !input.remotePwa;
}

export function shouldMountAppPreviewPanel(input: Pick<PwaShellGateInput, "remoteClient" | "remotePwa">): boolean {
  return !input.remoteClient && !input.remotePwa;
}
