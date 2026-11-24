import { useState } from "react";
import { t } from "@/lib/i18n";
import { productName } from "@/lib/brand";
import { deriveTailscalePairingStatus } from "@/lib/phone-setup";
import { useStore } from "@/state/store";
import {
  companionBridge,
  usePhoneSetupController,
  type CompanionBridge,
  type CompanionRoute,
  type CompanionState,
  type PhoneSetupController,
} from "../PhoneSetupFlow";
import { companionAccountActionError } from "../PhoneSetupFlow";
import { PhonesList } from "../PhonesList";
import { RemoteAccessCheckRow } from "../RemoteAccessCheck";
import { TailnetComputers } from "../TailnetComputers";
import { LearnMore, SettingRow, SettingsDisclosureRow, SettingsFoldRow, Switch } from "../SettingsPrimitives";

const TAILSCALE_HELP = "https://tailscale.com/kb/1017/install";

const ROUTE_TEXT = {
  wifi: { name: "devices.route.wifi", detail: "devices.route.wifiDetail" },
  relay: { name: "devices.route.relay", detail: "devices.route.relayDetail" },
} as const;

const ROUTE_LINE = { wifi: "phone.reach.wifiLine", relay: "phone.reach.anywhereLine" } as const;

function endpointHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function companionRoutesOn(state: Pick<CompanionState, "enabled" | "routes">): boolean {
  return state.routes ? Object.values(state.routes).some((route) => route.on) : state.enabled;
}

function setCompanionTailscale(companion: CompanionBridge, on: boolean): Promise<CompanionState> {
  if (companion.setTailscale) return companion.setTailscale(on);
  return on ? companion.refreshTailscale() : companion.state();
}

function setRoute(companion: CompanionBridge, route: CompanionRoute, on: boolean): Promise<CompanionState> {
  if (route === "tailscale") return setCompanionTailscale(companion, on);
  return companion.setRoute?.(route, on) ?? (on ? companion.start([route]) : companion.state());
}

function routeStateText(route: { on: boolean; since: number | null } | undefined, paired: number): string {
  if (!route?.on) return t("devices.route.off");
  if (paired === 0) return t("devices.route.waiting");
  return route.since
    ? t("devices.route.onSince", { date: new Date(route.since).toLocaleDateString(undefined, { month: "short", day: "numeric" }) })
    : t("devices.route.on");
}

function showHttpsAddressRow(
  state: Pick<CompanionState, "routes">,
  account: { endpoint?: string | null } | null,
  bridge: Pick<CompanionBridge, "renewPairing"> | null,
): boolean {
  return state.routes?.https?.on === true || Boolean(account?.endpoint) || typeof bridge?.renewPairing !== "function";
}

function AdvancedRouteRow({
  c,
  state,
  route,
  blocked,
}: {
  c: PhoneSetupController;
  state: CompanionState;
  route: "wifi" | "relay";
  blocked: string | null;
}) {
  const current = state.routes?.[route];
  const needsSignIn = route === "relay" && c.account?.available !== false && c.account?.status !== "ready";
  if (needsSignIn && !current?.on && !blocked) {
    return (
      <SettingRow
        title={t(ROUTE_TEXT[route].name, { app: productName() })}
        subtitle={t(ROUTE_LINE[route])}
        inertText={t("phone.pair.needsSignInLine", { app: productName() })}
        inert={t("phone.pair.needsSignInLine", { app: productName() })}
      >
        <span data-route-row={route} className="contents">
          <Switch checked={false} aria-label={t(ROUTE_TEXT[route].name, { app: productName() })} tabIndex={-1} />
        </span>
      </SettingRow>
    );
  }
  const inert = Boolean(blocked) && !current?.on;
  return (
    <SettingRow
      title={t(ROUTE_TEXT[route].name, { app: productName() })}
      subtitle={t(ROUTE_LINE[route])}
      message={current?.on && state.devices.length === 0 ? routeStateText(current, 0) : inert ? blocked : undefined}
    >
      <span data-route-row={route} className="contents">
        <Switch
          checked={current?.on === true}
          aria-label={t(ROUTE_TEXT[route].name, { app: productName() })}
          disabled={c.busy || inert}
          title={blocked ?? undefined}
          onClick={() => void c.act((companion) => setRoute(companion, route, !current?.on))}
        />
      </span>
    </SettingRow>
  );
}

export function PhoneComputerAndAdvanced({
  profileEmail = "",
  simple = false,
  onSessionsChange,
}: {
  profileEmail?: string;
  simple?: boolean;
  onSessionsChange?: () => void;
}) {
  const c = usePhoneSetupController(profileEmail);
  const state = c.state;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [moreOpenAsked, setMoreOpen] = useState<boolean | null>(null);
  const managedPolicy = useStore().state.config?.managedPolicy;
  const managedBy = managedPolicy?.remoteAccess === false
    ? t("policy.managedBy", { organization: managedPolicy.organizationName })
    : null;

  if (!companionBridge() || !state) return null;

  const tailscaleStatus = deriveTailscalePairingStatus(state);
  const tailscaleOn = state.routes?.tailscale?.on === true;
  const httpsOn = state.routes?.https?.on === true;
  const hosted = state.endpoints?.find((endpoint) => endpoint.kind === "hosted");
  const anyRoute = companionRoutesOn(state);
  const moreWays = !simple || tailscaleOn || httpsOn;
  const moreOpen = moreOpenAsked ?? (tailscaleOn || httpsOn);
  const accountActionError = companionAccountActionError(c.account, c.accountError);

  return (
    <div className="flex flex-col gap-6">
      <TailnetComputers
        c={c}
        state={state}
        blocked={managedBy}
        simple={simple}
        status={tailscaleStatus}
        mode="panel"
        onSessionsChange={onSessionsChange}
      />

      <SettingsDisclosureRow
        id="phone-advanced"
        title={t("settings.simple.advanced")}
        subtitle={t("phone.reach.title")}
        block="advanced"
        open={advancedOpen}
        onToggle={() => setAdvancedOpen((prev) => !prev)}
      >
        <AdvancedRouteRow c={c} state={state} route="wifi" blocked={managedBy} />
        <AdvancedRouteRow c={c} state={state} route="relay" blocked={managedBy} />
        <SettingRow
          title={t("remote.keepAwake")}
          subtitle={t("phone.reach.awakeLine")}
          inert={!anyRoute ? t("remote.keepAwakeNeedsRoute") : undefined}
        >
          <Switch
            checked={state.keepAwake}
            aria-label={t("remote.keepAwakeAria")}
            disabled={c.busy || !anyRoute}
            onClick={() => void c.act((companion) => companion.keepAwake(!state.keepAwake))}
          />
        </SettingRow>
        <RemoteAccessCheckRow account={c.account} state={state} />
        <TailnetComputers
          c={c}
          state={state}
          blocked={managedBy}
          simple={simple}
          status={tailscaleStatus}
          mode="advanced-row"
        />
        {moreWays && (
          <SettingsFoldRow id="more-ways" title={t("devices.moreWays")} open={moreOpen} onToggle={() => setMoreOpen(!moreOpen)}>
            <SettingRow
              title="Tailscale"
              subtitle={<>{t("remote.tailscaleSwitch.short", { app: productName() })}{" "}<LearnMore href={TAILSCALE_HELP} /></>}
              message={tailscaleStatus.kind !== "off"
                ? <span data-tailscale-status={tailscaleStatus.kind} aria-live="polite">{tailscaleStatus.title}{tailscaleStatus.detail ? ` ${tailscaleStatus.detail}` : ""}</span>
                : undefined}
            >
              <span data-route-row="tailscale" className="contents">
                {tailscaleStatus.kind === "not-installed" && (
                  <a href="https://tailscale.com/download" target="_blank" rel="noreferrer" className="ui-button">{t("remote.tailscale.getIt")}</a>
                )}
                {tailscaleOn && tailscaleStatus.kind !== "error" && tailscaleStatus.kind !== "not-installed" && (
                  <button type="button" className="settings-quiet cursor-pointer" disabled={c.busy || c.accountBusy} onClick={c.refreshTailscale}>
                    {c.busy ? t("common.checking") : t("remote.checkAgain")}
                  </button>
                )}
                <Switch
                  checked={tailscaleOn}
                  aria-label="Tailscale"
                  disabled={c.busy || c.accountBusy || (Boolean(managedBy) && !tailscaleOn)}
                  onClick={() => void c.act((companion) => setCompanionTailscale(companion, !tailscaleOn))}
                />
              </span>
            </SettingRow>
            {showHttpsAddressRow(state, c.account, companionBridge()) && (
              <SettingRow
                title={t("devices.route.https")}
                subtitle={t("devices.route.httpsDetail", { app: productName() })}
                message={(httpsOn && hosted) || c.account?.status === "ready" || accountActionError ? (
                  <>
                    {httpsOn && hosted ? t("devices.route.httpsOn", { address: endpointHost(hosted.url) }) : null}
                    {c.account?.status === "ready" && <span className="block">{t("devices.route.httpsAccount", { app: productName() })}</span>}
                    {accountActionError && <span className="block text-danger">{accountActionError}</span>}
                  </>
                ) : undefined}
              >
                <span data-route-row="https" className="contents">
                  {httpsOn ? (
                    <button type="button" className="ui-button" disabled={c.busy} onClick={() => void c.act((companion) => setRoute(companion, "https", false))}>
                      {t("devices.route.turnOff")}
                    </button>
                  ) : (
                    <button type="button" className="ui-button" disabled={c.busy || c.accountBusy || Boolean(managedBy)} onClick={() => c.start()}>
                      {t("devices.route.setUp")}
                    </button>
                  )}
                </span>
              </SettingRow>
            )}
          </SettingsFoldRow>
        )}
      </SettingsDisclosureRow>

      <PhonesList />
      {(c.error || state.error) && <div className="px-4 text-[12px] leading-4 text-danger">{c.error ?? state.error}</div>}
    </div>
  );
}
