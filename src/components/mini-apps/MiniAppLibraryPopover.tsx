import { useEffect, useRef, type ReactNode } from "react";
import { LayoutGrid } from "lucide-react";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { t } from "@/lib/i18n";
import type { DefaultMiniAppKind, MiniAppDefaultsResult, MiniAppSummary } from "../../../shared/mini-apps";
import { MiniAppLibraryEntries } from "./MiniAppLibraryEntries";

export function MiniAppLibraryPopover({ open, inventory, issues, busyKind, focusKind, owner, nativeGuard,
  onToggle, onClose, onOpen, onAdd, onRemove, children }: {
  open: boolean;
  inventory: MiniAppSummary[];
  issues: MiniAppDefaultsResult["issues"];
  busyKind: DefaultMiniAppKind | null;
  focusKind: DefaultMiniAppKind | null;
  owner: boolean | null;
  nativeGuard: boolean;
  children?: ReactNode;
  onToggle(): void;
  onClose(): void;
  onOpen(id: string): void;
  onAdd(kind: DefaultMiniAppKind): void;
  onRemove(app: MiniAppSummary): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, root, () => { onClose(); trigger.current?.focus(); });
  useEffect(() => {
    if (!open) return;
    const first = focusKind ? menu.current?.querySelector<HTMLButtonElement>(`[data-mini-app-grid-item="${focusKind}"]`) : null;
    (first ?? menu.current?.querySelector<HTMLButtonElement>("[data-mini-app-grid-item]"))?.focus();
  }, [open, focusKind, inventory.length]);

  return <div ref={root} className="relative shrink-0" onBlur={(event) => {
    if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) onClose();
  }}>
    <button ref={trigger} type="button" data-mini-app-all aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? "mini-app-library-popover" : undefined} onClick={onToggle}
      className="inline-flex items-center gap-1 rounded-lg bg-control px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent">
      <LayoutGrid size={14} aria-hidden="true" />{t("computer.miniApps.allApps")}</button>
    {open && <div ref={menu} id="mini-app-library-popover" role="dialog" aria-modal="false" aria-label={t("computer.miniApps.libraryTitle")}
      data-mini-app-popover className="absolute right-0 top-full z-30 mt-2 max-h-[min(70vh,560px)] overflow-y-auto rounded-xl border border-hairline/60 bg-panel p-3 text-ink shadow-xl"
      style={{ width: "min(420px, calc(100cqw - 24px))" }}>
      <MiniAppLibraryEntries inventory={inventory} issues={issues} busyKind={busyKind} owner={owner}
        nativeGuard={nativeGuard} onOpen={onOpen} onAdd={onAdd} onRemove={onRemove} />
      {children}
    </div>}
  </div>;
}
