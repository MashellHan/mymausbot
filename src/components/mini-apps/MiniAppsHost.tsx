import { lazy, Suspense, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "@/lib/i18n";
import { MiniAppsHostContext, type MiniAppsAttach, type MiniAppsRequest } from "./mini-apps-host-context";

const MiniAppsPanel = lazy(() => import("./MiniAppsPanel").then((module) => ({ default: module.MiniAppsPanel })));

function Apps({ requestedApp }: { requestedApp?: MiniAppsRequest }) {
  return <Suspense fallback={<div className="flex flex-1 items-center justify-center text-[13px] text-ink-secondary" role="status">{t("computer.miniApps.loading")}</div>}>
    <MiniAppsPanel requestedApp={requestedApp} />
  </Suspense>;
}

function moveContainer(container: HTMLDivElement, target: HTMLDivElement): void {
  if (container.isConnected && target.isConnected && typeof target.moveBefore === "function") target.moveBefore(container, null);
  else target.appendChild(container);
}

function useMiniAppsHostController(enabled: boolean) {
  const [container] = useState(() => {
    const element = document.createElement("div");
    element.className = "flex h-full min-h-0 flex-1 flex-col";
    return element;
  });
  const parking = useRef<HTMLDivElement>(null);
  const activeSlot = useRef<HTMLDivElement | null>(null);
  const [opened, setOpened] = useState(false);
  const [requestedApp, setRequestedApp] = useState<MiniAppsRequest>();
  const lastRequest = useRef<MiniAppsRequest>(undefined);
  const requestNonce = useRef(0);
  useLayoutEffect(() => {
    if (!enabled) {
      setOpened(false);
      setRequestedApp(undefined);
      lastRequest.current = undefined;
    }
  }, [enabled]);
  const attach = useCallback<MiniAppsAttach>((slot, request) => {
    if (!enabled) return () => {};
    activeSlot.current = slot;
    moveContainer(container, slot);
    if (request && request !== lastRequest.current) {
      lastRequest.current = request;
      setRequestedApp({ id: request.id, nonce: ++requestNonce.current });
    }
    setOpened(true);
    return () => {
      if (activeSlot.current !== slot) return;
      activeSlot.current = null;
      if (parking.current) moveContainer(container, parking.current);
    };
  }, [container, enabled]);
  const portal = (
    <>
      <div ref={parking} hidden aria-hidden="true" />
      {enabled && opened && createPortal(<Apps requestedApp={requestedApp} />, container)}
    </>
  );
  return { attach, portal };
}

export function MiniAppsHost({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const { attach, portal } = useMiniAppsHostController(enabled);
  return <MiniAppsHostContext value={attach}>
    {children}
    {portal}
  </MiniAppsHostContext>;
}

export function MiniAppsHostRuntime({ enabled, onAttach }: { enabled: boolean; onAttach: (next: MiniAppsAttach | null) => void }) {
  const { attach, portal } = useMiniAppsHostController(enabled);
  useLayoutEffect(() => {
    onAttach(attach);
  }, [attach, onAttach]);
  useLayoutEffect(() => () => {
    onAttach(null);
  }, [onAttach]);
  return portal;
}

export function MiniAppsSlot({ requestedApp }: { requestedApp?: MiniAppsRequest }) {
  const attach = useContext(MiniAppsHostContext);
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (attach && slot.current) return attach(slot.current, requestedApp);
  }, [attach, requestedApp]);
  return attach ? <div ref={slot} className="flex min-h-0 flex-1 flex-col" /> : <Apps requestedApp={requestedApp} />;
}
