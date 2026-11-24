import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  previewBrowserSignIn, readSessionState, rememberTeamSignIn, takeBrowserSignInFromLocation, takePairingCodeFromLocation, takeInvitedEmailFromLocation,
} from "./lib/session";
import { pairedDestination } from "./lib/phone-pairing";
import { bootstrapBrand, productName } from "./lib/brand";
import { bootstrapPwaConfig, isRemotePwaMode, remoteFetch, type PwaPairingBootResult } from "./lib/pwa-config";
import { t } from "./lib/i18n";
import { loadPageLanguage } from "./lib/language-preference";
import { applySkinChoice, readSkinChoice } from "./lib/skins";
import { applyChatWidth, readChatWidth } from "./lib/chat-width";
import { applyFont, readFont } from "./lib/fonts";
import { applySoftwareRendering } from "./lib/software-rendering";
import { loadTheme, startTheme } from "./lib/theme/runtime";
import { settleInterfaceMode } from "./lib/new-look";
import { BrowserSignInPage } from "./pair/BrowserSignInPage";
import { PairPage, TeamLeftPage } from "./pair/PairPage";
import { TEAM_LEFT_REFUSAL } from "../shared/cloud-hints";
import { HomeScreen, SignedOutAtHome } from "./components/HomeScreen";
import { PageBoundary } from "./components/PageBoundary";
import { preloadPwaBootCache, type PwaBootCache } from "./lib/pwa-cache";
import { registerPwaServiceWorker } from "./lib/pwa-sw";
import { markSessionEnded, endedBeforeReload, forgetEndedSession } from "./lib/session-ended";
import "./styles.css";

// Before first paint; settleInterfaceMode must run before applySkin writes omb-skin.
settleInterfaceMode();
applySkinChoice(readSkinChoice());
applyFont(readFont());
applySoftwareRendering();
applyChatWidth(readChatWidth());
startTheme();
const pageLanguage = loadPageLanguage();

// The app is its own chunk, so these pages don't parse it. Everywhere else its fetch starts now, alongside the session
// read, instead of after it. A failed fetch renders as a throw, so PageBoundary offers a reload.
const PAGES_WITHOUT_THE_APP = new Set(["/home", "/pair", "/desktop-viewer"]);
const loadApp = () => import("./App").catch((error: unknown) => ({ default: (): never => { throw error; } }));
const appPage = PAGES_WITHOUT_THE_APP.has(location.pathname) ? null : loadApp();

/** A team's name as its server describes itself to anyone (the descriptor's label), null when it can't say. */
const teamName = () => remoteFetch("/.well-known/openmausbot/environment").then((res) => res.json() as Promise<{ label?: unknown; capabilities?: { cloudTeam?: unknown } }>)
  .then((descriptor) => (descriptor.capabilities?.cloudTeam === true && typeof descriptor.label === "string" ? descriptor.label : null), () => null);

async function chooseRoot(
  pwaBootPromise: Promise<PwaPairingBootResult>,
  pwaCachePromise: Promise<PwaBootCache | null>,
): Promise<React.ReactNode> {
  const home = window.ogb?.home;
  if (location.pathname === "/home" && home) return <HomeScreen bridge={home} manage={window.ogb?.cloudPlan?.manage} />;
  const pwaBoot = await pwaBootPromise;
  if (pwaBoot.status === "failed") {
    await pageLanguage;
    return <PairPage initialCode={null} reason={pwaBoot.error} />;
  }
  if (pwaBoot.status === "paired" && location.pathname === "/pair") {
    history.replaceState(null, "", pairedDestination(location.search));
  }
  if (location.pathname === "/pair") {
    const signIn = takeBrowserSignInFromLocation();
    if (signIn) {
      const preview = await previewBrowserSignIn(signIn);
      await pageLanguage;
      return preview ? <BrowserSignInPage credential={signIn} owner={preview.owner} team={preview.team} /> : <PairPage initialCode={null} reason={t("pair.browser.signInFailed")} />;
    }
    return <PairPage initialCode={takePairingCodeFromLocation()} initialEmail={takeInvitedEmailFromLocation()} />;
  }
  if (location.pathname !== "/desktop-viewer") {
    const cached = await pwaCachePromise;
    if (cached) {
      forgetEndedSession();
      void readSessionState().then((session) => {
        if (session.kind === "unauthenticated") {
          markSessionEnded();
        } else if (session.kind === "session") {
          rememberTeamSignIn(session.teamSignIn);
        }
      });
      const { default: App } = await (appPage ?? loadApp());
      void loadTheme();
      return <App />;
    }
  }
  const session = await readSessionState();
  if (session.kind === "unauthenticated") {
    await pageLanguage;
    if (session.error === TEAM_LEFT_REFUSAL) return <TeamLeftPage team={await teamName()} />;
    const pair = <PairPage initialCode={null} reason={endedBeforeReload() ? t("pair.sessionEnded") : session.error} />;
    return home ? <SignedOutAtHome bridge={home} fallback={pair} /> : pair;
  }
  if (session.kind === "unreachable" && !home && !isRemotePwaMode() && session.error === "Invalid session response") {
    await pageLanguage;
    return <PairPage initialCode={null} reason={endedBeforeReload() ? t("pair.sessionEnded") : undefined} />;
  }
  forgetEndedSession();
  if (session.kind === "session") rememberTeamSignIn(session.teamSignIn);
  if (session.kind === "loopback" && session.trust === "service") {
    await pageLanguage;
    return <PairPage initialCode={null} reason={t("pair.serviceTrust")} />;
  }
  if (location.pathname === "/desktop-viewer") {
    const { DesktopViewer } = await import("./components/DesktopViewer");
    return <DesktopViewer />;
  }
  const { default: App } = await (appPage ?? loadApp());
  void loadTheme();
  return <App />;
}

// The window is named before the brand file is asked for: the answer only ever renames it.
document.title = productName();
const pwaBoot = window.ogb?.home && location.pathname === "/home"
  ? Promise.resolve<PwaPairingBootResult>({ status: "none" })
  : bootstrapPwaConfig().catch((error: unknown): PwaPairingBootResult => ({
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  }));
const pwaCache = pwaBoot.then((result) =>
  (result.status === "existing" || result.status === "paired") &&
  location.pathname !== "/pair" &&
  location.pathname !== "/desktop-viewer" &&
  !(window.ogb?.home && location.pathname === "/home")
    ? preloadPwaBootCache(result.auth).catch(() => null)
    : null,
);
const brandBoot = pwaCache.then((cache) => {
  if (cache) {
    void bootstrapBrand().catch(() => undefined);
    return;
  }
  return bootstrapBrand().catch(() => undefined);
});

function BootThrow({ error }: { error: unknown }): never {
  throw error instanceof Error ? error : new Error(String(error));
}

function renderBootFallback(rootEl: HTMLElement, error: unknown): void {
  try {
    createRoot(rootEl).render(<StrictMode><PageBoundary><BootThrow error={error} /></PageBoundary></StrictMode>);
  } catch {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("role", "alert");
    wrapper.style.cssText = "min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font-family:system-ui,sans-serif;";
    const box = document.createElement("div");
    const msg = document.createElement("p");
    msg.textContent = error instanceof Error ? error.message : String(error);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Reload";
    btn.style.cssText = "margin-top:12px;padding:8px 14px;border-radius:6px;border:1px solid currentColor;background:transparent;cursor:pointer;";
    btn.onclick = () => location.reload();
    box.append(msg, btn);
    wrapper.append(box);
    rootEl.replaceChildren(wrapper);
  }
}

const rootEl = document.getElementById("root")!;
void Promise.all([brandBoot, chooseRoot(pwaBoot, pwaCache), pageLanguage.catch(() => "en")])
  .then(([, root]) => {
    createRoot(rootEl).render(<StrictMode><PageBoundary>{root}</PageBoundary></StrictMode>);
  })
  .catch((error: unknown) => {
    renderBootFallback(rootEl, error);
  })
  .finally(() => {
    void registerPwaServiceWorker();
  });
