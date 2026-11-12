import { useEffect, useId, useState } from "react";
import { ChevronDown, Gauge } from "lucide-react";
import { MAX_CONTEXT_WINDOW_TOKENS, MIN_CONTEXT_WINDOW_TOKENS, type ModelSelection } from "../../shared/model-selection";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { MENU_GUTTER, MENU_ICON, MENU_ROW, MENU_STROKE, MENU_TRAILING } from "./menu-recipe";

export function ModelContextWindow({ selection, disabled, onChange, inline = false }: {
  selection: ModelSelection;
  disabled?: boolean;
  onChange: (selection: ModelSelection) => void;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(String(selection.contextWindowTokens ?? ""));
  const id = useId();
  useEffect(() => {
    setDraft(String(selection.contextWindowTokens ?? ""));
  }, [selection.instanceId, selection.model, selection.contextWindowTokens]);
  const text = draft.trim();
  const value = text === "" ? undefined : Number(text);
  const valid = value === undefined || /^\d+$/.test(text) && Number.isSafeInteger(value)
    && value >= MIN_CONTEXT_WINDOW_TOKENS && value <= MAX_CONTEXT_WINDOW_TOKENS;
  const apply = (next: number | undefined) => {
    if (disabled || next === selection.contextWindowTokens) return;
    const { contextWindowTokens: _window, ...model } = selection;
    onChange(next === undefined ? model : { ...model, contextWindowTokens: next });
  };

  return <div data-model-context-window className={cn("min-w-0", inline && "flex items-start justify-between gap-3")}>
    {inline ? <label htmlFor={`${id}-input`} className="pt-1.5 text-[13px] text-ink-secondary">{t("model.context.label")}</label> :
    <button type="button" data-menu-row disabled={disabled} aria-expanded={open} aria-controls={`${id}-edit`}
      onClick={() => setOpen(!open)} className={MENU_ROW}>
      <span className={MENU_GUTTER}><Gauge size={16} strokeWidth={MENU_STROKE} className={MENU_ICON} aria-hidden="true" /></span>
      <span className="min-w-0 flex-1 truncate">{t("model.context.label")}</span>
      <span className="shrink-0 text-ink-secondary">{selection.contextWindowTokens?.toLocaleString() ?? t("model.simple.auto")}</span>
      <ChevronDown size={16} strokeWidth={MENU_STROKE} className={cn(MENU_TRAILING, open && "rotate-180")} aria-hidden="true" />
    </button>}
    {(inline || open) && <form id={`${id}-edit`} className={cn("space-y-2", inline ? "w-[65%] min-w-0" : "px-2 pb-2 pt-1")} onSubmit={(event) => { event.preventDefault(); if (valid) apply(value); }}>
      <div className="flex min-w-0 items-center gap-2">
        <input id={`${id}-input`} aria-label={t("model.context.label")} aria-invalid={!valid || undefined} aria-describedby={!valid ? `${id}-error` : undefined}
          inputMode="numeric" value={draft} disabled={disabled} placeholder={t("model.simple.auto")}
          onChange={(event) => setDraft(event.target.value)}
          className="h-8 min-w-0 flex-1 rounded-md bg-ink/[0.05] px-2 text-[13px] tabular-nums text-ink outline-none focus-visible:ring-[1.5px] focus-visible:ring-focus" />
        <button type="submit" disabled={disabled || !valid || value === selection.contextWindowTokens}
          className="h-8 rounded-md px-2 text-[12px] text-ink hover:bg-ink/[0.06] disabled:opacity-40">{t("common.save")}</button>
        <button type="button" disabled={disabled} onClick={() => { setDraft(""); apply(undefined); }}
          className="h-8 rounded-md px-2 text-[12px] text-ink-secondary hover:bg-ink/[0.06]">{t("model.simple.auto")}</button>
      </div>
      {!valid && <p id={`${id}-error`} role="alert" className="text-[12px] text-danger">{t("model.context.invalid", {
        min: MIN_CONTEXT_WINDOW_TOKENS.toLocaleString(), max: MAX_CONTEXT_WINDOW_TOKENS.toLocaleString(),
      })}</p>}
    </form>}
  </div>;
}
