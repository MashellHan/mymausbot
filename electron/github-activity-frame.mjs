export const GITHUB_ACTIVITY_URL = "https://mxhan.com/github/";
export const GITHUB_ACTIVITY_FRAME_NAME = "openmausbot-github-activity";
const GITHUB_ACTIVITY_ORIGIN = "https://mxhan.com";
const GITHUB_MEDIA_PATH = /^\/github\/media\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:png|jpe?g|webp|gif|avif|mp4|webm)$/i;

function isValidCompactDate(yyyymmdd) {
  if (!/^\d{8}$/.test(yyyymmdd)) return false;
  const iso = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso;
}

function isSafeGithubSegment(segment) {
  return /^[a-z0-9_.-]{1,100}$/.test(segment) && segment !== "." && segment !== "..";
}

function hasUnsafeRawPathChars(raw) {
  if (typeof raw !== "string" || raw.length > 2048 || !raw.startsWith("https://mxhan.com/")) return true;
  if (raw.includes("?") || raw.includes("%") || raw.includes("\\")) return true;
  const withoutHash = raw.split("#", 1)[0];
  const rest = withoutHash.slice("https://".length);
  return rest.includes("//") || /\/\.(?:\.|)(?:\/|$)/.test(rest);
}

export function githubActivityPageAllowed(raw) {
  if (hasUnsafeRawPathChars(raw)) return false;
  try {
    const url = new URL(raw);
    if (url.origin !== GITHUB_ACTIVITY_ORIGIN || url.port || url.username || url.password || url.search || url.hash.length > 256) {
      return false;
    }
    if (url.pathname === "/github/" || url.pathname === "/github/demo/univer-orders/" || url.pathname === "/github/demo/pandera-orders/") return true;
    const editionMatch = /^\/github\/(\d{8})\/$/.exec(url.pathname);
    if (editionMatch) return isValidCompactDate(editionMatch[1]);
    const repoMatch = /^\/github\/(\d{8})\/([^/]+)\/([^/]+)\/$/.exec(url.pathname);
    if (repoMatch) {
      return isValidCompactDate(repoMatch[1]) && isSafeGithubSegment(repoMatch[2]) && isSafeGithubSegment(repoMatch[3]);
    }
    return false;
  } catch {
    return false;
  }
}

export function githubMediaUrlAllowed(raw) {
  if (hasUnsafeRawPathChars(raw)) return false;
  try {
    const url = new URL(raw);
    if (url.origin !== GITHUB_ACTIVITY_ORIGIN || url.port || url.username || url.password || url.search || url.hash) {
      return false;
    }
    return GITHUB_MEDIA_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

/** Electron 43.7.9 keeps frameTreeNodeId stable for a frame's lifetime, including redirects and name changes. */
export function createGithubActivityFrameNavigation() {
  const authorized = new Set();
  return (details, mainFrame, localOrigin, initial = false) => {
    if (!details || details.isMainFrame) return null;
    try {
      const frame = details.frame;
      if (!frame) return false;
      const id = frame.frameTreeNodeId;
      const known = authorized.has(id);
      const children = mainFrame?.frames;
      if (!Number.isSafeInteger(id) || id < 0 || !Array.isArray(children)) return known || frame.name === GITHUB_ACTIVITY_FRAME_NAME ? false : null;
      const present = children.some((child) => child.frameTreeNodeId === id);
      for (const saved of authorized) if (!children.some((child) => child.frameTreeNodeId === saved)) authorized.delete(saved);
      if (!present) return known || frame.name === GITHUB_ACTIVITY_FRAME_NAME ? false : null;
      if (!known && frame.name !== GITHUB_ACTIVITY_FRAME_NAME) return null;
      if (mainFrame.origin !== localOrigin || frame.parent !== mainFrame || !githubActivityPageAllowed(details.url)) return false;
      if (known) return frame.origin === GITHUB_ACTIVITY_ORIGIN ? githubActivityPageAllowed(frame.url)
        : frame.origin === "null" && frame.url === "";
      if (!initial || frame.origin !== "null" || frame.url !== "" || details.initiator !== mainFrame) return false;
      authorized.add(id);
      return true;
    } catch {
      return false;
    }
  };
}

export function createGithubActivityFrameGuards({ webContents, localOrigin, redirectFallback, frameFallback }) {
  const decide = createGithubActivityFrameNavigation();
  return {
    redirectFallback(details, url) {
      const allowed = decide(details, webContents.mainFrame, localOrigin());
      if (allowed === null) redirectFallback(details, url);
      else if (!allowed) details.preventDefault();
    },
    frameFallback(details, url) {
      const allowed = decide(details, webContents.mainFrame, localOrigin(), url === undefined);
      if (allowed === null) frameFallback(details, url);
      else if (!allowed) details.preventDefault();
    },
  };
}
