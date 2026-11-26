import { useEffect, useRef, useState } from "react";
import { AlertCircle, Bell, Loader2, PlusSquare, Share, Smartphone } from "lucide-react";

import { t } from "@/lib/i18n";
import { setFinishedNotifications } from "@/lib/notification-preferences";
import { defaultDeviceLabel } from "@/lib/pwa-config";
import { getPwaAuth } from "@/lib/pwa-transport";
import { useMacOffline } from "@/lib/pwa-connection";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import {
  detectWebPushEnvironment,
  enableWebPush,
  refreshWebPushState,
  sendTestWebPush,
  updateWebPushPreferences,
  useWebPushClientSnapshot,
} from "@/lib/web-push";
import { DEFAULT_WEB_PUSH_PREFERENCES, type WebPushPreferences } from "@/lib/web-push-contract";
import { SLOT, SettingRow, SettingsTag, StatusDot, Switch } from "./SettingsPrimitives";

type TestStatus =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "expired" }
  | { kind: "error"; message: string };

function readOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}

export function WebPushSettingsSection({
  simple = false,
  admin,
  skipInitialRefresh = false,
}: {
  simple?: boolean;
  admin?: boolean;
  skipInitialRefresh?: boolean;
}) {
  void simple;
  const snapshot = useWebPushClientSnapshot();
  const ownerOrAdmin = useOwnerOrAdmin();
  const macOffline = useMacOffline();
  const [browserOnline, setBrowserOnline] = useState<boolean>(readOnline);
  const [env, setEnv] = useState(() => detectWebPushEnvironment());
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: "idle" });
  const pendingPatchRef = useRef<Partial<WebPushPreferences>>({});
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const offline = !browserOnline || macOffline;
  const canSeeSpend = admin ?? (ownerOrAdmin === true || Boolean(getPwaAuth()?.scopes.includes("admin")));

  useEffect(() => {
    if (!skipInitialRefresh) {
      void refreshWebPushState();
    }
    const refreshEnv = () => {
      setBrowserOnline(readOnline());
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const next = detectWebPushEnvironment();
      setEnv(next);
      if (next.availability === "granted" && !offline) {
        void refreshWebPushState();
      }
    };
    const onOffline = () => setBrowserOnline(false);
    const onOnline = () => {
      setBrowserOnline(true);
      void refreshWebPushState();
    };
    window.addEventListener("focus", refreshEnv);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", refreshEnv);
    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      window.removeEventListener("focus", refreshEnv);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", refreshEnv);
    };
  }, [offline, skipInitialRefresh]);

  if (env.availability === "needs-install") {
    return (
      <>
        <SettingRow
          title={t("settings.webPush.needsInstallTitle")}
          subtitle={t("settings.webPush.defaultSubtitle")}
          leading={(
            <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-ink/[0.05] text-ink-secondary">
              <Smartphone size={18} />
            </span>
          )}
        >
          {null}
        </SettingRow>
        <div className="flex flex-col gap-2 px-4 py-3 text-[13px] leading-5 text-ink-secondary" data-web-push-install-steps>
          <div className="flex items-center gap-2.5">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-[12px] font-semibold text-ink">1</span>
            <Share size={15} className="shrink-0 text-accent" aria-hidden="true" />
            <span>{t("settings.webPush.needsInstallStep1")}</span>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-[12px] font-semibold text-ink">2</span>
            <PlusSquare size={15} className="shrink-0 text-accent" aria-hidden="true" />
            <span>{t("settings.webPush.needsInstallStep2")}</span>
          </div>
        </div>
      </>
    );
  }

  if (env.availability === "unsupported") {
    return (
      <SettingRow
        title={t("settings.webPush.title")}
        subtitle={t("settings.webPush.unsupported")}
        leading={(
          <span aria-hidden="true" className={SLOT}>
            <AlertCircle size={18} className="text-ink-tertiary" />
          </span>
        )}
      >
        {null}
      </SettingRow>
    );
  }

  const prefs: WebPushPreferences = snapshot.subscription?.preferences ?? DEFAULT_WEB_PUSH_PREFERENCES;
  const subscribed = Boolean(snapshot.subscription);
  const blocked = env.availability === "denied";
  const effectiveState = blocked
    ? "denied"
    : env.availability === "granted" && subscribed
      ? "granted"
      : "default";

  const handleEnable = async () => {
    setFeedbackError(null);
    setTestStatus({ kind: "idle" });
    const res = await enableWebPush();
    setEnv(detectWebPushEnvironment());
    if (res.ok) {
      setFinishedNotifications(res.subscription.preferences.finished);
      return;
    }
    if (res.reason === "denied") {
      return;
    }
    if (res.reason === "dismissed") {
      setFeedbackError(t("settings.webPush.dismissed"));
      return;
    }
    if (res.reason === "server_disabled") {
      setFeedbackError(t("settings.webPush.serverDisabled"));
      return;
    }
    setFeedbackError(t("settings.webPush.enableError", { error: res.error ?? "Unknown error" }));
  };

  const handleRecheck = () => {
    const next = detectWebPushEnvironment();
    setEnv(next);
    if (next.availability === "granted" && !offline) {
      void refreshWebPushState();
    }
  };

  const flushPreferencePatch = async () => {
    const patch = pendingPatchRef.current;
    pendingPatchRef.current = {};
    flushTimerRef.current = null;
    if (Object.keys(patch).length === 0) return;
    const res = await updateWebPushPreferences(patch);
    if (!res.ok) {
      setFeedbackError(res.expired ? t("settings.webPush.testExpired") : t("settings.webPush.prefError", { error: res.error }));
    }
  };

  const handleTogglePreference = (key: keyof WebPushPreferences) => {
    if (offline || blocked || effectiveState !== "granted") return;
    setFeedbackError(null);
    const nextValue = !prefs[key];
    if (key === "finished") {
      setFinishedNotifications(nextValue);
    }
    pendingPatchRef.current = { ...pendingPatchRef.current, [key]: nextValue };
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => {
      void flushPreferencePatch();
    }, 120);
  };

  const handleTest = async () => {
    if (offline || !prefs.enabled || snapshot.testing) return;
    setTestStatus({ kind: "sending" });
    const res = await sendTestWebPush();
    if (res.ok) {
      setTestStatus({ kind: "sent" });
      return;
    }
    if (res.expired) {
      setTestStatus({ kind: "expired" });
      return;
    }
    setTestStatus({ kind: "error", message: res.error });
  };

  const deviceLabel = snapshot.subscription?.deviceLabel ?? defaultDeviceLabel();
  const statusSubtitle = offline
    ? t("settings.webPush.offline")
    : blocked
      ? t("settings.webPush.blockedSubtitle")
      : effectiveState === "granted"
        ? `${deviceLabel}${prefs.enabled ? ` · ${t("settings.webPush.synced")}` : ""}`
        : t("settings.webPush.defaultSubtitle");

  const statusTone: "success" | "warning" | null = offline || blocked
    ? "warning"
    : effectiveState === "granted"
      ? (prefs.enabled ? "success" : "warning")
      : null;

  const statusTitle = blocked
    ? t("settings.webPush.blockedTitle")
    : effectiveState === "granted"
      ? (prefs.enabled ? t("settings.webPush.enabledStatus") : t("settings.webPush.paused"))
      : t("settings.webPush.title");

  const renderInertReason = offline ? t("settings.webPush.offline") : undefined;
  const rowsInert = offline || blocked || !prefs.enabled;

  return (
    <>
      <SettingRow
        title={statusTitle}
        subtitle={(
          <span className="inline-flex items-center gap-1">
            {statusTone ? <StatusDot tone={statusTone} /> : <Bell size={13} className="mr-1 shrink-0 text-ink-tertiary" aria-hidden="true" />}
            <span>{statusSubtitle}</span>
          </span>
        )}
        message={feedbackError ? <span role="alert" className="text-danger">{feedbackError}</span> : undefined}
      >
        {effectiveState === "granted" ? (
          <Switch
            checked={prefs.enabled}
            disabled={offline}
            aria-label={t("settings.webPush.masterAria")}
            onClick={() => handleTogglePreference("enabled")}
          />
        ) : blocked ? (
          <button type="button" className="ui-button" onClick={handleRecheck}>
            {t("settings.webPush.recheck")}
          </button>
        ) : (
          <button
            type="button"
            className="ui-button ui-button-primary"
            disabled={offline || snapshot.subscribing}
            onClick={() => void handleEnable()}
          >
            {snapshot.subscribing ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                {t("settings.webPush.enabling")}
              </span>
            ) : t("settings.webPush.enable")}
          </button>
        )}
      </SettingRow>

      {(effectiveState === "granted" || effectiveState === "denied") && (
        <>
          <SettingRow
            title={t("settings.webPush.urgentTitle")}
            tag={t("settings.webPush.tagUrgent")}
            subtitle={t("settings.webPush.urgentSubtitle")}
            inert={rowsInert ? (renderInertReason ?? false) : undefined}
          >
            <Switch
              checked={effectiveState === "granted" && prefs.urgent}
              disabled={rowsInert}
              aria-label={t("settings.webPush.urgentTitle")}
              onClick={() => handleTogglePreference("urgent")}
            />
          </SettingRow>

          <SettingRow
            title={t("settings.webPush.finishedTitle")}
            subtitle={t("settings.webPush.finishedSubtitle")}
            inert={rowsInert ? (renderInertReason ?? false) : undefined}
          >
            <Switch
              checked={effectiveState === "granted" && prefs.finished}
              disabled={rowsInert}
              aria-label={t("settings.webPush.finishedTitle")}
              onClick={() => handleTogglePreference("finished")}
            />
          </SettingRow>

          <SettingRow
            title={t("settings.webPush.failuresTitle")}
            subtitle={t("settings.webPush.failuresSubtitle")}
            inert={rowsInert ? (renderInertReason ?? false) : undefined}
          >
            <Switch
              checked={effectiveState === "granted" && prefs.failures}
              disabled={rowsInert}
              aria-label={t("settings.webPush.failuresTitle")}
              onClick={() => handleTogglePreference("failures")}
            />
          </SettingRow>

          <SettingRow
            title={t("settings.webPush.mentionsTitle")}
            subtitle={t("settings.webPush.mentionsSubtitle")}
            inert={rowsInert ? (renderInertReason ?? false) : undefined}
          >
            <Switch
              checked={effectiveState === "granted" && prefs.mentions}
              disabled={rowsInert}
              aria-label={t("settings.webPush.mentionsTitle")}
              onClick={() => handleTogglePreference("mentions")}
            />
          </SettingRow>

          {canSeeSpend && (
            <SettingRow
              title={t("settings.webPush.spendTitle")}
              subtitle={t("settings.webPush.spendSubtitle")}
              inert={rowsInert ? (renderInertReason ?? false) : undefined}
            >
              <Switch
                checked={effectiveState === "granted" && prefs.spend}
                disabled={rowsInert}
                aria-label={t("settings.webPush.spendTitle")}
                onClick={() => handleTogglePreference("spend")}
              />
            </SettingRow>
          )}

          <div className="border-t border-hairline/30 px-4 pt-3 pb-1 text-[12px] font-medium text-ink-secondary">
            {t("settings.webPush.liveSection")}
          </div>

          <SettingRow
            title={t("settings.webPush.liveTitle")}
            tag={t("settings.webPush.tagBeta")}
            subtitle={t("settings.webPush.liveSubtitle")}
            inert={rowsInert ? (renderInertReason ?? false) : undefined}
          >
            <Switch
              checked={effectiveState === "granted" && prefs.liveActivities}
              disabled={rowsInert}
              aria-label={t("settings.webPush.liveTitle")}
              onClick={() => handleTogglePreference("liveActivities")}
            />
          </SettingRow>

          <SettingRow
            title={t("settings.webPush.testTitle")}
            subtitle={t("settings.webPush.testSubtitle")}
            message={
              testStatus.kind === "sent" ? (
                <span role="status" className="text-success">{t("settings.webPush.testSent")}</span>
              ) : testStatus.kind === "expired" ? (
                <span role="alert" className="text-danger">{t("settings.webPush.testExpired")}</span>
              ) : testStatus.kind === "error" ? (
                <span role="alert" className="text-danger">{t("settings.webPush.testError", { error: testStatus.message })}</span>
              ) : undefined
            }
          >
            <button
              type="button"
              className="ui-button"
              disabled={offline || blocked || effectiveState !== "granted" || !prefs.enabled || snapshot.testing}
              onClick={() => void handleTest()}
            >
              {snapshot.testing || testStatus.kind === "sending" ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  {t("settings.webPush.testSending")}
                </span>
              ) : t("settings.webPush.testAction")}
            </button>
          </SettingRow>
        </>
      )}
    </>
  );
}

export { SettingsTag };
