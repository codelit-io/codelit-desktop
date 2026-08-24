import { Bot, ChevronDown } from "lucide-react";
import type { IntelligenceSelection, ProviderProbe } from "../contracts";
import { preferredProviderModel } from "../bot-policy";

interface EnginePickerProps {
  providers: ProviderProbe[];
  value: IntelligenceSelection | null;
  onChange: (selection: IntelligenceSelection) => void;
  label?: string;
  compact?: boolean;
  disabled?: boolean;
}

function optionValue(provider: ProviderProbe["id"], model: string) {
  return JSON.stringify([provider, model]);
}

function runnableModels(provider: ProviderProbe) {
  return provider.canRun
    ? provider.models.filter((model) => model.status === "ready")
    : [];
}

export function firstRunnableSelection(
  providers: ProviderProbe[],
): IntelligenceSelection | null {
  for (const provider of providers) {
    const model = preferredProviderModel({ ...provider, models: runnableModels(provider) });
    if (model) return { provider: provider.id, model: model.id };
  }
  return null;
}

export default function EnginePicker({
  providers,
  value,
  onChange,
  label = "Intelligence engine",
  compact = false,
  disabled = false,
}: EnginePickerProps) {
  const groups = providers
    .map((provider) => ({ provider, models: runnableModels(provider) }))
    .filter((group) => group.models.length > 0);
  const fallback = firstRunnableSelection(providers);
  const selection = value && groups.some(({ provider, models }) => (
    provider.id === value.provider && models.some((model) => model.id === value.model)
  )) ? value : fallback;

  return (
    <label className={`engine-picker${compact ? " compact" : ""}`}>
      <Bot size={14} aria-hidden="true" />
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={selection ? optionValue(selection.provider, selection.model) : ""}
        disabled={!selection || disabled}
        onChange={(event) => {
          const [provider, model] = JSON.parse(event.target.value) as [ProviderProbe["id"], string];
          onChange({ provider, model });
        }}
      >
        {!selection && <option value="">Choose intelligence in Settings</option>}
        {groups.map(({ provider, models }) => (
          <optgroup key={provider.id} label={provider.label}>
            {models.map((model) => (
              <option key={model.id} value={optionValue(provider.id, model.id)}>
                {model.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <ChevronDown size={14} aria-hidden="true" />
    </label>
  );
}
