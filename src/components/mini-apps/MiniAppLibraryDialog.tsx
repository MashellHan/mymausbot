import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { t } from "@/lib/i18n";
import type { MiniAppSummary } from "../../../shared/mini-apps";
import { MiniAppLibraryEntries } from "./MiniAppLibraryEntries";
import type { MiniAppIconKind } from "./MiniAppIcon";

export function MiniAppLibraryDialog({ inventory, routines, owner, nativeGuard, focusKind, onClose, onOpen, onSetup }: {
  inventory: MiniAppSummary[];
  routines: "ready" | "needs" | "loading" | "error";
  owner: boolean | null;
  nativeGuard: boolean;
  focusKind: MiniAppIconKind | null;
  onClose(): void;
  onOpen(id: string): void;
  onSetup(kind: MiniAppIconKind): void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useModalDialog(dialog, onClose);
  useEffect(() => {
    if (focusKind) dialog.current?.querySelector<HTMLElement>(`[data-mini-app-catalog="${focusKind}"]`)?.focus();
  }, [focusKind]);
  return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-3"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} id="mini-app-library-dialog" role="dialog" aria-modal="true" aria-labelledby="mini-app-library-title" tabIndex={-1}
      className="flex max-h-[min(90vh,760px)] w-full max-w-[680px] flex-col overflow-hidden rounded-2xl border border-hairline/60 bg-panel text-ink shadow-2xl">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-hairline/60 px-4 py-3">
        <div><h2 id="mini-app-library-title" className="text-[16px] font-semibold">{t("computer.miniApps.libraryTitle")}</h2>
          <p className="mt-1 text-[12px] leading-5 text-ink-secondary">{t("computer.miniApps.chooseTemplate")}</p></div>
        <button type="button" aria-label={t("computer.miniApps.libraryClose")} onClick={onClose}
          className="rounded-lg p-1.5 text-ink-secondary hover:bg-inset hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
          <X size={17} aria-hidden="true" /></button>
      </header>
      <div className="min-h-0 overflow-y-auto px-4 py-3">
        <MiniAppLibraryEntries inventory={inventory} routines={routines} owner={owner} nativeGuard={nativeGuard}
          onOpen={onOpen} onSetup={onSetup} />
      </div>
    </div>
  </div>, document.body);
}
