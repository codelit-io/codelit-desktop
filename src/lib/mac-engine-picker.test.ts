import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import EnginePicker from "../../apps/mac/src/components/EnginePicker";
import type { IntelligenceSelection, ProviderProbe } from "../../apps/mac/src/contracts";

const provider: ProviderProbe = {
  id: "openai",
  label: "OpenAI API",
  family: "api",
  authKind: "api-key",
  billingMode: "metered",
  distribution: "all",
  status: "ready",
  health: "ready",
  canRun: true,
  capabilities: [],
  models: [{
    id: "ready-model",
    label: "Ready API model",
    status: "ready",
    capabilities: [],
    local: false,
    recommended: true,
    detail: "Ready to use.",
  }],
  quota: { state: "unknown", detail: "Billed by provider." },
  detail: "Key configured.",
};

function render(value: IntelligenceSelection | null, providers = [provider]) {
  return renderToStaticMarkup(createElement(EnginePicker, { providers, value, onChange: () => undefined }));
}

describe("Mac engine selection", () => {
  it("offers an actionable setup button when no engines are ready", () => {
    const html = renderToStaticMarkup(createElement(EnginePicker, {
      providers: [], value: null, onChange: () => undefined, onSetup: () => undefined,
    }));
    expect(html).toContain("Set up intelligence");
    expect(html).toContain('<button type="button"');
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("<select");
  });
  it("requires an explicit selection when only a metered engine is ready outside Auto", () => {
    const html = render(null);
    expect(html).toContain('<option value="" disabled="" selected="">Choose an engine</option>');
    expect(html).not.toMatch(/<select[^>]*disabled/);
    expect(html).not.toMatch(/<option[^>]*selected[^>]*>Ready API model/);
  });

  it("does not claim a different engine is selected when the fixed engine becomes unavailable", () => {
    const html = render({ provider: "mlx", model: "missing-local-model" });
    expect(html).toContain('<option value="" disabled="" selected="">Choose an engine</option>');
    expect(html).not.toMatch(/<option[^>]*selected[^>]*>Ready API model/);
  });

  it("renders the saved ready engine and disables only an empty provider list", () => {
    expect(render({ provider: "openai", model: "ready-model" }))
      .toMatch(/<option[^>]*selected=""[^>]*>Ready API model/);
    const unavailable = render(null, []);
    expect(unavailable).toMatch(/<select[^>]*disabled=""/);
    expect(unavailable).toContain("No engines ready. Open Intelligence settings");
  });
});
