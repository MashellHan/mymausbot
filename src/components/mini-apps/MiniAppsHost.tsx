import { createContext, lazy, Suspense, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "@/lib/i18n";

const MiniAppsPanel = lazy(() => import("./MiniAppsPanel").then((module) => ({ default: module.MiniAppsPanel })));
type AppRequest = { id: string; nonce: number };
type Attach = (slot: HTMLDivElement, request?: AppRequest) => () => void;
const MiniAppsHostContext = createContext<Attach | null>(null);

function Apps({ requestedApp }: { requestedApp?: AppRequest }) {
  return <Suspense fallback={<div className="flex flex-1 items-center justify-center text-[13px] text-ink-secondary" role="status">{t("computer.miniApps.loading")}</div>}>
    <MiniAppsPanel requestedApp={requestedApp} />
  </Suspense>;
}

function moveContainer(container: HTMLDivElement, target: HTMLDivElement): void {
  if (container.isConnected && target.isConnected && typeof target.moveBefore === "function") target.moveBefore(container, null);
  else target.appendChild(container);
}

export function MiniAppsHost({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [container] = useState(() => {
    const element = document.createElement("div");
    element.className = "flex h-full min-h-0 flex-1 flex-col";
    return element;
  });
  const parking = useRef<HTMLDivElement>(null);
  const activeSlot = useRef<HTMLDivElement | null>(null);
  const [opened, setOpened] = useState(false);
  const [requestedApp, setRequestedApp] = useState<AppRequest>();
  const lastRequest = useRef<AppRequest>(undefined);
  const requestNonce = useRef(0);
  useLayoutEffect(() => {
    if (!enabled) {
      setOpened(false);
      setRequestedApp(undefined);
      lastRequest.current = undefined;
    }
  }, [enabled]);
  const attach = useCallback<Attach>((slot, request) => {
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

  return <MiniAppsHostContext value={attach}>
    {children}
    <div ref={parking} hidden aria-hidden="true" />
    {enabled && opened && createPortal(<Apps requestedApp={requestedApp} />, container)}
  </MiniAppsHostContext>;
}

export function MiniAppsSlot({ requestedApp }: { requestedApp?: AppRequest }) {
  const attach = useContext(MiniAppsHostContext);
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (attach && slot.current) return attach(slot.current, requestedApp);
  }, [attach, requestedApp]);
  return attach ? <div ref={slot} className="flex min-h-0 flex-1 flex-col" /> : <Apps requestedApp={requestedApp} />;
}
