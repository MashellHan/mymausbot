// DOM-free remote PWA transport helpers shared by renderer modules that also typecheck under tsconfig.server.json.
export interface PwaAuthRecord {
  ownerKey: string;
  relayUrl: string;
  token: string;
  deviceId: string;
  environmentId: string;
  sessionId: string;
  serverName: string;
  scopes: string[];
  defaultBotId?: string;
  pairedAt: number;
}

let activeAuth: PwaAuthRecord | null = null;
let macOffline = false;
const macOfflineListeners = new Set<() => void>();

export function isMacOffline(): boolean {
  return macOffline;
}

export function setMacOffline(value: boolean): void {
  if (macOffline === value) return;
  macOffline = value;
  for (const listener of macOfflineListeners) listener();
}

export function subscribeMacOffline(listener: () => void): () => void {
  macOfflineListeners.add(listener);
  return () => macOfflineListeners.delete(listener);
}

export function isElectronDesktop(): boolean {
  const win = (globalThis as { window?: { ogb?: unknown } }).window;
  return Boolean(win?.ogb);
}

export function getPwaAuth(): PwaAuthRecord | null {
  if (isElectronDesktop()) return null;
  return activeAuth;
}

export function setActivePwaAuth(record: PwaAuthRecord | null): void {
  activeAuth = record;
  if (!record) setMacOffline(false);
}

export function isRemotePwaMode(): boolean {
  return getPwaAuth() !== null;
}

export function isRemoteClientSession(): boolean {
  const win = (globalThis as { window?: { ogb?: { remoteClient?: { active?: boolean } } } }).window;
  return win?.ogb?.remoteClient?.active === true || isRemotePwaMode();
}

export function isJsonResponse(res: Pick<Response, "headers">): boolean {
  const contentType = res.headers.get("content-type") ?? "";
  return /^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType);
}

export function isRelayTarget(path: string): boolean {
  const auth = getPwaAuth();
  if (!auth) return false;
  if (path.startsWith("/") && !path.startsWith("//")) return true;
  return path.startsWith(`${auth.relayUrl}/`) || path === auth.relayUrl;
}

export function isRelayMediaPath(path: string | null | undefined): boolean {
  if (!path) return false;
  if (path.startsWith("blob:") || path.startsWith("data:")) return false;
  const auth = getPwaAuth();
  if (!auth) return false;
  if (path.startsWith("/api/")) return true;
  return path.startsWith(`${auth.relayUrl}/api/`);
}

export function remoteUrl(path: string): string {
  const auth = getPwaAuth();
  if (!auth) return path;
  if (path.startsWith("/") && !path.startsWith("//")) {
    return `${auth.relayUrl}${path}`;
  }
  return path;
}

export function remoteFetchInit(init?: RequestInit): RequestInit {
  const auth = getPwaAuth();
  if (!auth) return init ?? {};
  const headers = new Headers(init?.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${auth.token}`);
  }
  return {
    ...init,
    headers,
    credentials: "omit",
  };
}

export function remoteFetch(
  path: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (!isRemotePwaMode() || !isRelayTarget(path)) {
    return init === undefined ? fetchImpl(path) : fetchImpl(path, init);
  }
  return fetchImpl(remoteUrl(path), remoteFetchInit(init)).then((res) => {
    if (res.ok) {
      setMacOffline(false);
    } else if (res.status === 503 && isJsonResponse(res) && typeof res.clone === "function") {
      void res.clone().json().then(
        (body: unknown) => {
          if (body && typeof body === "object" && (body as { code?: unknown }).code === "mac_offline") {
            setMacOffline(true);
          }
        },
        () => {},
      );
    }
    return res;
  });
}
