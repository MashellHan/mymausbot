export const BANNER_DISMISS_DRAG_PX = 32;
export const BANNER_DISMISS_VELOCITY_PX_MS = -0.35;
export const BANNER_MAX_PULL_DOWN_PX = 12;

export type ConnectionNoticeKind = "offline" | "mac-offline" | "reconnecting" | "connecting" | null;

export interface TopChromeStackInput {
  connected: boolean;
  cachedHydrated: boolean;
  online: boolean;
  macOffline: boolean;
  hasWaitingActivity: boolean;
}

export interface TopChromeStackMode {
  suppressWorkingActivity: boolean;
  compactActivityBar: boolean;
  hideActivityBar: boolean;
}

/**
 * Coordinates `LiveConnectionStrip` and `PwaLiveActivityBar` on small phones so disconnected/offline
 * states never stack redundant working spinners over the connection banner.
 */
export function resolveMobileTopChromeMode(input: TopChromeStackInput): TopChromeStackMode {
  const disconnectedNotice = !input.online || (input.macOffline && !input.connected);
  if (disconnectedNotice) {
    return {
      suppressWorkingActivity: true,
      compactActivityBar: true,
      hideActivityBar: !input.hasWaitingActivity,
    };
  }
  if (!input.connected && input.cachedHydrated) {
    return {
      suppressWorkingActivity: true,
      compactActivityBar: true,
      hideActivityBar: !input.hasWaitingActivity,
    };
  }
  return {
    suppressWorkingActivity: false,
    compactActivityBar: false,
    hideActivityBar: false,
  };
}

export interface BannerSwipeState {
  offsetY: number;
  opacity: number;
  decision: "dismiss" | "snap-back";
}

export function computeBannerSwipeState(dy: number, velocityY = 0): BannerSwipeState {
  if (dy < 0) {
    const clamped = Math.max(-120, dy);
    const opacity = Math.round(Math.max(0.2, 1 + clamped / 96) * 100) / 100;
    const dismiss = dy <= -BANNER_DISMISS_DRAG_PX || velocityY <= BANNER_DISMISS_VELOCITY_PX_MS;
    return {
      offsetY: Math.round(clamped),
      opacity,
      decision: dismiss ? "dismiss" : "snap-back",
    };
  }
  const damped = Math.min(BANNER_MAX_PULL_DOWN_PX, Math.round(dy * 0.2));
  return {
    offsetY: damped,
    opacity: 1,
    decision: "snap-back",
  };
}
