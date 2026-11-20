import { useEffect, useRef } from "react";
import { Loader2, X } from "lucide-react";
import { t } from "@/lib/i18n";

export function MiniAppUpdateToast({
  appName,
  version,
  updating,
  error,
  restoreFocusOnError = true,
  onUpdate,
  onDismiss,
}: {
  appName: string;
  version: string;
  updating: boolean;
  error: string;
  restoreFocusOnError?: boolean;
  onUpdate(): void;
  onDismiss(): void;
}) {
  const updateButtonRef = useRef<HTMLButtonElement>(null);
  const wasUpdatingRef = useRef(false);

  useEffect(() => {
    if (restoreFocusOnError && wasUpdatingRef.current && !updating && error) {
      updateButtonRef.current?.focus();
    }
    wasUpdatingRef.current = updating;
  }, [updating, error, restoreFocusOnError]);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="mini-app-update-toast"
      className="mx-4 mt-3 flex flex-col gap-2 rounded-xl border border-hairline bg-card px-3 py-2 text-[13px] leading-[18px] text-ink animate-fade-in motion-reduce:animate-none"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 text-[13px] leading-[18px] text-ink">
          {t("computer.miniApps.update.available", { name: appName, version })}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            ref={updateButtonRef}
            type="button"
            data-mini-app-update-action
            disabled={updating}
            aria-busy={updating || undefined}
            onClick={onUpdate}
            className="ui-button ui-button-sm ui-button-primary focus-visible:outline-2 focus-visible:outline-accent"
          >
            {updating && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            {t(updating ? "computer.miniApps.update.updating" : "computer.miniApps.update.action")}
          </button>
          <button
            type="button"
            data-mini-app-update-dismiss
            disabled={updating}
            aria-label={t("computer.miniApps.update.dismiss")}
            onClick={onDismiss}
            className="ui-button ui-button-sm focus-visible:outline-2 focus-visible:outline-accent"
          >
            <X size={14} aria-hidden="true" />
            <span>{t("computer.miniApps.update.dismiss")}</span>
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" data-mini-app-update-error className="text-[12px] leading-4 text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
