import {
  CheckCircle2,
  Cpu,
  Download,
  ExternalLink,
  HardDrive,
  KeyRound,
  LoaderCircle,
  LogIn,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import type {
  ApiKeyProviderId,
  LocalModelCandidate,
  LocalModelDiscovery,
  ProviderCredentialStatus,
  ProviderModel,
  ProviderProbe,
} from "../contracts";
import {
  onDeviceModelSetupAction,
  preferredOnDeviceSetupModel,
  preferredProviderModel,
} from "../bot-policy";

type ProviderAction = void | Promise<void>;

export interface ProviderCenterSetupState {
  runId?: string;
  message: string;
}

export interface ProviderCenterProps {
  providers: ProviderProbe[];
  credentials: ProviderCredentialStatus[];
  busyProviderId: ProviderProbe["id"] | null;
  apiKeyDrafts: Partial<Record<ApiKeyProviderId, string>>;
  onApiKeyDraftChange: (provider: ApiKeyProviderId, value: string) => void;
  onSaveApiKey: (provider: ApiKeyProviderId) => ProviderAction;
  onDeleteApiKey: (provider: ApiKeyProviderId) => ProviderAction;
  onSignIn: (provider: ProviderProbe["id"]) => ProviderAction;
  onOpenSetup: (provider: ProviderProbe["id"]) => ProviderAction;
  onSetupLocalModel: (model: ProviderModel) => ProviderAction;
  onDiscoverLocalModels: () => Promise<LocalModelDiscovery>;
  onOpenLocalModelPage: (modelId: string) => ProviderAction;
  onCancelLocalModelSetup: () => ProviderAction;
  setupState: ProviderCenterSetupState | null;
}

interface ApiProviderPresentation {
  id: ApiKeyProviderId;
  label: string;
  keyPlaceholder: string;
}

interface ManagedLocalSetup {
  label: string;
  model: ProviderModel;
}

type ProviderCenterView = "local" | "subscription" | "api";

const API_PROVIDERS: readonly ApiProviderPresentation[] = [
  { id: "openai", label: "OpenAI API", keyPlaceholder: "Paste OpenAI API key" },
  { id: "anthropic", label: "Anthropic API", keyPlaceholder: "Paste Anthropic API key" },
  { id: "gemini", label: "Gemini API", keyPlaceholder: "Paste Gemini API key" },
];

export function localProviderSummary(provider: ProviderProbe) {
  const model = preferredProviderModel(provider);
  if (provider.canRun && provider.health === "ready" && model?.local) {
    const offline = provider.capabilities.some((capability) => (
      capability === "offline" || capability === "offline-after-download"
    )) || model.capabilities.some((capability) => (
      capability === "offline" || capability === "offline-after-download"
    ));
    return offline
      ? "Verified local and ready offline."
      : "Verified local on this Mac.";
  }
  if (
    provider.health === "model-setup-required"
    || provider.health === "service-stopped"
    || provider.health === "missing"
    || (model && model.status !== "ready")
  ) {
    return `Setup needed. ${provider.detail}`;
  }
  return provider.detail;
}

export function managedLocalSetup(providers: ProviderProbe[]): ManagedLocalSetup | null {
  const mlx = providers.find((provider) => provider.id === "mlx");
  const model = mlx ? preferredOnDeviceSetupModel(mlx) : undefined;
  if (!model) return null;
  if (model.status === "partial") return { label: "Resume setup", model };
  if (model.status === "corrupt") return { label: "Repair on-device", model };
  if (model.status === "benchmark-required" || model.status === "incompatible") {
    return { label: "Check this Mac", model };
  }
  return {
    label: mlx?.canRun ? "Add capable model" : "Set up on-device",
    model,
  };
}

function ProviderBadge({ family }: { family: ProviderProbe["family"] }) {
  const label = family === "subscription"
    ? "Subscription"
    : family === "api" ? "Metered API" : "On this Mac";
  return <span className={`provider-center-badge ${family}`}>{label}</span>;
}

function ProviderReadiness({ provider }: { provider: ProviderProbe }) {
  return (
    <span
      className={`provider-center-readiness ${provider.canRun ? "ready" : "attention"}`}
      data-status={provider.status}
    >
      {provider.canRun ? <CheckCircle2 size={13} aria-hidden="true" /> : null}
      {provider.canRun ? "Ready" : provider.detail}
    </span>
  );
}

export function subscriptionProviderAction(provider: ProviderProbe) {
  if (provider.id === "copilot" && provider.health === "unchecked-auth") {
    return {
      label: "Sign in / switch",
      accessibleLabel: "Sign in to or switch GitHub Copilot account",
    };
  }
  const canStartSetup = !provider.canRun
    && provider.distribution !== "unsupported"
    && (provider.status === "signed-out" || provider.status === "not-installed");
  if (!canStartSetup) return null;
  return provider.status === "signed-out"
    ? { label: "Sign in", accessibleLabel: `Sign in to ${provider.label}` }
    : { label: "Set up", accessibleLabel: `Set up ${provider.label}` };
}

function SubscriptionProviderRow({
  provider,
  busy,
  onSignIn,
}: {
  provider: ProviderProbe;
  busy: boolean;
  onSignIn: ProviderCenterProps["onSignIn"];
}) {
  const action = subscriptionProviderAction(provider);

  return (
    <article className="provider-center-row subscription-provider" data-provider={provider.id}>
      <div className="provider-center-provider-copy">
        <div className="provider-center-provider-title">
          <strong>{provider.label}</strong>
          <ProviderBadge family="subscription" />
        </div>
        <ProviderReadiness provider={provider} />
      </div>
      {action ? (
        <button
          className="provider-center-action provider-sign-in-button"
          type="button"
          disabled={busy}
          onClick={() => void onSignIn(provider.id)}
          aria-label={action.accessibleLabel}
        >
          {busy
            ? <LoaderCircle className="provider-center-spinner" size={14} aria-hidden="true" />
            : <LogIn size={14} aria-hidden="true" />}
          {busy ? "Opening" : action.label}
        </button>
      ) : null}
    </article>
  );
}

function ApiKeyProviderRow({
  presentation,
  provider,
  credential,
  draft,
  busy,
  onDraftChange,
  onSave,
  onDelete,
}: {
  presentation: ApiProviderPresentation;
  provider?: ProviderProbe;
  credential?: ProviderCredentialStatus;
  draft: string;
  busy: boolean;
  onDraftChange: ProviderCenterProps["onApiKeyDraftChange"];
  onSave: ProviderCenterProps["onSaveApiKey"];
  onDelete: ProviderCenterProps["onDeleteApiKey"];
}) {
  const configured = credential?.configured === true;
  const available = credential?.available !== false;
  const inputId = `provider-center-${presentation.id}-key`;
  const descriptionId = `${inputId}-description`;

  return (
    <article className="provider-center-row api-provider" data-provider={presentation.id}>
      <div className="provider-center-provider-copy">
        <div className="provider-center-provider-title">
          <strong>{provider?.label || presentation.label}</strong>
          <ProviderBadge family="api" />
        </div>
        <span className={`provider-center-readiness ${configured && available ? "ready" : "attention"}`}>
          {configured ? <CheckCircle2 size={13} aria-hidden="true" /> : <KeyRound size={13} aria-hidden="true" />}
          {!available ? "Keychain unavailable" : configured ? "Key stored in macOS Keychain" : "No key stored"}
        </span>
      </div>
      <form
        className="provider-center-key-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave(presentation.id);
        }}
      >
        <label className="sr-only" htmlFor={inputId}>{presentation.label} API key</label>
        <input
          id={inputId}
          name={`${presentation.id}-api-key`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          placeholder={configured ? "Paste a replacement key" : presentation.keyPlaceholder}
          aria-describedby={descriptionId}
          disabled={busy || !available}
          onChange={(event) => onDraftChange(presentation.id, event.target.value)}
        />
        <button
          className="provider-center-action provider-key-save"
          type="submit"
          disabled={busy || !available || draft.trim().length === 0}
        >
          {busy ? <LoaderCircle className="provider-center-spinner" size={14} aria-hidden="true" /> : null}
          {busy ? "Saving" : configured ? "Replace key" : "Save key"}
        </button>
        {configured ? (
          <button
            className="provider-center-action provider-key-remove"
            type="button"
            disabled={busy || !available}
            onClick={() => void onDelete(presentation.id)}
            aria-label={`Remove ${presentation.label} key from Keychain`}
            title="Remove key"
          >
            <Trash2 size={14} aria-hidden="true" />
            <span className="sr-only">Remove key</span>
          </button>
        ) : null}
      </form>
      <p id={descriptionId} className="provider-center-boundary">
        {available
          ? <>Stored in Keychain. Requests are metered by {presentation.label}; this engine never enters Auto silently.</>
          : credential?.detail || "Codelit could not access macOS Keychain. Other providers remain available."}
      </p>
    </article>
  );
}

function formatBytes(bytes?: number) {
  if (!bytes) return "Size unavailable";
  const gib = bytes / (1024 ** 3);
  return gib >= 1 ? `${gib.toFixed(gib >= 10 ? 0 : 1)} GB` : `${Math.ceil(bytes / (1024 ** 2))} MB`;
}

function candidateDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Recently updated"
    : `Updated ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date)}`;
}

function modelStatus(model: ProviderModel) {
  if (model.status === "ready") return "Ready";
  if (model.status === "download-required") return "Not installed";
  if (model.status === "partial") return "Setup paused";
  if (model.status === "corrupt") return "Repair needed";
  if (model.status === "benchmark-required") return "Needs a device check";
  return "Does not fit this Mac";
}

function ManagedMlxProvider({
  provider,
  setupState,
  onSetup,
}: {
  provider: ProviderProbe;
  setupState: ProviderCenterSetupState | null;
  onSetup: ProviderCenterProps["onSetupLocalModel"];
}) {
  const models = [...provider.models].sort((left, right) => (
    Number(right.recommended) - Number(left.recommended)
    || (left.downloadBytes || 0) - (right.downloadBytes || 0)
  ));

  return (
    <div className="provider-center-managed" data-provider={provider.id}>
      <div className="provider-center-managed-heading">
        <div className="provider-center-provider-copy">
          <div className="provider-center-provider-title">
            <strong>{provider.label}</strong>
            <ProviderBadge family="local" />
          </div>
          <span className={`provider-center-readiness ${provider.canRun ? "ready" : "attention"}`}>
            {provider.canRun ? <CheckCircle2 size={13} aria-hidden="true" /> : <Cpu size={13} aria-hidden="true" />}
            {provider.canRun ? "At least one verified model is ready." : "Choose a verified model for this Mac."}
          </span>
        </div>
      </div>
      <div className="provider-center-model-list">
        {models.length > 0 ? models.map((model) => {
          const action = onDeviceModelSetupAction(model);
          return (
            <article className="provider-center-model-row" key={model.id} data-model-status={model.status}>
              <div className="provider-center-model-copy">
                <div className="provider-center-model-title">
                  <strong>{model.label}</strong>
                  {model.recommended ? <span className="provider-center-model-tag">Best match</span> : null}
                  {model.status === "ready" ? <span className="provider-center-model-tag ready">Ready</span> : null}
                </div>
                <span>{formatBytes(model.downloadBytes)} · {model.license || "License unavailable"}</span>
                <p>{model.detail}</p>
              </div>
              {action ? (
                <button
                  className="provider-center-action provider-local-setup"
                  type="button"
                  disabled={setupState !== null}
                  onClick={() => void onSetup(model)}
                  aria-label={`${action.label} ${model.label}`}
                >
                  {setupState
                    ? <LoaderCircle className="provider-center-spinner" size={14} aria-hidden="true" />
                    : action.action === "benchmark"
                      ? <Cpu size={14} aria-hidden="true" />
                      : action.action === "update"
                        ? <RefreshCw size={14} aria-hidden="true" />
                        : <Download size={14} aria-hidden="true" />}
                  {action.label}
                </button>
              ) : (
                <span className={`provider-center-model-state ${model.status}`}>{modelStatus(model)}</span>
              )}
            </article>
          );
        }) : <p className="provider-center-empty">Verified model choices appear in the native app.</p>}
      </div>
    </div>
  );
}

function LocalProviderRow({
  provider,
  busy,
  onOpenSetup,
}: {
  provider: ProviderProbe;
  busy: boolean;
  onOpenSetup: ProviderCenterProps["onOpenSetup"];
}) {
  const model = preferredProviderModel(provider);
  const canOpenSetup = !provider.canRun
    && provider.distribution !== "unsupported"
    && (
      provider.status === "not-installed"
      || provider.health === "service-stopped"
      || provider.health === "model-setup-required"
    );

  return (
    <article className="provider-center-row local-provider" data-provider={provider.id}>
      <div className="provider-center-provider-copy">
        <div className="provider-center-provider-title">
          <strong>{provider.label}</strong>
          <ProviderBadge family="local" />
        </div>
        <span className={`provider-center-readiness ${provider.canRun ? "ready" : "attention"}`}>
          {provider.canRun ? <CheckCircle2 size={13} aria-hidden="true" /> : <Cpu size={13} aria-hidden="true" />}
          {model ? `${model.label} · ` : ""}{localProviderSummary(provider)}
        </span>
      </div>
      {canOpenSetup ? (
        <button
          className="provider-center-action provider-local-setup"
          type="button"
          disabled={busy}
          onClick={() => void onOpenSetup(provider.id)}
          aria-label={`Open the official ${provider.label} setup guide`}
        >
          {busy
            ? <LoaderCircle className="provider-center-spinner" size={14} aria-hidden="true" />
            : <Download size={14} aria-hidden="true" />}
          {busy ? "Opening" : "Setup guide"}
        </button>
      ) : null}
    </article>
  );
}

function LiveModelCandidate({
  candidate,
  onOpen,
}: {
  candidate: LocalModelCandidate;
  onOpen: ProviderCenterProps["onOpenLocalModelPage"];
}) {
  const fitLabel = candidate.fit === "fits"
    ? "Fits this Mac"
    : candidate.fit === "memory" ? "Needs more memory" : "Needs more space";
  return (
    <article className="provider-center-candidate">
      <div className="provider-center-model-copy">
        <div className="provider-center-model-title">
          <strong>{candidate.label}</strong>
          <span className={`provider-center-model-tag ${candidate.fit}`}>{fitLabel}</span>
        </div>
        <span>{formatBytes(candidate.downloadBytes)} · {candidate.license} · {candidateDate(candidate.lastModified)}</span>
        <p>{candidate.detail}</p>
      </div>
      <button
        className="provider-center-action"
        type="button"
        onClick={() => void onOpen(candidate.id)}
        aria-label={`Review ${candidate.label} on Hugging Face`}
      >
        <ExternalLink size={14} aria-hidden="true" />
        Review
      </button>
    </article>
  );
}

export default function ProviderCenter({
  providers,
  credentials,
  busyProviderId,
  apiKeyDrafts,
  onApiKeyDraftChange,
  onSaveApiKey,
  onDeleteApiKey,
  onSignIn,
  onOpenSetup,
  onSetupLocalModel,
  onDiscoverLocalModels,
  onOpenLocalModelPage,
  onCancelLocalModelSetup,
  setupState,
}: ProviderCenterProps) {
  const [view, setView] = useState<ProviderCenterView>("local");
  const [discovery, setDiscovery] = useState<LocalModelDiscovery | null>(null);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const subscriptions = providers.filter((provider) => provider.family === "subscription");
  const localProviders = providers.filter((provider) => provider.family === "local");
  const mlxProvider = localProviders.find((provider) => provider.id === "mlx");
  const externalLocalProviders = localProviders.filter((provider) => provider.id !== "mlx");

  const discoverModels = async () => {
    if (discoveryBusy) return;
    setDiscoveryBusy(true);
    setDiscoveryError(null);
    try {
      setDiscovery(await onDiscoverLocalModels());
    } catch (reason) {
      setDiscoveryError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDiscoveryBusy(false);
    }
  };

  return (
    <div className="provider-center" aria-label="Provider Center">
      <header className="provider-center-header">
        <div>
          <span className="provider-center-eyebrow">Intelligence</span>
          <h3>Models & providers</h3>
        </div>
        <p>Choose one way to power your bots. You can change it anytime.</p>
      </header>

      <div className="provider-center-tabs" role="tablist" aria-label="Provider type">
        <button
          id="provider-center-local-tab"
          type="button"
          role="tab"
          aria-selected={view === "local"}
          aria-controls="provider-center-local-panel"
          className={view === "local" ? "selected" : undefined}
          onClick={() => setView("local")}
        >
          <Cpu size={14} aria-hidden="true" /> On this Mac
        </button>
        <button
          id="provider-center-subscription-tab"
          type="button"
          role="tab"
          aria-selected={view === "subscription"}
          aria-controls="provider-center-subscription-panel"
          className={view === "subscription" ? "selected" : undefined}
          onClick={() => setView("subscription")}
        >
          <LogIn size={14} aria-hidden="true" /> Subscriptions
        </button>
        <button
          id="provider-center-api-tab"
          type="button"
          role="tab"
          aria-selected={view === "api"}
          aria-controls="provider-center-api-panel"
          className={view === "api" ? "selected" : undefined}
          onClick={() => setView("api")}
        >
          <KeyRound size={14} aria-hidden="true" /> API keys
        </button>
      </div>

      {view === "local" ? (
        <section
          id="provider-center-local-panel"
          className="provider-center-section"
          role="tabpanel"
          aria-labelledby="provider-center-local-tab provider-center-local"
        >
          <div className="provider-center-section-heading">
            <div>
              <h4 id="provider-center-local">On this Mac</h4>
              <p>Private local models can work offline after setup.</p>
            </div>
            <ProviderBadge family="local" />
          </div>
          {setupState ? (
            <div className="provider-center-setup-progress" role="status" aria-live="polite">
              <LoaderCircle className="provider-center-spinner" size={15} aria-hidden="true" />
              <span>{setupState.message}</span>
              {setupState.runId ? (
                <button
                  className="provider-center-action provider-local-cancel"
                  type="button"
                  onClick={() => void onCancelLocalModelSetup()}
                >
                  Cancel
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="provider-center-list">
            {mlxProvider ? (
              <ManagedMlxProvider
                provider={mlxProvider}
                setupState={setupState}
                onSetup={onSetupLocalModel}
              />
            ) : null}
            {externalLocalProviders.map((provider) => (
              <LocalProviderRow
                key={provider.id}
                provider={provider}
                busy={busyProviderId === provider.id}
                onOpenSetup={onOpenSetup}
              />
            ))}
            {localProviders.length === 0 ? (
              <p className="provider-center-empty">No on-device provider is available in this build.</p>
            ) : null}
          </div>
          <div className="provider-center-discovery">
            <div className="provider-center-discovery-heading">
              <div>
                <strong>New local models</strong>
                <p>Check recent MLX models against this Mac. Nothing downloads automatically.</p>
              </div>
              <button
                className="provider-center-action"
                type="button"
                disabled={discoveryBusy || setupState !== null}
                onClick={() => void discoverModels()}
              >
                {discoveryBusy
                  ? <LoaderCircle className="provider-center-spinner" size={14} aria-hidden="true" />
                  : <RefreshCw size={14} aria-hidden="true" />}
                {discoveryBusy ? "Checking" : discovery ? "Check again" : "Check new models"}
              </button>
            </div>
            {discoveryError ? <p className="provider-center-discovery-error" role="alert">{discoveryError}</p> : null}
            {discovery ? (
              <div className="provider-center-candidate-list">
                <div className="provider-center-machine-fit">
                  <HardDrive size={14} aria-hidden="true" />
                  <span>{formatBytes(discovery.memoryBytes)} memory · {formatBytes(discovery.freeDiskBytes)} free</span>
                </div>
                {discovery.candidates.length > 0 ? discovery.candidates.map((candidate) => (
                  <LiveModelCandidate
                    key={`${candidate.id}@${candidate.revision}`}
                    candidate={candidate}
                    onOpen={onOpenLocalModelPage}
                  />
                )) : <p className="provider-center-empty">No recent compatible models passed Codelit’s safety filters.</p>}
                <p className="provider-center-discovery-boundary">
                  Discovery only. Codelit will not install or run these models until they pass release verification.
                </p>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {view === "subscription" ? (
        <section
          id="provider-center-subscription-panel"
          className="provider-center-section"
          role="tabpanel"
          aria-labelledby="provider-center-subscription-tab provider-center-subscriptions"
        >
          <div className="provider-center-section-heading">
            <div>
              <h4 id="provider-center-subscriptions">Subscriptions</h4>
              <p>Use provider-owned sign-in and your existing allowance.</p>
            </div>
            <ProviderBadge family="subscription" />
          </div>
          <div className="provider-center-list">
            {subscriptions.length > 0 ? subscriptions.map((provider) => (
              <SubscriptionProviderRow
                key={provider.id}
                provider={provider}
                busy={busyProviderId === provider.id}
                onSignIn={onSignIn}
              />
            )) : (
              <p className="provider-center-empty">No subscription provider is available in this build.</p>
            )}
          </div>
        </section>
      ) : null}

      {view === "api" ? (
        <section
          id="provider-center-api-panel"
          className="provider-center-section"
          role="tabpanel"
          aria-labelledby="provider-center-api-tab provider-center-api-keys"
        >
          <div className="provider-center-section-heading">
            <div>
              <h4 id="provider-center-api-keys">API keys</h4>
              <p>Metered engines stay out of Auto unless you explicitly enable connected AI.</p>
            </div>
            <ProviderBadge family="api" />
          </div>
          <div className="provider-center-list">
            {API_PROVIDERS.map((presentation) => (
              <ApiKeyProviderRow
                key={presentation.id}
                presentation={presentation}
                provider={providers.find((candidate) => candidate.id === presentation.id)}
                credential={credentials.find((candidate) => candidate.provider === presentation.id)}
                draft={apiKeyDrafts[presentation.id] || ""}
                busy={busyProviderId === presentation.id}
                onDraftChange={onApiKeyDraftChange}
                onSave={onSaveApiKey}
                onDelete={onDeleteApiKey}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
