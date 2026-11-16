export const MOJO_POETRY_URL = "https://mao.hexly.ai/#poem=03";
export const MOJO_POETRY_FRAME_NAME = "openmausbot-mojo-poetry";

/** Electron 43.7.9 reports a new sandboxed iframe as null/empty before its first navigation. Only the local host
 * may start this one fixed Mojo frame; an opaque Mini App's self-navigation has a different initiator. */
export function mojoPoetryHostNavigationAllowed(details, mainFrame, localOrigin) {
  if (!details || details.isMainFrame || details.url !== MOJO_POETRY_URL || !mainFrame) return false;
  try {
    const frame = details.frame;
    return mainFrame.origin === localOrigin && details.initiator === mainFrame
      && frame?.parent === mainFrame && frame.origin === "null" && frame.url === ""
      && frame.name === MOJO_POETRY_FRAME_NAME;
  } catch {
    return false;
  }
}
