// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { resetWebPushClientStateForTests } from "@/lib/web-push";
import { SettingsLook } from "./SettingsPrimitives";
import { WebPushSettingsSection } from "./WebPushSettingsSection";

const fixture = vi.hoisted(() => ({
  ownerOrAdmin: true as boolean | null,
  macOffline: false,
}));

vi.mock("@/lib/use-owner-or-admin", () => ({
  useOwnerOrAdmin: () => fixture.ownerOrAdmin,
}));

vi.mock("@/lib/pwa-connection", () => ({
  useMacOffline: () => fixture.macOffline,
}));

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  resetWebPushClientStateForTests();
  try {
    localStorage.clear();
  } catch {}
  fixture.ownerOrAdmin = true;
  fixture.macOffline = false;
  setLocale("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderSection(props: { admin?: boolean; skipInitialRefresh?: boolean } = {}) {
  await act(async () => {
    root!.render(
      createElement(
        SettingsLook.Provider,
        { value: true },
        createElement(WebPushSettingsSection, { skipInitialRefresh: true, ...props }),
      ),
    );
  });
}

describe("WebPushSettingsSection", () => {
  it("shows Safari Add-to-Home-Screen steps on non-standalone iOS browsers", async () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
      maxTouchPoints: 5,
      onLine: true,
    });
    await renderSection();
    expect(container.textContent).toContain("Add to Home Screen first");
    expect(container.querySelector("[data-web-push-install-steps]")).not.toBeNull();
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(0);
  });

  it("shows honest unsupported state when Web Push APIs are absent on desktop/non-iOS browsers", async () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      onLine: true,
    });
    await renderSection();
    expect(container.textContent).toContain("Web Push is not supported in this browser.");
  });

  it("enables Web Push, renders granular toggles (hiding spend for non-admin), and sends test push", async () => {
    const subscriptionObj = {
      endpoint: "https://web.push.apple.com/sub-1",
      toJSON: () => ({
        endpoint: "https://web.push.apple.com/sub-1",
        keys: { p256dh: "p256dh-key", auth: "auth-key" },
      }),
    };
    const registration = {
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(null),
        subscribe: vi.fn().mockResolvedValue(subscriptionObj),
      },
    };
    let perm: NotificationPermission = "default";
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("PushManager", function PushManager() {});
    vi.stubGlobal("Notification", {
      get permission() {
        return perm;
      },
      requestPermission: vi.fn(async () => {
        perm = "granted";
        return perm;
      }),
    });
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      standalone: true,
      onLine: true,
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue(registration),
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/push/web/vapid-key")) {
        return new Response(JSON.stringify({ enabled: true, publicKey: "AQAB" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/push/web/subscription")) {
        return new Response(
          JSON.stringify({
            subscription: {
              endpoint: "https://web.push.apple.com/sub-1",
              endpointOrigin: "https://web.push.apple.com",
              deviceLabel: "Safari on iPhone",
              preferences: {
                enabled: true,
                urgent: true,
                finished: true,
                failures: true,
                mentions: true,
                spend: true,
                liveActivities: false,
              },
              createdAt: 1,
              updatedAt: 2,
              hasKeys: true,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true, sent: 1, pruned: 0, total: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    fixture.ownerOrAdmin = false;
    await renderSection({ admin: false });
    const enableBtn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Enable"))!;
    expect(enableBtn).toBeDefined();

    await act(async () => {
      enableBtn.click();
    });

    expect(container.textContent).toContain("Notifications on");
    expect(container.textContent).toContain("Urgent requests");
    expect(container.textContent).toContain("Lock-screen task progress");
    expect(container.textContent).not.toContain("Monthly spend alerts");

    const sendBtn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Send test"))!;
    await act(async () => {
      sendBtn.click();
    });
    expect(container.textContent).toContain("Test sent");

    await renderSection({ admin: true });
    expect(container.textContent).toContain("Monthly spend alerts");
  });

  it("shows blocked instructions and inert switches when system notification permission is denied", async () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("PushManager", function PushManager() {});
    vi.stubGlobal("Notification", {
      permission: "denied",
      requestPermission: vi.fn(),
    });
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      standalone: true,
      onLine: true,
      serviceWorker: {
        getRegistration: vi.fn(),
      },
    });
    await renderSection({ admin: true });
    expect(container.textContent).toContain("Notifications blocked by system");
    expect(container.querySelectorAll('[data-settings-inert=""]').length).toBeGreaterThanOrEqual(5);
  });
});
