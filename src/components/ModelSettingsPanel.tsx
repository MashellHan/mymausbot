import type { ReactNode } from "react";
import type { Bot, InstanceInfo } from "@/state/store";
import { engineDisplayName, isCustomOnly } from "@/lib/engine-rail";
import { modelChoices } from "@/lib/model-choices";
import { modelName } from "@/lib/simple-model-menu";
import { t } from "@/lib/i18n";
import { needsCli, needsSignIn } from "./EngineSetup";
import { Select } from "./Select";

export function ModelSettingsPanel({ bot, instances, disabled, attention, summary, onPick, onManage, children }: {
  bot: Bot;
  instances: InstanceInfo[];
  disabled: boolean;
  attention?: string;
  summary: string;
  onPick: (instance: InstanceInfo, model: string, variant?: string) => void;
  onManage?: () => void;
  children: ReactNode;
}) {
  const selection = bot.modelSelection;
  const active = instances.find((instance) => instance.instanceId === selection.instanceId);
  const choices = instances.flatMap((instance) => modelChoices(instance, instance.models.options).map((option) => ({
    instance, option, value: JSON.stringify([instance.instanceId, option.id]),
    selected: instance.instanceId === selection.instanceId && (option.nativeModel ?? option.id) === selection.model
      && (option.variant === undefined || option.variant === selection.variant),
    disabled: Boolean(instance.policy || needsCli(instance) || option.orgBlocked || (!option.custom && needsSignIn(instance) && !isCustomOnly(instance))),
  })));
  const selected = choices.find((choice) => choice.selected);

  return <div data-model-settings className="space-y-3">
    <label className="flex items-center justify-between gap-3">
      <span className="text-[13px] text-ink-secondary">{t("model.simple.model")}</span>
      <Select size="sm" variant="quiet" className="w-[65%]" aria-label={t("model.choose")} title={summary}
        value={selected?.value ?? "current"} disabled={disabled}
        onChange={(event) => {
          const choice = choices.find((candidate) => candidate.value === event.target.value);
          if (choice && !choice.disabled) onPick(choice.instance, choice.option.nativeModel ?? choice.option.id, choice.option.variant);
        }}>
        {!selected && <option value="current" disabled>{modelName(active, selection.model, selection.variant)}</option>}
        {instances.map((instance) => <optgroup key={instance.instanceId} label={engineDisplayName(instance)}>
          {choices.filter((choice) => choice.instance === instance).map((choice) =>
            <option key={choice.value} value={choice.value} disabled={choice.disabled}>{choice.option.label}</option>)}
        </optgroup>)}
      </Select>
    </label>
    {attention && <p className="text-[12px] text-warning">{attention}</p>}
    <fieldset disabled={bot.busy || Boolean(active?.policy)} className="min-w-0 space-y-3 border-0 p-0">{children}</fieldset>
    {onManage && <button type="button" onClick={onManage}
      className="rounded-sm text-[12px] text-ink-secondary hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">{t("model.simple.manage")}</button>}
  </div>;
}
