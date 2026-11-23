import { Pin } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { togglePinnedPwaBot, usePwaPrefs } from "@/lib/pwa-cache";
import { isRemotePwaMode } from "@/lib/pwa-config";
import { ELEVATED_FLOAT, ELEVATED_HOVER } from "./elevated";

export function PwaPinBotButton({ botId }: { botId: string }) {
  const prefs = usePwaPrefs();
  if (!isRemotePwaMode()) return null;
  const pinned = Boolean(prefs?.openPinnedOnLaunch && prefs.pinnedBotId === botId);
  const label = t(pinned ? "chat.unpinBot" : "chat.pinBot");
  return (
    <button
      type="button"
      data-pwa-pin-bot={pinned ? "pinned" : "unpinned"}
      aria-pressed={pinned}
      aria-label={label}
      title={label}
      onClick={() => { void togglePinnedPwaBot(botId); }}
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
        ELEVATED_FLOAT,
        ELEVATED_HOVER,
        pinned ? "text-accent" : "text-ink-secondary hover:text-ink",
      )}
    >
      <Pin size={14} strokeWidth={1.75} className={pinned ? "fill-current" : undefined} aria-hidden="true" />
    </button>
  );
}
