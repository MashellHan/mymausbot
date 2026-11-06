export function miniAppNativeFrameGuard(): boolean {
  return typeof window !== "undefined" && window.ogb?.app?.blocksOpaqueFrameNavigation === true;
}
