export const DAILY_X_URL = "https://mxhan.com/x/";
export const DAILY_X_FRAME_NAME = "openmausbot-daily-x";

export function dailyXPageAllowed(raw) {
  try {
    const url = new URL(raw);
    return url.origin === "https://mxhan.com" && !url.username && !url.password && !url.search && url.hash.length <= 256
      && (url.pathname === "/x/" || /^\/x\/\d{8}\/(?:\d{15,20}\/)?$/.test(url.pathname)
        || /^\/x\/topics\/[a-z0-9-]+\/(?:[a-z0-9-]+\/)?$/.test(url.pathname));
  } catch {
    return false;
  }
}

/** A named direct child of the local desktop may navigate only among XReport's canonical reading pages. */
export function dailyXFrameNavigation(details, mainFrame, localOrigin) {
  if (!details || details.isMainFrame) return null;
  let frame;
  try {
    frame = details.frame;
    if (frame?.name !== DAILY_X_FRAME_NAME) return null;
    if (!mainFrame || mainFrame.origin !== localOrigin || frame.parent !== mainFrame || !dailyXPageAllowed(details.url)) return false;
    if (frame.origin === "https://mxhan.com") return dailyXPageAllowed(frame.url);
    return frame.origin === "null" && frame.url === "" && details.initiator === mainFrame;
  } catch {
    return false;
  }
}
