/** A named partition without `persist:` keeps cookies and browser storage in this App process only. */
export const SESSION_CREDENTIAL_PARTITION = "openmausbot-session-credentials";

export function createAppBrowserSession(electronSession, credentialMode) {
  let selected = null;
  return () => selected ??= credentialMode === "session"
    ? electronSession.fromPartition(SESSION_CREDENTIAL_PARTITION, { cache: false })
    : electronSession.defaultSession;
}
