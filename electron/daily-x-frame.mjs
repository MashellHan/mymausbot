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

/** Electron 43.7.9 keeps frameTreeNodeId stable for a frame's lifetime, including redirects and name changes. */
export function createDailyXFrameNavigation() {
  const authorized = new Set();
  return (details, mainFrame, localOrigin, initial = false) => {
    if (!details || details.isMainFrame) return null;
    try {
      const frame = details.frame;
      if (!frame) return false;
      const id = frame.frameTreeNodeId;
      const known = authorized.has(id);
      const children = mainFrame?.frames;
      if (!Number.isSafeInteger(id) || id < 0 || !Array.isArray(children)) return known || frame.name === DAILY_X_FRAME_NAME ? false : null;
      const present = children.some((child) => child.frameTreeNodeId === id);
      for (const saved of authorized) if (!children.some((child) => child.frameTreeNodeId === saved)) authorized.delete(saved);
      if (!present) return known || frame.name === DAILY_X_FRAME_NAME ? false : null;
      if (!known && frame.name !== DAILY_X_FRAME_NAME) return null;
      if (mainFrame.origin !== localOrigin || frame.parent !== mainFrame || !dailyXPageAllowed(details.url)) return false;
      if (known) return frame.origin === "https://mxhan.com" ? dailyXPageAllowed(frame.url)
        : frame.origin === "null" && frame.url === "";
      if (!initial || frame.origin !== "null" || frame.url !== "" || details.initiator !== mainFrame) return false;
      authorized.add(id);
      return true;
    } catch {
      return false;
    }
  };
}

export function installDailyXFrameGuards(webContents, { localOrigin, redirectFallback, frameFallback }) {
  const decide = createDailyXFrameNavigation();
  webContents.on("will-redirect", (details, url) => {
    const allowed = decide(details, webContents.mainFrame, localOrigin());
    if (allowed === null) redirectFallback(details, url);
    else if (!allowed) details.preventDefault();
  });
  webContents.on("will-frame-navigate", (details) => {
    if (details.isMainFrame) return;
    const allowed = decide(details, webContents.mainFrame, localOrigin(), true);
    if (allowed === null) frameFallback(details);
    else if (!allowed) details.preventDefault();
  });
}
