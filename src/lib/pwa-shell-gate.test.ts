import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  shouldMountAppPreviewPanel,
  shouldMountDesktopCloudChrome,
  shouldMountDesktopRecoveryWrapper,
  shouldMountPlacesRail,
} from "./pwa-shell-gate";

const ROOT = resolve(__dirname, "../..");

describe("pwa-shell-gate and App.tsx static dependency split", () => {
  it("gates desktop/cloud chrome off on Remote PWA and keeps it on for desktop/local/cloud web", () => {
    expect(shouldMountDesktopCloudChrome({ remotePwa: true })).toBe(false);
    expect(shouldMountDesktopCloudChrome({ remotePwa: false })).toBe(true);

    expect(shouldMountDesktopRecoveryWrapper({ remotePwa: true })).toBe(false);
    expect(shouldMountDesktopRecoveryWrapper({ remotePwa: false })).toBe(true);

    expect(shouldMountPlacesRail({ remotePwa: true, remoteClient: true, calendarFocus: false, interfaceMode: "simple" })).toBe(false);
    expect(shouldMountPlacesRail({ remotePwa: false, remoteClient: false, calendarFocus: false, interfaceMode: "simple" })).toBe(true);
    expect(shouldMountPlacesRail({ remotePwa: false, remoteClient: false, calendarFocus: true, interfaceMode: "simple" })).toBe(false);
    expect(shouldMountPlacesRail({ remotePwa: false, remoteClient: false, calendarFocus: false, interfaceMode: "raw" })).toBe(false);

    expect(shouldMountAppPreviewPanel({ remotePwa: true, remoteClient: true })).toBe(false);
    expect(shouldMountAppPreviewPanel({ remotePwa: false, remoteClient: true })).toBe(false);
    expect(shouldMountAppPreviewPanel({ remotePwa: false, remoteClient: false })).toBe(true);
  });

  it("ensures src/App.tsx no longer statically imports heavy desktop/cloud-only trees", () => {
    const appSource = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
    const forbiddenStaticImports = [
      "@/components/mini-apps/MiniAppsHost",
      "@/components/mini-apps/MiniAppDefaultsBootstrap",
      "@/components/WorkspaceBackupRecovery",
      "@/components/PlacesRail",
      "@/components/PlaceAddSheet",
      "@/components/ForkPanel",
      "@/components/conversation-share/ConversationShareDialogs",
      "@/components/onboarding/GuidedTour",
      "@/components/onboarding/FirstConversationTour",
      "@/components/onboarding/EmptyChatShell",
      "@/components/cloud-welcome/CloudWelcome",
      "@/components/cloud-welcome/WelcomeKeeper",
      "@/components/CloudSetup",
      "@/components/CloudHowTo",
      "@/components/CloudIntent",
      "@/components/CloudEngineSignIn",
      "@/components/TeamWelcome",
      "@/components/MausBotWelcome",
      "@/components/CloudTimeZone",
      "@/components/LiveCallHost",
      "@/components/published-apps/AppPreviewPanel",
      "@/components/WebPanelPage",
      "@/components/WindowCaptionButtons",
      "@/components/WindowFrameBar",
      "@/components/CommandPalette",
    ];
    for (const specifier of forbiddenStaticImports) {
      expect(appSource).not.toContain(`"${specifier}"`);
    }
  });
});
