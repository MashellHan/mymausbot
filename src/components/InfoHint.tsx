import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, Info } from "lucide-react";
import { cn } from "@/lib/cn";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { anchoredMenuPosition } from "./SidebarPopoverMenu";

export function InfoHint({ label, children, warning = false, className }: {
  label: string; children: ReactNode; warning?: boolean; className?: string;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const root = useRef({ contains: (target: unknown) => target instanceof Node
    && Boolean(button.current?.contains(target) || content.current?.contains(target)) });
  const show = () => { clearTimeout(timer.current); setOpen(true); };
  const close = () => { clearTimeout(timer.current); pinned.current = false; setOpen(false); };
  const leave = (target: EventTarget | null) => {
    if (!pinned.current && !root.current.contains(target) && document.activeElement !== button.current) timer.current = setTimeout(close, 120);
  };
  usePopoverDismiss(open, root, close);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!button.current || !content.current) return;
      setPosition(anchoredMenuPosition(button.current.getBoundingClientRect(), content.current.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight }, getComputedStyle(button.current).direction === "rtl", "end"));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { clearTimeout(timer.current); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, children]);
  const Icon = warning ? CircleAlert : Info;
  return <>
    <button ref={button} type="button" data-info-hint aria-label={label} aria-expanded={open}
      aria-controls={open ? id : undefined} aria-describedby={open ? id : undefined}
      onMouseEnter={show} onMouseLeave={(event) => leave(event.relatedTarget)} onFocus={show}
      onBlur={(event) => { if ((!pinned.current || event.relatedTarget) && !root.current.contains(event.relatedTarget)) close(); }}
      onClick={() => { pinned.current = !pinned.current; setOpen(pinned.current); }}
      className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-full align-middle text-ink-secondary hover:bg-inset hover:text-ink focus-visible:outline-2 focus-visible:outline-accent", warning && "text-warning", className)}>
      <Icon size={14} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={content} id={id} role="tooltip" data-info-hint-content
      onMouseEnter={show} onMouseLeave={(event) => leave(event.relatedTarget)}
      className="fixed z-[110] max-h-[calc(100vh-1rem)] w-72 max-w-[calc(100vw-1rem)] space-y-1 overflow-y-auto rounded-lg bg-menu px-3 py-2 text-[12px] leading-5 text-ink shadow-lg [overflow-wrap:anywhere]"
      style={position}>{children}</div>, document.body)}
  </>;
}
