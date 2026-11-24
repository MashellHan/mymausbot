import { isElectronDesktop } from "./pwa-transport";

export interface PwaSwEnvironment {
  protocol?: string;
  isDev?: boolean;
  isElectron?: boolean;
  serviceWorker?: Pick<ServiceWorkerContainer, "register"> | null;
}

export function shouldRegisterPwaServiceWorker(env: PwaSwEnvironment = {}): boolean {
  const isElectron = env.isElectron ?? isElectronDesktop();
  if (isElectron) return false;
  const isDev = env.isDev ?? Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  if (isDev) return false;
  const protocol = env.protocol ?? (typeof location !== "undefined" ? location.protocol : "");
  if (protocol !== "https:") return false;
  const sw = env.serviceWorker === undefined
    ? (typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : null)
    : env.serviceWorker;
  return Boolean(sw && typeof sw.register === "function");
}

export async function registerPwaServiceWorker(
  env: PwaSwEnvironment = {},
): Promise<ServiceWorkerRegistration | null> {
  if (!shouldRegisterPwaServiceWorker(env)) return null;
  const sw = env.serviceWorker ?? navigator.serviceWorker;
  try {
    const registration = await sw.register("/sw.js", { scope: "/", updateViaCache: "none" });
    if (registration && typeof registration.update === "function") {
      void registration.update().catch(() => undefined);
    }
    return registration;
  } catch {
    return null;
  }
}
