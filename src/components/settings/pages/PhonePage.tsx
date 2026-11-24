import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Monitor, Smartphone } from "lucide-react";
import { t } from "@/lib/i18n";
import { isComputerSession, lastSeen, serverDeviceTag } from "@/lib/pairing-time";
import { useTailscaleFunnel } from "@/lib/tailscale-funnel";
import { api, useStore } from "@/state/store";
import { PhoneDevicesSection } from "../../PhoneDevicesSection";
import { PlaceMark } from "../../PlacesRail";
import { PlaceBadge } from "../SettingsNav";
import { ServerPairingCard, type PairedDevice } from "../../ServerPairingCard";
import { SettingsGroup, SettingsLinkRow, SettingsRows, SettingsTag } from "../../SettingsPrimitives";
import { useCloudPhoneDestination } from "../../SidebarProfileMenu";
import { PhoneComputerAndAdvanced } from "../PhoneComputerAndAdvanced";
import { PwaBridgeCard } from "../PwaBridgeCard";
import { useOtherPlaces } from "../settings-context";
import { useSettingsShell } from "../settings-shell";

/** This computer's door to pairing with My Cloud: My Cloud opens with its pairing dialog and code. */
function PairWithCloud() {
  const { cloud, bridge } = useCloudPhoneDestination(true);
  const others = useOtherPlaces();
  const [failed, setFailed] = useState(false);
  if (cloud !== "ready" || !bridge) return null;
  const home = others.find((place) => place.kind === "cloud") ?? null;
  const name = home?.name || t("cloudSetup.myCloud");
  return (
    <div data-settings-block="pair-cloud" className="flex flex-col gap-2">
      <SettingsRows icons>
        <button type="button" data-pair-with-cloud="" onClick={() => { setFailed(false); void bridge.connectHomeForPhone().catch(() => setFailed(true)); }}
          className="flex min-h-16 w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-menu-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">
          <span className="flex size-8 shrink-0 items-center justify-center">
            <PlaceMark place={{ kind: "cloud", name, color: home?.color ?? null }} size={24} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[14px] leading-5 text-ink">{t("phone.pair.withPlace", { place: name })}</span>
            <span className="text-[13px] leading-[18px] text-ink-secondary">{t("phone.pair.withPlaceLine", { place: name })}</span>
          </span>
          <ArrowUpRight size={12} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
        </button>
      </SettingsRows>
      {failed && <p role="alert" className="px-4 text-[12px] leading-4 text-danger">{t("cloudPhone.failed")}</p>}
    </div>
  );
}

/** The phones of the person's other places, one row each. A place already offered by the "Pair with My Cloud" callout at
 * the top is left out, so one screen never has two doors to the same place. */
function OtherPlaces() {
  const { ctx } = useSettingsShell();
  const { cloud, bridge } = useCloudPhoneDestination(ctx.here);
  const callout = ctx.here && cloud === "ready" && Boolean(bridge);
  const others = useOtherPlaces("phone").filter((place) => !(callout && place.kind === "cloud"));
  if (!ctx.desktop || ctx.client || others.length === 0) return null;
  return (
    <SettingsGroup label={t("settings.otherPlaces")} block="other-places">
      <SettingsRows icons>
        {others.map((place) => (
          <SettingsLinkRow key={place.key} title={place.name} subtitle={t("phone.otherPlace.line", { place: place.name })}
            leading={<PlaceBadge place={{ kind: place.kind === "computer" ? "computer" : "cloud", name: place.name, color: place.color }} size={24} />}
            external onClick={place.open} data={{ "data-other-place": place.key }} />
        ))}
      </SettingsRows>
    </SettingsGroup>
  );
}

export function PhonePage() {
  const { ctx, place } = useSettingsShell();
  const { state } = useStore();
  const focus = state.appSettingsPhonePairing;
  const funnel = useTailscaleFunnel(!ctx.client && !ctx.cloud);
  const funnelPairs = funnel?.state?.status === "ready" || funnel?.state?.status === "unavailable" && funnel.state.reason === "unverified";
  const showLocalFunnel = ctx.here && Boolean(funnel?.checking || funnelPairs);
  const showPwaBridge = !ctx.cloud && !ctx.client && !ctx.team && (ctx.here || ctx.admin);
  const remoteBlocked = state.config?.managedPolicy?.remoteAccess === false
    ? t("policy.remoteBlocked", { organization: state.config.managedPolicy.organizationName })
    : null;

  const [serverDevices, setServerDevices] = useState<PairedDevice[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refreshServerDevices = useCallback(async () => {
    if (!ctx.here) return;
    try {
      const body = await api<{ sessions?: PairedDevice[]; current?: string | null }>("/api/auth/sessions", { background: true });
      if (Array.isArray(body?.sessions)) {
        setServerDevices(body.sessions);
        setCurrentSessionId(typeof body.current === "string" ? body.current : null);
        setNow(Date.now());
      }
    } catch {
      // Ignore transient/unavailable session list reads in standalone component tests.
    }
  }, [ctx.here]);

  useEffect(() => {
    if (!ctx.here) return;
    void refreshServerDevices();
  }, [ctx.here, refreshServerDevices]);

  const onSessionsChange = useCallback(() => {
    void refreshServerDevices();
  }, [refreshServerDevices]);

  async function removeServerDevice(id: string) {
    try {
      await api(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      await refreshServerDevices();
    } catch {
    }
  }

  const extraPairedRows = ctx.here
    ? serverDevices.map((device) => (
      <li key={`server:${device.id}`} data-paired-device={device.id} className="flex min-h-16 items-center gap-3 px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink/[0.05] text-ink-secondary">
          {isComputerSession(device) ? <Monitor size={18} strokeWidth={1.75} aria-hidden="true" /> : <Smartphone size={18} strokeWidth={1.75} aria-hidden="true" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] leading-5 text-ink">{device.person ?? device.label}</span>
            <SettingsTag>{serverDeviceTag(device)}</SettingsTag>
          </span>
          <span className="truncate text-[13px] leading-[18px] text-ink-secondary">
            {[
              device.person ? device.label : null,
              device.email === device.person ? null : device.email,
              t(device.scopes.includes("admin") ? "remote.serverPairing.scope.admin" : "remote.serverPairing.scope.client"),
              t("remote.serverPairing.seen", { when: lastSeen(device.lastSeenAt, now) }),
              device.id === currentSessionId ? t("remote.serverPairing.thisBrowser") : null,
            ].filter(Boolean).join(" · ")}
          </span>
        </span>
        {device.id === currentSessionId ? null : (
          <button
            type="button"
            onClick={() => void removeServerDevice(device.id)}
            data-danger=""
            className="settings-quiet shrink-0 cursor-pointer"
          >
            {t("phone.devices.remove")}
          </button>
        )}
      </li>
    ))
    : null;

  return <>
    {ctx.here
      ? <PhoneDevicesSection profileEmail={state.config?.profile?.email} focusRequest={!funnel?.checking && !funnelPairs ? focus : 0} simple={!ctx.advanced} placeName={place.name} top={<PairWithCloud />} extraPairedRows={extraPairedRows} extraPairedCount={serverDevices.length} unifiedLayout />
      : <ServerPairingCard funnel={funnel} cloudHome={ctx.cloud} focusRequest={focus} team={state.config?.team?.name} placeName={place.name} simple={!ctx.advanced}
        teamPhoneBlocked={state.config?.managedPolicy?.remoteAccess === false ? t("policy.teamRemoteBlocked", { organization: state.config.managedPolicy.organizationName }) : null} />}
    {showLocalFunnel && <ServerPairingCard focusRequest={funnelPairs ? focus : 0} funnel={funnel} placeName={place.name} simple={!ctx.advanced} hidePairedList onSessionsChange={onSessionsChange} />}
    {showPwaBridge && <PwaBridgeCard remoteBlocked={remoteBlocked} onInviteChange={onSessionsChange} />}
    {ctx.here && <PhoneComputerAndAdvanced profileEmail={state.config?.profile?.email} simple={!ctx.advanced} onSessionsChange={onSessionsChange} />}
    <OtherPlaces />
  </>;
}
