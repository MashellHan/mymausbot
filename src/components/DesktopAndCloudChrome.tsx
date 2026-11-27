import { lazyScreen } from "./lazy-screens";
import type { WelcomeViewer } from "@/lib/onboarding";
import { spotlightsQuiet } from "@/lib/onboarding";

export const LazyMiniAppsHost = lazyScreen("MiniAppsHost", async () => (await import("./mini-apps/MiniAppsHost")).MiniAppsHost);
export const LazyMiniAppDefaultsBootstrap = lazyScreen("MiniAppDefaultsBootstrap", async () => (await import("./mini-apps/MiniAppDefaultsBootstrap")).MiniAppDefaultsBootstrap);
export const LazyWorkspaceBackupRecovery = lazyScreen("WorkspaceBackupRecovery", async () => (await import("./WorkspaceBackupRecovery")).WorkspaceBackupRecovery);
export const LazyPlacesRail = lazyScreen("PlacesRail", async () => (await import("./PlacesRail")).PlacesRail);
export const LazyNewLocalFromMenu = lazyScreen("NewLocalFromMenu", async () => (await import("./PlaceAddSheet")).NewLocalFromMenu);
export const LazyConversationShareDialogs = lazyScreen("ConversationShareDialogs", async () => (await import("./conversation-share/ConversationShareDialogs")).ConversationShareDialogs);
export const LazyForkPanel = lazyScreen("ForkPanel", async () => (await import("./ForkPanel")).ForkPanel);
export const LazyAppPreviewPanel = lazyScreen("AppPreviewPanel", async () => (await import("./published-apps/AppPreviewPanel")).AppPreviewPanel);
export const LazyWebPanelPage = lazyScreen("WebPanelPage", async () => (await import("./WebPanelPage")).WebPanelPage);
export const LazyWindowFrameBar = lazyScreen("WindowFrameBar", async () => (await import("./WindowFrameBar")).WindowFrameBar);
export const LazyWindowCaptionButtons = lazyScreen("WindowCaptionButtons", async () => (await import("./WindowCaptionButtons")).WindowCaptionButtons);
export const LazyCloudWelcome = lazyScreen("CloudWelcome", async () => (await import("./cloud-welcome/CloudWelcome")).CloudWelcome);
export const LazyTeamWelcome = lazyScreen("TeamWelcome", async () => (await import("./TeamWelcome")).TeamWelcome);
export const LazyCloudIntent = lazyScreen("CloudIntent", async () => (await import("./CloudIntent")).CloudIntent);
export const LazyCloudEngineSignIn = lazyScreen("CloudEngineSignIn", async () => (await import("./CloudEngineSignIn")).CloudEngineSignIn);
export const LazyCloudHowTo = lazyScreen("CloudHowTo", async () => (await import("./CloudHowTo")).CloudHowTo);
export const LazyCloudSetup = lazyScreen("CloudSetup", async () => (await import("./CloudSetup")).CloudSetup);
export const LazyWelcomeKeeper = lazyScreen("WelcomeKeeper", async () => (await import("./cloud-welcome/WelcomeKeeper")).WelcomeKeeper);
export const LazyEmptyChatShell = lazyScreen("EmptyChatShell", async () => (await import("./onboarding/EmptyChatShell")).EmptyChatShell);
export const LazyCommandPalette = lazyScreen("CommandPalette", async () => (await import("./CommandPalette")).CommandPalette);
export const LazyLiveCallHost = lazyScreen("LiveCallHost", async () => (await import("./LiveCallHost")).LiveCallHost);

const LazyWelcomeGate = lazyScreen("WelcomeGate", async () => (await import("./onboarding/WelcomeGate")).WelcomeGate);
const LazyMausBotWelcome = lazyScreen("MausBotWelcome", async () => (await import("./MausBotWelcome")).MausBotWelcome);
const LazyCloudTimeZoneSync = lazyScreen("CloudTimeZoneSync", async () => (await import("./CloudTimeZone")).CloudTimeZoneSync);
const LazyGuidedTour = lazyScreen("GuidedTour", async () => (await import("./onboarding/GuidedTour")).GuidedTour);
const LazyFirstConversationTour = lazyScreen("FirstConversationTour", async () => (await import("./onboarding/FirstConversationTour")).FirstConversationTour);

/** Desktop & Cloud onboarding/tour/bootstrap hosts omitted on Remote PWA to shrink the mobile initial bundle. */
export function DesktopAndCloudHosts({ viewer }: { viewer: WelcomeViewer | null }) {
  return (
    <>
      <LazyMiniAppDefaultsBootstrap />
      <LazyWelcomeGate viewer={viewer} />
      <LazyMausBotWelcome viewer={viewer} />
      <LazyCloudTimeZoneSync viewer={viewer} />
      <LazyGuidedTour />
      <LazyLiveCallHost />
      <LazyFirstConversationTour quiet={spotlightsQuiet(viewer)} />
    </>
  );
}
