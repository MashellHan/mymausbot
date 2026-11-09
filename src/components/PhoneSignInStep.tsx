import { ArrowLeft, Mail } from "lucide-react";
import { t } from "@/lib/i18n";
import type { PhoneSetupController } from "./PhoneSetupFlow";
import { PhoneSetupSignInRoutes } from "./PhoneSetupSignInRoutes";

export function PhoneSignInStep({ c, actionError, canSubmitEmail }: {
  c: PhoneSetupController;
  actionError: string | null;
  canSubmitEmail: boolean;
}) {
  const unavailable = !c.account?.available;
  const failed = c.account?.status === "error" || c.setupTimedOut;
  return (
    <div className="mx-auto flex w-full max-w-[430px] flex-col">
      <button onClick={c.cancel} className="mb-4 flex w-fit items-center gap-1.5 text-[12px] text-ink-secondary hover:text-ink">
        <ArrowLeft size={13} /> {t("phone.back")}
      </button>
      <div className="flex size-11 items-center justify-center rounded-xl bg-accent/12 text-accent">
        <Mail size={20} />
      </div>
      <h2 className="mt-3 text-[18px] font-semibold text-ink">
        {unavailable || failed ? t("phone.signIn.attention") : t("phone.signIn.title")}
      </h2>
      <p
        role={c.setupTimedOut ? "alert" : undefined}
        className="mt-1 text-[13px] leading-relaxed text-ink-secondary"
      >
        {unavailable
          ? t("phone.signIn.unavailable")
          : c.setupTimedOut
            ? t("phone.signIn.timedOut")
          : failed
            ? c.account?.message ?? t("phone.signIn.failed")
            : t("phone.signIn.emailPrompt")}
      </p>

      {!unavailable && !failed && (
        <div className="mt-5 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-secondary">{t("phone.signIn.email")}</span>
            <input
              autoFocus
              autoComplete="email"
              inputMode="email"
              value={c.email}
              disabled={c.accountBusy || c.codeSent}
              onChange={(event) => c.setEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !c.codeSent && canSubmitEmail) c.requestCode();
              }}
              placeholder={t("common.emailPlaceholder")}
              className="rounded-lg border border-hairline/50 bg-inset px-3 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent disabled:opacity-50"
            />
          </label>
          {c.codeSent && (
            <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-ink-secondary">{t("phone.signIn.emailCode")}</span>
              <input
                autoFocus
                autoComplete="one-time-code"
                inputMode="numeric"
                value={c.code}
                disabled={c.accountBusy}
                onChange={(event) => c.setCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && c.code.length === 8) c.verifyCode();
                }}
                placeholder="12345678"
                className="rounded-lg border border-hairline/50 bg-inset px-3 py-2.5 font-mono text-[16px] tracking-[0.18em] text-ink outline-none placeholder:tracking-normal placeholder:text-ink-tertiary focus:border-accent disabled:opacity-50"
              />
            </label>
          )}
          <button
            disabled={c.accountBusy || (!c.codeSent && !canSubmitEmail) || (c.codeSent && c.code.length !== 8)}
            onClick={c.codeSent ? c.verifyCode : c.requestCode}
            className="rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {c.accountBusy ? t("phone.signIn.working") : c.codeSent ? t("phone.signIn.verify") : t("phone.signIn.sendCode")}
          </button>
          {c.codeSent && (
            <button
              disabled={c.accountBusy}
              onClick={c.changeEmail}
              className="text-[12px] text-ink-secondary hover:text-ink disabled:opacity-40"
            >
              {t("phone.signIn.otherEmail")}
            </button>
          )}
          {c.codeSent && !actionError && (
            <p className="text-[12px] text-ink-secondary">{t("phone.signIn.expires")}</p>
          )}
        </div>
      )}

      {(unavailable || failed) && (
        <button
          disabled={c.accountBusy}
          onClick={c.retryAccount}
          className="mt-5 rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white disabled:opacity-40"
        >
          {c.accountBusy ? t("remote.account.retrying") : t("phone.signIn.retry")}
        </button>
      )}
      {actionError && <p role="alert" className="mt-3 text-[13px] text-danger">{actionError}</p>}
      <PhoneSetupSignInRoutes c={c} />
    </div>
  );
}
