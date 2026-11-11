import type { MouseEvent } from "react";
import { Monitor } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { ELEVATED_FLOAT, ELEVATED_HOVER } from "./elevated";

export function ChatComputerButton({ rawLeading, open, live, onClick }: {
  rawLeading: boolean;
  open: boolean;
  live: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const label = t(rawLeading ? "botPanel.tab.computer" : "chat.computer");
  return <button
    data-tour="computer"
    onClick={onClick}
    className={cn(
      "relative flex items-center justify-center rounded-full",
      rawLeading
        ? "h-9 shrink-0 gap-2 justify-self-start border border-hairline/60 bg-white px-3 text-[13px] font-medium text-ink shadow-sm hover:bg-raised focus-visible:outline-2 focus-visible:outline-focus"
        : cn("size-8", ELEVATED_FLOAT, ELEVATED_HOVER, open ? "text-accent" : "text-ink-secondary hover:text-ink"),
      rawLeading && open && "text-accent",
    )}
    title={label}
    aria-label={live ? `${label}, ${t("place.live")}` : label}
    aria-expanded={open}
  >
    <Monitor size={16} />{rawLeading && <span>{label}</span>}
    {live && <span aria-hidden="true" className="absolute right-1 top-1 size-1.5 animate-pulse rounded-full bg-success" data-testid="computer-button-live" />}
  </button>;
}
