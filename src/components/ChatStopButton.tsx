import { Square } from "lucide-react";
import { cn } from "@/lib/cn";
import { COMPACT_BUBBLE } from "@/lib/compact-chip";
import { t } from "@/lib/i18n";

export function ChatStopButton({ onClick }: { onClick: () => void }) {
  return <button type="button" onClick={onClick}
    className={cn("flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink", COMPACT_BUBBLE)}
    title={t("chat.stopTurn")}>
    <Square size={12} className="fill-current" />
    <span className="@max-4xl/chathead:hidden">{t("chat.stop")}</span>
  </button>;
}
