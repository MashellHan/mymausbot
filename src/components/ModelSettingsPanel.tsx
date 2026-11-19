import { useEffect, useId, useState, type ReactNode } from "react";
import type { Bot, InstanceInfo } from "@/state/store";
import { engineDisplayName, isCustomOnly } from "@/lib/engine-rail";
import { modelName } from "@/lib/simple-model-menu";
import { t } from "@/lib/i18n";
import { needsCli, needsSignIn } from "./EngineSetup";
import { Select } from "./Select";

type ModelOption = InstanceInfo["models"]["options"][number];
type ModelSource = { instance: InstanceInfo; options: ModelOption[] };
type ProviderRoute = NonNullable<ModelOption["providerRoute"]>;
type ProviderGroup = { key: string; route: ProviderRoute; sources: ModelSource[] };

const MODEL_TYPE_LABELS: Readonly<Record<string, string>> = {
  antigravityAgent: "Antigravity", cerebras: "Cerebras", claudeAgent: "Claude", clineAgent: "Cline",
  codex: "Codex", commandCodeAgent: "Command Code", copilotAgent: "GitHub Copilot", cursorAgent: "Cursor",
  customAcp: "Custom (ACP)", deepseekAgent: "DeepSeek Harness", droidAgent: "Droid", geminiAgent: "Gemini",
  greenference: "Greenference", grok: "Grok (API)", grokAgent: "Grok", groq: "Groq", hermesAgent: "Hermes",
  kimiAgent: "Kimi", kiroAgent: "Kiro", meta: "Meta Muse (API)", minimax: "MiniMax (API)",
  mistral: "Mistral (API)", museCode: "Muse Code", "openai-compat": "OpenAI-compatible",
  opencodeGo: "OpenCode", piAgent: "pi", qwenAgent: "Qwen",
};

function connectionKey(instance: InstanceInfo, route?: ProviderRoute): string {
  return route?.connectionGroup ?? JSON.stringify([instance.instanceId, route?.id ?? "unknown"]);
}

function providerGroups(instances: readonly InstanceInfo[]): ProviderGroup[] {
  const groups: ProviderGroup[] = [];
  for (const instance of instances) for (const option of instance.models.options) {
    const route = option.providerRoute ?? { id: "unknown", provenance: "unknown" as const };
    const key = connectionKey(instance, route);
    let group = groups.find((candidate) => candidate.key === key);
    if (!group) groups.push(group = { key, route, sources: [] });
    let source = group.sources.find((candidate) => candidate.instance.instanceId === instance.instanceId);
    if (!source) group.sources.push(source = { instance, options: [] });
    source.options.push(option);
  }
  return groups;
}

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
  const groups = providerGroups(instances);
  const selectedOption = active?.models.options.find((option) => option.id === selection.model);
  const savedKey = active && selectedOption ? connectionKey(active, selectedOption.providerRoute) : "current";
  const [preview, setPreview] = useState({ provider: savedKey, instanceId: selection.instanceId });
  const busyReasonId = useId();
  useEffect(() => setPreview({ provider: savedKey, instanceId: selection.instanceId }), [bot.id, bot.threadId, savedKey, selection.instanceId, selection.model]);
  const group = groups.find((candidate) => candidate.key === preview.provider);
  const sources = group?.sources ?? [];
  const source = sources.find((candidate) => candidate.instance.instanceId === preview.instanceId) ?? sources[0];
  const previewInstance = source?.instance;
  const showingSaved = preview.provider === savedKey && (!previewInstance || previewInstance.instanceId === selection.instanceId);
  const choices = source ? source.options.map((option) => ({
    instance: source.instance,
    option, value: JSON.stringify([source.instance.instanceId, option.id]),
    selected: showingSaved && option.id === selection.model,
    disabled: Boolean(source.instance.policy || needsCli(source.instance) || option.orgBlocked || option.needsCliUpdate ||
      option.protocolUnsupported || (!option.custom && needsSignIn(source.instance) && !isCustomOnly(source.instance))),
  })) : [];
  const selected = choices.find((choice) => choice.selected);
  const sourceAttention = showingSaved ? attention
    : previewInstance?.policy ? t("policy.managedBy", { organization: previewInstance.policy.organizationName })
      : needsCli(previewInstance) ? t("model.setupRequired")
        : previewInstance && needsSignIn(previewInstance) && !isCustomOnly(previewInstance) ? t("model.simple.signInForOwn", { name: engineDisplayName(previewInstance) }) : undefined;
  const providerName = (group: ProviderGroup) => group.route.label?.trim()
    || t(group.route.provenance === "local" ? "model.connection.local" : "model.connection.unknown");
  const connectionName = (group: ProviderGroup) => {
    const instance = group.sources[0]!.instance;
    return instance.snapshot.account?.email?.trim() || engineDisplayName(instance).trim();
  };
  const providerLabels = groups.map((group) => {
    const name = providerName(group);
    const matching = groups.filter((other) => providerName(other) === name);
    if (matching.length === 1) return name;
    const connection = connectionName(group);
    const label = connection && connection !== name ? `${name} · ${connection}` : name;
    const ambiguous = matching.filter((other) => connectionName(other) === connection);
    return ambiguous.length > 1 ? `${label} · ${ambiguous.indexOf(group) + 1}` : label;
  });
  const modelTypeName = (kind: string) => (Object.hasOwn(MODEL_TYPE_LABELS, kind) ? MODEL_TYPE_LABELS[kind] : undefined)
    ?? t("model.type.unknown");
  const modelTypes = sources.map(({ instance }) => {
    const sameType = sources.filter((candidate) => candidate.instance.driverKind === instance.driverKind);
    const unique = sameType.length === 1;
    const account = (candidate: InstanceInfo) => candidate.snapshot.account?.email?.trim() || engineDisplayName(candidate);
    const sameAccountLabel = sameType.filter((candidate) => account(candidate.instance) === account(instance));
    const suffix = sameAccountLabel.length > 1 ? ` · ${sameAccountLabel.findIndex((candidate) => candidate.instance === instance) + 1}` : "";
    return { instanceId: instance.instanceId, value: unique ? instance.driverKind : JSON.stringify([instance.driverKind, instance.instanceId]),
      label: unique ? modelTypeName(instance.driverKind) : `${modelTypeName(instance.driverKind)} · ${account(instance)}${suffix}` };
  });

  return <div data-model-settings className="space-y-3">
    <label className="flex items-center justify-between gap-3">
      <span className="text-[13px] text-ink-secondary">{t("model.source")}</span>
      <Select size="sm" variant="quiet" className="w-[65%]" aria-label={t("model.source")}
        aria-describedby={busyReason ? busyReasonId : undefined} value={group?.key ?? "current"} disabled={disabled}
        onChange={(event) => setPreview({ provider: event.target.value, instanceId: selection.instanceId })}>
        {!group && <option value="current" disabled>{t("model.connection.unknown")}</option>}
        {groups.map((group, index) => <option key={group.key} value={group.key}>{providerLabels[index]}</option>)}
      </Select>
    </label>
    <label className="flex items-center justify-between gap-3">
      <span className="text-[13px] text-ink-secondary">{t("model.type")}</span>
      <Select size="sm" variant="quiet" className="w-[65%]" aria-label={t("model.type")}
        value={modelTypes.find((type) => type.instanceId === previewInstance?.instanceId)?.value ?? "current"}
        disabled={disabled || modelTypes.length < 2}
        onChange={(event) => {
          const type = modelTypes.find((candidate) => candidate.value === event.target.value);
          if (type) setPreview({ provider: preview.provider, instanceId: type.instanceId });
        }}>
        {!previewInstance && <option value="current" disabled>{active ? modelTypeName(active.driverKind) : t("model.simple.unavailable")}</option>}
        {modelTypes.map((type) => <option key={type.instanceId} value={type.value}>{type.label}</option>)}
      </Select>
    </label>
    <label className="flex items-center justify-between gap-3">
      <span className="text-[13px] text-ink-secondary">{t("model.simple.model")}</span>
      <Select size="sm" variant="quiet" className="w-[65%]" aria-label={t("model.choose")}
        title={showingSaved ? summary : undefined}
        aria-describedby={busyReason ? busyReasonId : undefined} value={selected?.value ?? "current"} disabled={disabled || !source}
        onChange={(event) => {
          const choice = choices.find((candidate) => candidate.value === event.target.value);
          if (choice && !choice.disabled) onPick(choice.instance, choice.option.id);
        }}>
        {!selected && <option value="current" disabled>{showingSaved
          ? modelName(active, selection.model, selection.variant) : t("model.choose")}</option>}
        {choices.map((choice) => <option key={choice.value} value={choice.value} disabled={choice.disabled}>
          {choice.option.label}{choice.option.protocolUnsupported ? ` · ${t("model.simple.unavailable")}` : ""}
        </option>)}
      </Select>
    </label>
    {sourceAttention && <p className="text-[12px] text-warning">{sourceAttention}</p>}
    {busyReason && <p id={busyReasonId} data-model-busy-reason role="status" className="text-[12px] text-ink-secondary">
      {busyReason}{reasoningWhileBusy && ` · ${t("model.reasoningNextTurn")}`}
    </p>}
    <fieldset disabled={!showingSaved || Boolean(active?.policy) || (bot.busy && !reasoningWhileBusy)} className="min-w-0 space-y-3 border-0 p-0">
      {!showingSaved && <legend data-current-model-settings className="mb-2 text-[12px] text-ink-secondary">
        {t("model.currentSettings", { model: modelName(active, selection.model, selection.variant) })}
      </legend>}
      {children}
    </fieldset>
    {onManage && <button type="button" onClick={onManage}
      className="rounded-sm text-[12px] text-ink-secondary hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">{t("model.simple.manage")}</button>}
  </div>;
}
