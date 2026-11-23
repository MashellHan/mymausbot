import { useEffect, useRef, useState, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/cn";
import { copyText, type CopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { codeUntil } from "@/lib/pairing-time";
import { api, useStore } from "@/state/store";
import type {
  PwaBridgeInviteResponse,
  PwaBridgeRotateSecretResponse,
  PwaBridgeSettingsResponse,
} from "../../../shared/pwa-bridge";
import { Layer } from "../Layer";
import { Select } from "../Select";
import {
  SETTINGS_INPUT,
  SettingRow,
  SettingsField,
  SettingsFoldRow,
  SettingsFormFoot,
  SettingsGroup,
  SettingsRows,
  Switch,
} from "../SettingsPrimitives";
import { DialogTitle } from "./SettingsDialog";

const POLL_INTERVAL_MS = 5_000;

function relayHostLabel(relayUrl: string): string {
  const trimmed = relayUrl.trim();
  if (!trimmed) return t("pwaBridge.settings.notSet");
  try {
    return new URL(trimmed).host || trimmed;
  } catch {
    return trimmed;
  }
}

function bridgeStatusText(data: PwaBridgeSettingsResponse, remoteBlocked: string | null): string {
  if (remoteBlocked) return remoteBlocked;
  if (!data.config.enabled || data.status.state === "off") return t("pwaBridge.status.off");
  if (data.status.state === "connected") return t("pwaBridge.status.connected");
  if (data.status.state === "connecting") return t("pwaBridge.status.connecting");
  if (data.status.lastError) return t("pwaBridge.status.errorDetail", { error: data.status.lastError });
  return t("pwaBridge.status.error");
}

function errorStatus(cause: unknown): number | null {
  if (typeof cause === "object" && cause !== null && "status" in cause && typeof (cause as { status?: unknown }).status === "number") {
    return (cause as { status: number }).status;
  }
  return null;
}

function SecretCopyRow({
  label,
  value,
  dataAttr,
}: {
  label: string;
  value: string;
  dataAttr: string;
}) {
  const [copied, setCopied] = useState<CopyFeedback>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function onCopy() {
    const result = await copyText(value);
    if (result === "empty") return;
    setCopied(result);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied("idle"), 2_000);
  }

  const copyLabel = copied === "copied"
    ? t("pwaBridge.secret.copied")
    : copied === "failed"
      ? t("common.copyFailed")
      : t("pwaBridge.secret.copy");

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium leading-4 text-ink-secondary">{label}</span>
        <button type="button" onClick={() => void onCopy()} className="settings-quiet inline-flex items-center gap-1 cursor-pointer">
          {copied === "copied" ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
          {copyLabel}
        </button>
      </div>
      <code {...{ [dataAttr]: "" }} className="select-all break-all rounded-lg border-[0.5px] border-(--settings-edge) bg-app px-3 py-2 text-[12px] leading-4 text-ink">
        {value}
      </code>
    </div>
  );
}

export function PwaBridgeCard({ remoteBlocked = null }: { remoteBlocked?: string | null }) {
  const { state } = useStore();
  const bots = state.bots ?? [];

  const [data, setData] = useState<PwaBridgeSettingsResponse | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [relayUrl, setRelayUrl] = useState("");
  const [hostId, setHostId] = useState("");
  const [pwaOrigin, setPwaOrigin] = useState("");
  const [defaultBotId, setDefaultBotId] = useState("");
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const [busyAction, setBusyAction] = useState<"toggle" | "save" | "rotate" | "invite" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<{
    bridgeSecret: string;
    bridgeSecretSha256: string;
  } | null>(null);
  const [invite, setInvite] = useState<PwaBridgeInviteResponse | null>(null);
  const [copied, setCopied] = useState<CopyFeedback>("idle");
  const [now, setNow] = useState(() => Date.now());

  function syncFromResponse(next: PwaBridgeSettingsResponse, forceDrafts = false) {
    setData(next);
    if (forceDrafts || !dirtyRef.current) {
      setRelayUrl(next.config.relayUrl);
      setHostId(next.config.hostId);
      setPwaOrigin(next.config.pwaOrigin);
      setDefaultBotId(next.config.defaultBotId ?? "");
      if (forceDrafts) setDirty(false);
    }
  }

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();

    async function load(isInitial: boolean) {
      try {
        const next = await api<PwaBridgeSettingsResponse>("/api/pwa-bridge", {
          signal: controller.signal,
          ...(isInitial ? {} : { background: true }),
        });
        if (!alive) return;
        if (!next?.config || !next?.status) {
          if (isInitial) setUnavailable(true);
          return;
        }
        syncFromResponse(next, isInitial);
      } catch (cause) {
        if (!alive || controller.signal.aborted) return;
        const status = errorStatus(cause);
        if (status === 403 || status === 404) {
          setUnavailable(true);
          return;
        }
        if (isInitial) {
          setUnavailable(true);
        }
      }
    }

    void load(true);
    const pollTimer = setInterval(() => {
      if (!alive) return;
      void load(false);
    }, POLL_INTERVAL_MS);

    return () => {
      alive = false;
      controller.abort();
      clearInterval(pollTimer);
    };
  }, []);

  useEffect(() => {
    if (!invite) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [invite]);

  if (unavailable || !data) return null;

  const busy = busyAction !== null;
  const expired = invite ? invite.expiresAt <= now : false;
  const canPair = data.config.enabled && data.config.hasBridgeSecret && !remoteBlocked;

  async function toggleEnabled(enabled: boolean) {
    if (busy || remoteBlocked) return;
    setBusyAction("toggle");
    setError(null);
    setSavedNotice(null);
    try {
      const payload = enabled && dirty
        ? {
          enabled,
          relayUrl: relayUrl.trim(),
          hostId: hostId.trim(),
          pwaOrigin: pwaOrigin.trim(),
          defaultBotId: defaultBotId.trim() || null,
        }
        : { enabled };
      const next = await api<PwaBridgeSettingsResponse>("/api/pwa-bridge", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      syncFromResponse(next, enabled && dirty);
      if (enabled && !next.config.hasBridgeSecret) {
        setSettingsOpen(true);
      }
      if (!enabled) {
        setInvite(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyAction(null);
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusyAction("save");
    setError(null);
    setSavedNotice(null);
    try {
      const next = await api<PwaBridgeSettingsResponse>("/api/pwa-bridge", {
        method: "PUT",
        body: JSON.stringify({
          relayUrl: relayUrl.trim(),
          hostId: hostId.trim(),
          pwaOrigin: pwaOrigin.trim(),
          defaultBotId: defaultBotId.trim() || null,
        }),
      });
      syncFromResponse(next, true);
      setSavedNotice(t("pwaBridge.settings.saved"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyAction(null);
    }
  }

  async function rotateSecret() {
    if (busy) return;
    setBusyAction("rotate");
    setError(null);
    setSavedNotice(null);
    try {
      const next = await api<PwaBridgeRotateSecretResponse>("/api/pwa-bridge/rotate-secret", {
        method: "POST",
      });
      syncFromResponse(next);
      setRevealedSecret({
        bridgeSecret: next.bridgeSecret,
        bridgeSecretSha256: next.bridgeSecretSha256,
      });
      setSettingsOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyAction(null);
    }
  }

  async function createInvite() {
    if (busy || !canPair || !data) return;
    setBusyAction("invite");
    setError(null);
    setCopied("idle");
    try {
      const next = await api<PwaBridgeInviteResponse>("/api/pwa-bridge/invite", {
        method: "POST",
        body: JSON.stringify({
          defaultBotId: data.config.defaultBotId,
        }),
      });
      setInvite(next);
      setNow(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyAction(null);
    }
  }

  async function copyInviteLink() {
    if (!invite) return;
    const result = await copyText(invite.inviteUrl);
    if (result !== "empty") setCopied(result);
  }

  const pairSubtitle = !data.config.enabled
    ? t("pwaBridge.pair.needEnable")
    : !data.config.hasBridgeSecret
      ? t("pwaBridge.pair.needSecret")
      : t("pwaBridge.pair.ready");

  const hasSavedMissingBot = Boolean(
    defaultBotId && !bots.some((bot) => bot.id === defaultBotId),
  );

  return (
    <>
      {invite && (
        <Layer modal>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("pwaBridge.modal.title")}
            data-settings-look="simple"
            data-pwa-pair-dialog=""
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
            onMouseDown={(event) => event.target === event.currentTarget && setInvite(null)}
          >
            <div className="relative flex max-h-full w-full max-w-[440px] flex-col gap-4 overflow-y-auto rounded-2xl border-[0.5px] border-(--settings-edge) bg-app p-6 shadow-xl">
              <DialogTitle title={t("pwaBridge.modal.title")} onClose={() => setInvite(null)} />
              {expired ? (
                <p className="text-[13px] leading-[18px] text-ink-secondary">{t("pwaBridge.modal.expired")}</p>
              ) : (
                <div className="flex flex-col items-start gap-4">
                  <div data-pwa-pair-qr="" className="self-center rounded-[12px] bg-white p-3 shadow-[inset_0_0_0_0.5px_var(--settings-edge)]">
                    <QRCodeSVG
                      value={invite.inviteUrl}
                      title={t("pwaBridge.modal.title")}
                      size={200}
                      level="M"
                      bgColor="#ffffff"
                      fgColor="#111111"
                    />
                  </div>
                  <p className="text-[14px] leading-5 text-ink">{t("pwaBridge.modal.scan")}</p>
                  <code data-pwa-pair-url="" className="w-full select-all break-all rounded-lg border-[0.5px] border-(--settings-edge) bg-ink/[0.04] p-3 text-[12px] leading-4 text-ink-secondary">
                    {invite.inviteUrl}
                  </code>
                  <div className="text-[12px] leading-4 text-ink-secondary">{codeUntil(invite.expiresAt)}</div>
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                {!expired && (
                  <button type="button" data-pwa-pair-copy="" onClick={() => void copyInviteLink()} className="ui-button mr-auto">
                    {copied === "copied" ? t("pwaBridge.modal.copied") : copied === "failed" ? t("common.copyFailed") : t("pwaBridge.modal.copyLink")}
                  </button>
                )}
                {expired && (
                  <button type="button" onClick={() => void createInvite()} disabled={busy} className="ui-button">
                    {t("pwaBridge.modal.newLink")}
                  </button>
                )}
                <button type="button" className="ui-button ui-button-primary" onClick={() => setInvite(null)}>
                  {t("devices.pair.done")}
                </button>
              </div>
            </div>
          </div>
        </Layer>
      )}

      <SettingsGroup label={t("pwaBridge.title")} block="pwa-bridge">
        <SettingsRows>
          <SettingRow
            title={t("pwaBridge.title")}
            subtitle={bridgeStatusText(data, remoteBlocked)}
            message={error ? <span role="alert" className="text-danger">{error}</span> : undefined}
          >
            <Switch
              id="pwa-bridge-enabled"
              data-pwa-bridge-switch=""
              checked={data.config.enabled}
              disabled={busy || Boolean(remoteBlocked)}
              aria-label={t("pwaBridge.enable")}
              onClick={() => void toggleEnabled(!data.config.enabled)}
            />
          </SettingRow>

          <SettingRow title={t("pwaBridge.pair.title")} subtitle={pairSubtitle}>
            <button
              type="button"
              data-pwa-pair-action=""
              disabled={busy || !canPair}
              onClick={() => void createInvite()}
              className={cn("ui-button ui-button-primary", !canPair && "opacity-40")}
            >
              {busyAction === "invite" ? t("pwaBridge.pair.creating") : t("pwaBridge.pair.button")}
            </button>
          </SettingRow>

          <SettingsFoldRow
            id="pwa-bridge-settings"
            title={t("pwaBridge.settings.title")}
            subtitle={t("pwaBridge.settings.subtitle")}
            value={relayHostLabel(data.config.relayUrl)}
            open={settingsOpen}
            onToggle={() => setSettingsOpen((prev) => !prev)}
          >
            <div className="flex flex-col gap-4">
              <form data-pwa-bridge-form="" onSubmit={(event) => void saveSettings(event)} className="flex flex-col gap-3">
                <SettingsField label={t("pwaBridge.field.relayUrl")}>
                  <input
                    id="pwa-bridge-relay-url"
                    type="url"
                    value={relayUrl}
                    disabled={busy}
                    onChange={(event) => {
                      setRelayUrl(event.target.value);
                      setDirty(true);
                      setSavedNotice(null);
                      setError(null);
                    }}
                    placeholder="https://relay.mxhan.com"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className={SETTINGS_INPUT}
                  />
                </SettingsField>

                <SettingsField label={t("pwaBridge.field.hostId")}>
                  <input
                    id="pwa-bridge-host-id"
                    type="text"
                    value={hostId}
                    disabled={busy}
                    onChange={(event) => {
                      setHostId(event.target.value);
                      setDirty(true);
                      setSavedNotice(null);
                      setError(null);
                    }}
                    placeholder="mac-mini"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className={SETTINGS_INPUT}
                  />
                </SettingsField>

                <SettingsField label={t("pwaBridge.field.pwaOrigin")}>
                  <input
                    id="pwa-bridge-origin"
                    type="url"
                    value={pwaOrigin}
                    disabled={busy}
                    onChange={(event) => {
                      setPwaOrigin(event.target.value);
                      setDirty(true);
                      setSavedNotice(null);
                      setError(null);
                    }}
                    placeholder="https://mausbot.mxhan.com"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className={SETTINGS_INPUT}
                  />
                </SettingsField>

                <SettingsField label={t("pwaBridge.field.defaultBot")}>
                  <Select
                    id="pwa-bridge-default-bot"
                    aria-label={t("pwaBridge.field.defaultBot")}
                    value={defaultBotId}
                    disabled={busy}
                    onChange={(event) => {
                      setDefaultBotId(event.target.value);
                      setDirty(true);
                      setSavedNotice(null);
                      setError(null);
                    }}
                  >
                    <option value="">{t("pwaBridge.field.defaultBotNone")}</option>
                    {hasSavedMissingBot && <option value={defaultBotId}>{defaultBotId}</option>}
                    {bots.map((bot) => (
                      <option key={bot.id} value={bot.id}>
                        {bot.name || bot.id}
                      </option>
                    ))}
                  </Select>
                </SettingsField>

                <SettingsFormFoot status={savedNotice ? <span role="status">{savedNotice}</span> : undefined}>
                  <button type="submit" data-pwa-bridge-save="" disabled={busy || !dirty} className="ui-button ui-button-primary">
                    {busyAction === "save" ? t("pwaBridge.settings.saving") : t("common.save")}
                  </button>
                </SettingsFormFoot>
              </form>

              <div className="flex flex-col gap-3 border-t-[0.5px] border-(--settings-edge) pt-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[14px] leading-5 text-ink">{t("pwaBridge.secret.title")}</span>
                    <span data-pwa-secret-status="" className="text-[13px] leading-[18px] text-ink-secondary">
                      {t(data.config.hasBridgeSecret ? "pwaBridge.secret.configured" : "pwaBridge.secret.missing")}
                    </span>
                  </div>
                  <button
                    type="button"
                    data-pwa-rotate-secret=""
                    disabled={busy}
                    onClick={() => void rotateSecret()}
                    className="ui-button shrink-0"
                  >
                    {t(data.config.hasBridgeSecret ? "pwaBridge.secret.rotate" : "pwaBridge.secret.generate")}
                  </button>
                </div>

                {revealedSecret && (
                  <div data-pwa-secret-revealed="" className="flex flex-col gap-3 rounded-[12px] border-[0.5px] border-(--settings-edge) bg-ink/[0.04] p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[12px] leading-4 text-ink-secondary">{t("pwaBridge.secret.onceNote")}</p>
                      <button type="button" onClick={() => setRevealedSecret(null)} className="settings-quiet shrink-0 cursor-pointer">
                        {t("pwaBridge.secret.hide")}
                      </button>
                    </div>
                    <SecretCopyRow
                      label={t("pwaBridge.secret.hashLabel")}
                      value={revealedSecret.bridgeSecretSha256}
                      dataAttr="data-pwa-secret-hash"
                    />
                    <SecretCopyRow
                      label={t("pwaBridge.secret.valueLabel")}
                      value={revealedSecret.bridgeSecret}
                      dataAttr="data-pwa-secret-value"
                    />
                  </div>
                )}
              </div>
            </div>
          </SettingsFoldRow>
        </SettingsRows>
      </SettingsGroup>
    </>
  );
}
