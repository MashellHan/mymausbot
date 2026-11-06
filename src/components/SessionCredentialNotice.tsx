import { t } from "@/lib/i18n";

export function SessionCredentialNotice() {
  if (window.ogb?.credentialMode?.() !== "session") return null;
  return <p role="status" className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-warning">
    {t("settings.credentials.sessionOnly")}
  </p>;
}
