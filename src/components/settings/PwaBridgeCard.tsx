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
import { Select } from "../Select";
import {
  SETTINGS_INPUT,
  SettingRow,
  SettingsField,
  SettingsFoldRow,
  SettingsFormFoot,
  SettingsGroup,
  SettingsRows,
} from "../SettingsPrimitives";
import { SettingsDialog } from "./SettingsDialog";

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

function localizedRelayStatusError(lastError: string): string {
  if (lastError.includes("(4401)") || /authentication rejected/i.test(lastError)) {
    return t("pwaBridge.status.authRejected");
  }
  if (lastError.includes("(4403)") || /host forbidden/i.test(lastError)) {
    return t("pwaBridge.status.hostForbidden");
  }
  if (lastError.includes("(4409)") || /replaced/i.test(lastError)) {
    return t("pwaBridge.status.replaced");
  }
  if (/missing relay/i.test(lastError)) {
    return t("pwaBridge.status.missingConfig");
  }
  if (/invalid relay/i.test(lastError)) {
    return t("pwaBridge.status.invalidRelayUrl");
  }
  if (/heartbeat timeout/i.test(lastError)) {
    return t("pwaBridge.status.timeout");
  }
  return t("pwaBridge.status.error");
}

function bridgeStatusText(data: PwaBridgeSettingsResponse, remoteBlocked: string | null): string {
  if (remoteBlocked) return remoteBlocked;
  if (!data.config.enabled || data.status.state === "off") return t("pwaBridge.status.off");
  if (data.status.state === "connected") return t("pwaBridge.status.connected");
  if (data.status.state === "connecting") return t("pwaBridge.status.connecting");
  if (data.status.lastError) return localizedRelayStatusError(data.status.lastError);
  return t("pwaBridge.status.error");
}

function errorMeta(cause: unknown): {
  status: number | null;
  code: string | null;
  hasErrorKey: boolean;
  message: string;
} {
  if (typeof cause !== "object" || cause === null) {
    return { status: null, code: null, hasErrorKey: false, message: String(cause) };
  }
  const obj = cause as {
    status?: unknown;
    message?: unknown;
    body?: { code?: unknown; errorKey?: unknown };
  };
  return {
    status: typeof obj.status === "number" ? obj.status : null,
    code: typeof obj.body?.code === "string" ? obj.body.code : null,
    hasErrorKey: typeof obj.body?.errorKey === "string",
    message: typeof obj.message === "string" ? obj.message : "",
  };
}

function localizedActionError(
  cause: unknown,
  action: "toggle" | "save" | "rotate" | "invite",
  remoteBlocked: string | null,
): string {
  const { status, code, hasErrorKey, message } = errorMeta(cause);
  if (hasErrorKey && message) return message;
  if (code === "managed_policy") return remoteBlocked ?? t("pwaBridge.error.managedPolicy");
  if (status === 401) return t("pwaBridge.error.sessionEnded");
  if (/\brelayUrl and hostId are required\b/i.test(message)) return t("pwaBridge.error.missingConfig");
  if (/\brelayUrl\b/i.test(message)) return t("pwaBridge.error.invalidRelayUrl");
  if (/\bpwaOrigin\b/i.test(message)) return t("pwaBridge.error.invalidPwaOrigin");
  if (/\bhostId\b/i.test(message)) return t("pwaBridge.error.invalidHostId");
  if (/\bdefaultBotId\b/i.test(message)) return t("pwaBridge.error.invalidDefaultBot");
  if (/before creating a pairing link/i.test(message)) return t("pwaBridge.error.pairNotReady");
  if (action === "rotate") return t("pwaBridge.error.rotateFailed");
  if (action === "invite") return t("pwaBridge.error.inviteFailed");
  return t("pwaBridge.error.saveFailed");
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

export function PwaBridgeCard({
  remoteBlocked = null,
  onInviteChange,
}: {
  remoteBlocked?: string | null;
  onInviteChange?: () => void;
}) {
  const { state } = useStore();
  const bots = state.bots ?? [];

  const [data, setData] = useState<PwaBridgeSettingsResponse | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOpenRef = useRef(false);
  settingsOpenRef.current = settingsOpen;
  const foldToggleEpochRef = useRef(0);

  const [relayUrl, setRelayUrl] = useState("");
  const [hostId, setHostId] = useState("");
  const [pwaOrigin, setPwaOrigin] = useState("");
  const [defaultBotId, setDefaultBotId] = useState("");
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const hasSyncedRef = useRef(false);
  const readSeqRef = useRef(0);
  const writeEpochRef = useRef(0);

  const [busyAction, setBusyAction] = useState<"save" | "rotate" | "invite" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<{
    bridgeSecret: string;
    bridgeSecretSha256: string;
  } | null>(null);
  const [invite, setInvite] = useState<PwaBridgeInviteResponse | null>(null);
  const [copied, setCopied] = useState<CopyFeedback>("idle");
  const [now, setNow] = useState(() => Date.now());
  const pairTriggerRef = useRef<HTMLButtonElement>(null);
  const pairRestoreTargetRef = useRef<HTMLElement | null>(null);
  const wasInviteOpenRef = useRef(false);

  function syncFromResponse(next: PwaBridgeSettingsResponse, forceDrafts = false) {
    setData({ config: next.config, status: next.status });
    hasSyncedRef.current = true;
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
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    function stopPolling() {
      alive = false;
      controller.abort();
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    async function load(isInitial: boolean) {
      const readSeq = ++readSeqRef.current;
      const writeEpoch = writeEpochRef.current;
      try {
        const next = await api<PwaBridgeSettingsResponse>("/api/pwa-bridge", {
          signal: controller.signal,
          ...(isInitial ? {} : { background: true }),
        });
        if (!alive || readSeq !== readSeqRef.current || writeEpoch !== writeEpochRef.current) return;
        if (!next?.config || !next?.status) return;
        syncFromResponse(next, !hasSyncedRef.current);
      } catch (cause) {
        if (!alive || controller.signal.aborted || readSeq !== readSeqRef.current || writeEpoch !== writeEpochRef.current) return;
        const { status } = errorMeta(cause);
        if (status === 403 || status === 404) {
          setUnavailable(true);
          stopPolling();
        }
      }
    }

    void load(true);
    pollTimer = setInterval(() => {
      if (!alive) return;
      void load(false);
    }, POLL_INTERVAL_MS);

    return () => {
      stopPolling();
    };
  }, []);

  useEffect(() => {
    if (invite) {
      wasInviteOpenRef.current = true;
      const timer = setInterval(() => {
        setNow(Date.now());
        if (invite.expiresAt > Date.now()) onInviteChange?.();
      }, 15_000);
      return () => clearInterval(timer);
    }
    if (wasInviteOpenRef.current) {
      wasInviteOpenRef.current = false;
      onInviteChange?.();
      const target = pairRestoreTargetRef.current;
      pairRestoreTargetRef.current = null;
      if (target?.isConnected && !target.hasAttribute("disabled")) {
        target.focus();
      } else if (pairTriggerRef.current?.isConnected) {
        pairTriggerRef.current.focus();
      }
    }
    return undefined;
  }, [invite, onInviteChange]);

  if (unavailable || !data) return null;

  const busy = busyAction !== null;
  const expired = invite ? invite.expiresAt <= now : false;
  const relayConfigured = Boolean(data.config.relayUrl.trim() && data.config.hostId.trim());
  const canPair = data.config.enabled && relayConfigured && data.config.hasBridgeSecret && !remoteBlocked;

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    writeEpochRef.current += 1;
    setBusyAction("save");
    setError(null);
    setSavedNotice(null);
    try {
      const next = await api<PwaBridgeSettingsResponse>("/api/pwa-bridge", {
        method: "PUT",
        body: JSON.stringify({
          enabled: true,
          relayUrl: relayUrl.trim(),
          hostId: hostId.trim(),
          pwaOrigin: pwaOrigin.trim(),
          defaultBotId: defaultBotId.trim() || null,
        }),
      });
      writeEpochRef.current += 1;
      syncFromResponse(next, true);
      setSavedNotice(t("pwaBridge.settings.saved"));
    } catch (cause) {
      setError(localizedActionError(cause, "save", remoteBlocked));
    } finally {
      setBusyAction(null);
    }
  }

  async function rotateSecret() {
    if (busy) return;
    writeEpochRef.current += 1;
    const foldEpoch = foldToggleEpochRef.current;
    setBusyAction("rotate");
    setError(null);
    setSavedNotice(null);
    try {
      const next = await api<PwaBridgeRotateSecretResponse>("/api/pwa-bridge/rotate-secret", {
        method: "POST",
      });
      writeEpochRef.current += 1;
      syncFromResponse(next);
      if (settingsOpenRef.current && foldEpoch === foldToggleEpochRef.current) {
        setRevealedSecret({
          bridgeSecret: next.bridgeSecret,
          bridgeSecretSha256: next.bridgeSecretSha256,
        });
        setSettingsOpen(true);
      }
    } catch (cause) {
      setError(localizedActionError(cause, "rotate", remoteBlocked));
    } finally {
      setBusyAction(null);
    }
  }

  async function createInvite() {
    if (busy || !canPair || !data) return;
    if (!invite) {
      pairRestoreTargetRef.current =
        document.activeElement instanceof HTMLElement && document.activeElement !== document.body
          ? document.activeElement
          : pairTriggerRef.current;
    }
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
      if (!invite) pairRestoreTargetRef.current = null;
      setError(localizedActionError(cause, "invite", remoteBlocked));
    } finally {
      setBusyAction(null);
    }
  }

  async function copyInviteLink() {
    if (!invite) return;
    const result = await copyText(invite.inviteUrl);
    if (result !== "empty") setCopied(result);
  }

  const pairSubtitle = remoteBlocked
    ? remoteBlocked
    : !relayConfigured
      ? t("pwaBridge.status.missingConfig")
      : !data.config.hasBridgeSecret
        ? t("pwaBridge.pair.needSecret")
        : !data.config.enabled
          ? t("pwaBridge.pair.needEnable")
          : t("pwaBridge.pair.ready");

  const relaySubtitle = !relayConfigured || !data.config.hasBridgeSecret
    ? t("pwaBridge.status.missingConfig")
    : data.status.state === "error" || data.status.state === "connecting" || data.status.state === "connected" || remoteBlocked
      ? bridgeStatusText(data, remoteBlocked)
      : t("pwaBridge.settings.subtitle");

  const hasSavedMissingBot = Boolean(
    defaultBotId && !bots.some((bot) => bot.id === defaultBotId),
  );

  return (
    <>
      {invite && (
        <SettingsDialog
          title={t("pwaBridge.modal.title")}
          onClose={() => setInvite(null)}
          footer={(
            <>
              {!expired && (
                <button
                  type="button"
                  data-autofocus=""
                  data-pwa-pair-copy=""
                  onClick={() => void copyInviteLink()}
                  className="ui-button mr-auto"
                >
                  {copied === "copied" ? t("pwaBridge.modal.copied") : copied === "failed" ? t("common.copyFailed") : t("pwaBridge.modal.copyLink")}
                </button>
              )}
              {expired && (
                <button
                  type="button"
                  data-autofocus=""
                  onClick={() => void createInvite()}
                  disabled={busy}
                  className="ui-button"
                >
                  {t("pwaBridge.modal.newLink")}
                </button>
              )}
              <button type="button" className="ui-button ui-button-primary" onClick={() => setInvite(null)}>
                {t("devices.pair.done")}
              </button>
            </>
          )}
        >
          {expired ? (
            <p className="text-[13px] leading-[18px] text-ink-secondary">{t("pwaBridge.modal.expired")}</p>
          ) : (
            <div data-pwa-pair-dialog="" className="flex flex-col items-start gap-4">
              <div data-pwa-pair-qr="" className="self-center rounded-[12px] bg-white p-3 shadow-[inset_0_0_0_0.5px_var(--settings-edge)]">
                <QRCodeSVG
                  value={invite.inviteUrl}
                  title={t("pwaBridge.modal.title")}
                  size={200}
                  marginSize={4}
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
        </SettingsDialog>
      )}

      <SettingsGroup label={t("pwaBridge.sectionTitle")} block="pwa-bridge">
        <SettingsRows>
          <SettingsFoldRow
            id="pwa-bridge-settings"
            title={t("pwaBridge.settings.title")}
            subtitle={relaySubtitle}
            value={relayHostLabel(data.config.relayUrl)}
            open={settingsOpen}
            onToggle={() => {
              foldToggleEpochRef.current += 1;
              setSettingsOpen((prev) => {
                if (prev) setRevealedSecret(null);
                return !prev;
              });
            }}
          >
            <form data-pwa-bridge-form="" onSubmit={(event) => void saveSettings(event)} className="flex flex-col">
              <div className="flex flex-col gap-3 px-4 pt-3 pb-1">
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
              </div>

              <SettingsFormFoot status={savedNotice ? <span role="status">{savedNotice}</span> : undefined}>
                <button type="submit" data-pwa-bridge-save="" disabled={busy || !dirty} className="ui-button ui-button-primary">
                  {busyAction === "save" ? t("pwaBridge.settings.saving") : t("common.save")}
                </button>
              </SettingsFormFoot>
            </form>

            <div data-pwa-secret-row="" className="flex flex-col gap-3 px-4 py-3">
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
          </SettingsFoldRow>

          <SettingRow
            title={t("pwaBridge.pair.title")}
            subtitle={pairSubtitle}
            message={error ? <span role="alert" className="text-danger">{error}</span> : undefined}
          >
            <button
              ref={pairTriggerRef}
              type="button"
              data-pwa-pair-action=""
              disabled={busy || !canPair}
              onClick={() => void createInvite()}
              className={cn("ui-button ui-button-primary", !canPair && "opacity-40")}
            >
              {busyAction === "invite" ? t("pwaBridge.pair.creating") : t("pwaBridge.pair.button")}
            </button>
          </SettingRow>
        </SettingsRows>
      </SettingsGroup>
    </>
  );
}
