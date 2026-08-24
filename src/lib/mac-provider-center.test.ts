import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  localProviderSummary,
  managedLocalSetup,
  subscriptionProviderAction,
} from "../../apps/mac/src/components/ProviderCenter";
import type { ProviderModel, ProviderProbe } from "../../apps/mac/src/contracts";

const source = readFileSync(
  new URL("../../apps/mac/src/components/ProviderCenter.tsx", import.meta.url),
  "utf8",
);

function model(
  status: ProviderModel["status"],
  capabilities: string[] = ["structured-output"],
): ProviderModel {
  return {
    id: "test-model",
    label: "Test model",
    status,
    capabilities,
    local: true,
    recommended: true,
    detail: "Test model detail.",
  };
}

function localProvider(
  status: ProviderModel["status"],
  capabilities: string[] = ["structured-output"],
): ProviderProbe {
  const ready = status === "ready";
  return {
    id: "mlx",
    label: "Built-in MLX",
    family: "local",
    authKind: "none",
    billingMode: "local",
    distribution: "all",
    status: ready ? "ready" : "not-installed",
    health: ready ? "ready" : "model-setup-required",
    canRun: ready,
    capabilities,
    models: [model(status, capabilities)],
    quota: { state: "not-applicable", detail: "Runs locally." },
    detail: ready ? "Ready." : "Download the managed model.",
  };
}

describe("Mac Provider Center", () => {
  it("separates subscription, metered API, and local choices behind focused tabs", () => {
    expect(source).toContain(">Subscriptions</h4>");
    expect(source).toContain(">API keys</h4>");
    expect(source).toContain(">On this Mac</h4>");
    expect(source).toContain('role="tablist"');
    expect(source).toContain('role="tab"');
    expect(source).toContain('role="tabpanel"');
    expect(source).toContain('useState<ProviderCenterView>("local")');
    expect(source).toContain('aria-selected={view === "local"}');
    expect(source).toContain('view === "subscription" ?');
    expect(source).toContain('view === "api" ?');
    expect(source).toContain('family === "subscription"');
    expect(source).toContain('family === "api"');
    expect(source).toContain('family === "local"');
    expect(source).toContain('"Subscription"');
    expect(source).toContain('"Metered API"');
    expect(source).toContain('"On this Mac"');
  });

  it("keeps API key entry masked and explains storage and billing boundaries", () => {
    expect(source).toContain('type="password"');
    expect(source).toContain('autoComplete="off"');
    expect(source).toContain("Key stored in macOS Keychain");
    expect(source).toContain("Stored in Keychain.");
    expect(source).toContain("Requests are metered");
    expect(source).toContain("this engine never enters Auto silently");
    expect(source).not.toContain("Show key");
    expect(source).toContain("Keychain unavailable");
    expect(source).toContain("disabled={busy || !available}");
  });

  it("keeps Copilot sign-in and account switching reachable after installation", () => {
    const copilot: ProviderProbe = {
      id: "copilot",
      label: "GitHub Copilot",
      family: "subscription",
      authKind: "provider-owned",
      billingMode: "subscription",
      distribution: "direct-only",
      status: "ready",
      health: "unchecked-auth",
      canRun: true,
      capabilities: ["structured-output"],
      models: [model("ready")],
      quota: { state: "unknown", detail: "Checked when a run starts." },
      detail: "Installed.",
    };
    expect(subscriptionProviderAction(copilot)).toEqual({
      label: "Sign in / switch",
      accessibleLabel: "Sign in to or switch GitHub Copilot account",
    });
  });

  it("offers each supported API-key provider without treating a key as a subscription", () => {
    expect(source).toContain('{ id: "openai", label: "OpenAI API"');
    expect(source).toContain('{ id: "anthropic", label: "Anthropic API"');
    expect(source).toContain('{ id: "gemini", label: "Gemini API"');
    expect(source).toContain("Metered engines stay out of Auto unless you explicitly enable connected AI.");
  });

  it("distinguishes verified offline models from setup-needed models", () => {
    expect(localProviderSummary(localProvider("ready", ["structured-output", "offline"])))
      .toBe("Verified local and ready offline.");
    expect(localProviderSummary(localProvider("download-required")))
      .toBe("Setup needed. Download the managed model.");
  });

  it("maps each managed local model state to one clear action", () => {
    expect(managedLocalSetup([localProvider("download-required")])?.label).toBe("Set up on-device");
    expect(managedLocalSetup([localProvider("partial")])?.label).toBe("Resume setup");
    expect(managedLocalSetup([localProvider("corrupt")])?.label).toBe("Repair on-device");
    expect(managedLocalSetup([localProvider("benchmark-required")])?.label).toBe("Check this Mac");
    expect(managedLocalSetup([localProvider("ready")])).toBeNull();
  });

  it("offers one capable-model upgrade after the lightweight local model is ready", () => {
    const provider = localProvider("ready");
    provider.models = [
      { ...provider.models[0], id: "quick", downloadBytes: 350_000_000 },
      { ...model("download-required"), id: "capable", downloadBytes: 4_600_000_000 },
    ];
    expect(managedLocalSetup([provider])).toMatchObject({
      label: "Add capable model",
      model: { id: "capable" },
    });
  });

  it("uses native semantic controls and exposes cancellable setup progress", () => {
    expect(source).toContain('type="submit"');
    expect(source).toContain('type="button"');
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("onCancelLocalModelSetup");
    expect(source).toContain("onSignIn(provider.id)");
  });

  it("makes verified setup explicit and keeps live discovery review-only", () => {
    expect(source).toContain("onDeviceModelSetupAction(model)");
    expect(source).toContain("onSetup(model)");
    expect(source).toContain("Check new models");
    expect(source).toContain("Nothing downloads automatically");
    expect(source).toContain("Fits this Mac");
    expect(source).toContain("Codelit will not install or run these models until they pass release verification");
    expect(source).toContain("onOpen(candidate.id)");
  });
});
