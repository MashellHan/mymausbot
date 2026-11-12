import { useEffect, useId, useState, type ReactNode } from "react";
import type { Bot, InstanceInfo } from "@/state/store";
import { engineDisplayName, isCustomOnly } from "@/lib/engine-rail";
import { choiceIsSelected, modelChoices } from "@/lib/model-choices";
import { modelName } from "@/lib/simple-model-menu";
import { t } from "@/lib/i18n";
import { needsCli, needsSignIn } from "./EngineSetup";
import { Select } from "./Select";

export function ModelSettingsPanel({ bot, instances, disabled, attention, summary, busyReason, reasoningWhileBusy, onPick, onManage, children }: {
  bot: Bot;
  instances: InstanceInfo[];
  disabled: boolean;
  attention?: string;
  summary: string;
  busyReason?: string;
  reasoningWhileBusy: boolean;
  onPick: (instance: InstanceInfo, model: string, variant?: string) => void;
  onManage?: () => void;
  children: ReactNode;
}) {
  const selection = bot.modelSelection;
  const active = instances.find((instance) => instance.instanceId === selection.instanceId);
  const [sourceId, setSourceId] = useState(selection.instanceId);
  const busyReasonId = useId();
  useEffect(() => setSourceId(selection.instanceId), [bot.id, bot.threadId, selection.instanceId]);
  const source = instances.find((instance) => instance.instanceId === sourceId);
  const choices = source ? modelChoices(source, source.models.options).map((option) => ({
    instance: source,
    option, value: JSON.stringify([source.instanceId, option.id]),
    selected: source.instanceId === selection.instanceId && choiceIsSelected(option, selection),
    disabled: Boolean(source.policy || needsCli(source) || option.orgBlocked || (!option.custom && needsSignIn(source) && !isCustomOnly(source))),
  })) : [];
  const selected = choices.find((choice) => choice.selected);
  const sourceAttention = source?.instanceId === selection.instanceId ? attention
    : source?.policy ? t("policy.managedBy", { organization: source.policy.organizationName })
      : needsCli(source) ? t("model.setupRequired")
        : source && needsSignIn(source) && !isCustomOnly(source) ? t("model.simple.signInForOwn", { name: engineDisplayName(source) }) : undefined;

  return <div data-model-settings className="space-y-3">
    <label className="flex items-center justify-between gap-3">
      <span className="text-[13px] text-ink-secondary">{t("model.source")}</span>
      <Select size="sm" variant="quiet" className="w-[65%]" aria-label={t("model.source")}
        aria-describedby={busyReason ? busyReasonId : undefined} value={source?.instanceId ?? "current"} disabled={disabled}
        onChange={(event) => setSourceId(event.target.value)}>
        {!source && <option value="current" disabled>{selection.instanceId} · {t("model.simple.unavailable")}</option>}
        {instances.map((instance) => <option key={instance.instanceId} value={instance.instanceId}>{engineDisplayName(instance)}</option>)}
      </Select>
    </label>
    <label className="flex items-center justify-between gap-3">
      <span className="text-[13px] text-ink-secondary">{t("model.simple.model")}</span>
      <Select size="sm" variant="quiet" className="w-[65%]" aria-label={t("model.choose")}
        title={source?.instanceId === selection.instanceId ? summary : undefined}
        aria-describedby={busyReason ? busyReasonId : undefined} value={selected?.value ?? "current"} disabled={disabled || !source}
        onChange={(event) => {
          const choice = choices.find((candidate) => candidate.value === event.target.value);
          if (choice && !choice.disabled) onPick(choice.instance, choice.option.nativeModel ?? choice.option.id, choice.option.variant);
        }}>
        {!selected && <option value="current" disabled>{source?.instanceId === selection.instanceId
          ? modelName(active, selection.model, selection.variant) : t("model.choose")}</option>}
        {choices.map((choice) => <option key={choice.value} value={choice.value} disabled={choice.disabled}>{choice.option.label}</option>)}
      </Select>
    </label>
    {sourceAttention && <p className="text-[12px] text-warning">{sourceAttention}</p>}
    {busyReason && <p id={busyReasonId} data-model-busy-reason role="status" className="text-[12px] text-ink-secondary">
      {busyReason}{reasoningWhileBusy && ` · ${t("model.reasoningNextTurn")}`}
    </p>}
    <fieldset disabled={Boolean(active?.policy) || (bot.busy && !reasoningWhileBusy)} className="min-w-0 space-y-3 border-0 p-0">{children}</fieldset>
    {onManage && <button type="button" onClick={onManage}
      className="rounded-sm text-[12px] text-ink-secondary hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">{t("model.simple.manage")}</button>}
  </div>;
}
