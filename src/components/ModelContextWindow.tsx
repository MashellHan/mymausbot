import { useId, useState } from "react";
import { ChevronDown, Gauge } from "lucide-react";
import { MAX_CONTEXT_WINDOW_TOKENS, MIN_CONTEXT_WINDOW_TOKENS, type ModelSelection } from "../../shared/model-selection";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { MENU_GUTTER, MENU_ICON, MENU_ROW, MENU_STROKE, MENU_TRAILING } from "./menu-recipe";
import { Select } from "./Select";

const WINDOW_OPTIONS = [32_000, 64_000, 128_000, 256_000, 512_000, MAX_CONTEXT_WINDOW_TOKENS];

export function ModelContextWindow({ selection, disabled, onChange, inline = false }: {
  selection: ModelSelection;
  disabled?: boolean;
  onChange: (selection: ModelSelection) => void;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const current = selection.contextWindowTokens;
  const options = [...new Set([...WINDOW_OPTIONS, ...(current === undefined ? [] : [current])])].sort((a, b) => a - b);
  const apply = (next: number | undefined) => {
    if (disabled || next === selection.contextWindowTokens) return;
    if (next !== undefined && (!Number.isSafeInteger(next) || next < MIN_CONTEXT_WINDOW_TOKENS || next > MAX_CONTEXT_WINDOW_TOKENS)) return;
    const { contextWindowTokens: _window, ...model } = selection;
    onChange(next === undefined ? model : { ...model, contextWindowTokens: next });
  };

  return <div data-model-context-window className={cn("min-w-0", inline && "flex items-start justify-between gap-3")}>
    {inline ? <label htmlFor={`${id}-select`} className="pt-1.5 text-[13px] text-ink-secondary">{t("model.context.label")}</label> :
    <button type="button" data-menu-row disabled={disabled} aria-expanded={open} aria-controls={`${id}-edit`}
      onClick={() => setOpen(!open)} className={MENU_ROW}>
      <span className={MENU_GUTTER}><Gauge size={16} strokeWidth={MENU_STROKE} className={MENU_ICON} aria-hidden="true" /></span>
      <span className="min-w-0 flex-1 truncate">{t("model.context.label")}</span>
      <span className="shrink-0 text-ink-secondary">{selection.contextWindowTokens?.toLocaleString() ?? t("model.simple.auto")}</span>
      <ChevronDown size={16} strokeWidth={MENU_STROKE} className={cn(MENU_TRAILING, open && "rotate-180")} aria-hidden="true" />
    </button>}
    {(inline || open) && <div id={`${id}-edit`} className={inline ? "w-[65%] min-w-0" : "px-2 pb-2 pt-1"}>
      <Select id={`${id}-select`} aria-label={t("model.context.label")} size="sm" variant="quiet" className="w-full"
        value={current === undefined ? "auto" : String(current)} disabled={disabled}
        onChange={(event) => {
          const value = event.target.value;
          if (value === "auto") apply(undefined);
          else {
            const option = options.find((tokens) => String(tokens) === value);
            if (option !== undefined) apply(option);
          }
        }}>
        <option value="auto">{t("model.simple.auto")}</option>
        {options.map((tokens) => <option key={tokens} value={tokens}>{tokens.toLocaleString()}</option>)}
      </Select>
    </div>}
  </div>;
}
