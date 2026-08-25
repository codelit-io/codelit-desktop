import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BOT_CAPABILITY_MANIFESTS,
  BOTS_P1_BETA_POLICY,
  botBrowserAutoApprovalSource,
  botBrowserDomainMatches,
  botProvidersForChannel,
  isBotBrowserSessionOpen,
  onDeviceModelSetupAction,
  onDeviceSetupAction,
  parseBotBrowserAction,
  parseBotBrowserTarget,
  preferredOnDeviceSetupModel,
  preferredProviderModel,
  selectBotEngine,
  shouldAutoApproveBotAction,
} from "../../apps/mac/src/bot-policy";
import type { BotPermissionPolicy, LocalBrowserSession, ProviderModel, ProviderProbe } from "../../apps/mac/src/contracts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const modelManifest = JSON.parse(read("../../apps/mac/native/mlx-helper/model-manifest.json"));
const botsApp = read("../../apps/mac/src/BotsApp.tsx");
const localBrowser = read("../../apps/mac/src-tauri/src/local_browser.rs");
const releaseSupport = read("../../apps/mac/scripts/release-support.mjs");

function model(status: ProviderModel["status"] = "ready"): ProviderModel {
  return {
    id: "default",
    label: "Default",
    status,
    capabilities: ["structured-output"],
    local: true,
    recommended: true,
    detail: "Test model",
  };
}

function provider(
  id: ProviderProbe["id"],
  status: ProviderModel["status"] = "ready",
): ProviderProbe {
  return {
    id,
    label: id,
    family: ["codex", "copilot", "claude", "antigravity"].includes(id)
      ? "subscription"
      : ["openai", "anthropic", "gemini"].includes(id) ? "api" : "local",
    distribution: id === "mlx" ? "all" : id === "antigravity" ? "unsupported" : "direct-only",
    status: status === "ready" ? "ready" : "not-installed",
    health: status === "ready" ? "ready" : "model-setup-required",
    canRun: status === "ready",
    capabilities: ["structured-output"],
    models: [model(status)],
    quota: { state: "not-applicable", detail: "Test quota" },
    detail: "Test provider",
  };
}

function browserSession(status: string, visible = true): LocalBrowserSession {
  return {
    sessionId: "browser-run-1",
    projectId: "project-1",
    status,
    visible,
    currentUrl: "https://codelit.io/",
    allowedDomains: ["codelit.io"],
    downloadArmed: false,
    events: [],
  };
}

describe("Codelit Bots provider policy", () => {
  it("locks the P1 beta product and release decisions to one checked contract", () => {
    expect(BOTS_P1_BETA_POLICY).toMatchObject({
      releaseArchitecture: "arm64",
      releaseTarget: "aarch64-apple-darwin",
      browserDataStore: "isolated-app-owned-per-bot",
      legacyWorkAccess: "export-only",
    });
    expect(BOTS_P1_BETA_POLICY.bundledModel).toEqual({
      id: modelManifest.models[0].id,
      revision: modelManifest.models[0].revision,
      releaseValidatedMemoryGiB: modelManifest.models[0].releaseValidatedMemoryGiB,
    });
    expect(BOTS_P1_BETA_POLICY.starterTasks).toHaveLength(3);
    expect(parseBotBrowserTarget(BOTS_P1_BETA_POLICY.starterTasks[0])).toMatchObject({
      kind: "target",
      host: "codelit.io",
    });
    expect(botsApp).toContain('lazy(() => import("./components/BotOutcomeActions"))');
    expect(botsApp).toContain("Export all local data");
    expect(botsApp).toContain("Delete local workspace");
    expect(botsApp).toContain("await deleteLocalWorkspace(deleteWorkspaceConfirmation)");
    expect(botsApp).toContain('deleteWorkspaceConfirmation !== "DELETE" || deletingWorkspace || !isNativeRuntime()');
    expect(localBrowser).toContain(".data_store_identifier(project_data_store_identifier(&request.project_id))");
    expect(localBrowser).toContain('codelit-project-browser-v1:{project_id}');
    expect(releaseSupport).toContain("botsP1BetaPolicy.releaseArchitecture");
    expect(releaseSupport).toContain("botsP1BetaPolicy.releaseTarget");
  });

  it("publishes distinct Direct and App Store capability manifests", () => {
    expect(BOT_CAPABILITY_MANIFESTS.direct.providerIds).toEqual([
      "mlx", "codex", "copilot", "antigravity", "ollama", "lmstudio",
      "openai", "anthropic", "gemini",
    ]);
    expect(BOT_CAPABILITY_MANIFESTS["app-store"].providerIds).toEqual([
      "mlx", "openai", "anthropic", "gemini",
    ]);
    expect(BOT_CAPABILITY_MANIFESTS.direct.managedBrowserRead).toBe(true);
    expect(BOT_CAPABILITY_MANIFESTS.direct.computerUse).toBe(true);
    expect(BOT_CAPABILITY_MANIFESTS.direct.scheduledRoutines).toBe(true);
    expect(BOT_CAPABILITY_MANIFESTS["app-store"].managedBrowserRead).toBe(false);
    expect(BOT_CAPABILITY_MANIFESTS["app-store"].computerUse).toBe(false);
    expect(BOT_CAPABILITY_MANIFESTS["app-store"].scheduledRoutines).toBe(false);
    expect(BOT_CAPABILITY_MANIFESTS.development.scheduledRoutines).toBe(true);
    expect(BOT_CAPABILITY_MANIFESTS.development.computerUse).toBe(true);
  });

  it("prefers the more capable verified MLX model without changing other provider ordering", () => {
    const quick = { ...model(), id: "quick", downloadBytes: 350_000_000 };
    const capable = { ...model(), id: "capable", downloadBytes: 4_600_000_000 };
    expect(preferredProviderModel({ ...provider("mlx"), models: [quick, capable] })?.id)
      .toBe("capable");
    expect(preferredProviderModel({ ...provider("ollama"), models: [quick, capable] })?.id)
      .toBe("quick");
  });

  it("offers a larger compatible MLX model without displacing a ready fallback", () => {
    const quick = { ...model(), id: "quick", downloadBytes: 350_000_000 };
    const capable = {
      ...model("download-required"),
      id: "capable",
      downloadBytes: 4_600_000_000,
    };
    const mlx = { ...provider("mlx"), models: [quick, capable] };
    expect(preferredProviderModel(mlx)?.id).toBe("quick");
    expect(preferredOnDeviceSetupModel(mlx)?.id).toBe("capable");
    expect(onDeviceSetupAction([mlx], "development")).toMatchObject({
      model: { id: "capable" },
      label: "Install",
    });
  });

  it("keeps channel-specific engines, browser reads, and routines closed until native identity is known", () => {
    expect(botsApp).toContain('useState<BotBuildChannel>("app-store")');
    expect(botsApp).toContain("const [buildChannelReady, setBuildChannelReady] = useState(false)");
    expect(botsApp).toContain("const schedulesAvailable = buildChannelReady");
    expect(botsApp).toContain("const browserReadAvailable = buildChannelReady");
    expect(botsApp).toContain("bot && buildChannelReady");
    expect(botsApp).toContain("setBuildChannelReady(true)");
  });

  it("never exposes a provider outside the compiled channel manifest", () => {
    const probes = [
      provider("codex"), provider("copilot"), provider("claude"), provider("antigravity"),
      provider("openai"), provider("ollama"), provider("mlx"),
    ];
    expect(botProvidersForChannel(probes, "direct").map((candidate) => candidate.id)).toEqual([
      "codex",
      "copilot",
      "antigravity",
      "openai",
      "ollama",
      "mlx",
    ]);
    expect(botProvidersForChannel(probes, "app-store").map((candidate) => candidate.id)).toEqual([
      "openai", "mlx",
    ]);
  });

  it("keeps Auto on a ready eligible engine with no unsupported fallback", () => {
    expect(selectBotEngine([provider("claude")], "direct")).toBeNull();
    expect(selectBotEngine([provider("codex"), provider("mlx")], "direct")).toEqual({
      provider: "codex",
      model: "default",
    });
    expect(selectBotEngine([provider("codex"), provider("mlx", "download-required")], "direct")).toEqual({
      provider: "codex",
      model: "default",
    });
    expect(selectBotEngine([provider("codex"), provider("mlx")], "app-store")).toEqual({
      provider: "mlx",
      model: "default",
    });
    expect(selectBotEngine([provider("openai"), provider("mlx")], "direct", {
      mode: "auto",
      allowedProviders: ["openai", "mlx"],
      allowMeteredFallback: false,
    })).toEqual({ provider: "mlx", model: "default" });
    expect(selectBotEngine([provider("openai"), provider("mlx")], "direct", {
      mode: "auto",
      allowedProviders: ["openai", "mlx"],
      allowMeteredFallback: true,
    })).toEqual({ provider: "openai", model: "default" });
    expect(selectBotEngine([provider("openai"), provider("mlx", "download-required")], "direct", {
      mode: "auto",
      allowedProviders: ["openai", "mlx"],
      allowMeteredFallback: true,
    })).toEqual({ provider: "openai", model: "default" });
    expect(selectBotEngine([provider("codex"), provider("openai")], "direct", {
      mode: "fixed",
      allowedProviders: ["codex", "openai"],
      fixedEngine: { provider: "openai", model: "default" },
      allowMeteredFallback: false,
    })).toEqual({ provider: "openai", model: "default" });
  });

  it("turns every managed MLX setup state into one clear next action", () => {
    expect(onDeviceSetupAction([provider("mlx", "download-required")], "direct")?.action).toBe("download");
    expect(onDeviceSetupAction([provider("mlx", "partial")], "direct")?.action).toBe("resume");
    expect(onDeviceSetupAction([provider("mlx", "corrupt")], "direct")?.action).toBe("update");
    expect(onDeviceSetupAction([provider("mlx", "benchmark-required")], "direct")?.action).toBe("benchmark");
    expect(onDeviceModelSetupAction(model("ready"))).toBeNull();
    expect(onDeviceModelSetupAction(model("download-required"))?.label).toBe("Install");
    expect(onDeviceModelSetupAction(model("partial"))?.label).toBe("Resume");
    expect(onDeviceModelSetupAction(model("corrupt"))?.label).toBe("Repair");
    expect(onDeviceModelSetupAction(model("incompatible"))).toBeNull();
    expect(onDeviceModelSetupAction({
      ...model("incompatible"),
      installedBytes: 512,
    })?.label).toBe("Recheck");
  });

  it("extracts one safe public or localhost browser target from chat", () => {
    expect(parseBotBrowserTarget("Inspect codelit.io/pricing and summarize it.")).toEqual({
      kind: "target",
      url: "https://codelit.io/pricing",
      host: "codelit.io",
    });
    expect(parseBotBrowserTarget("Check http://localhost:3108/health")).toEqual({
      kind: "target",
      url: "http://localhost:3108/health",
      host: "localhost",
    });
    expect(parseBotBrowserTarget("Help me plan a release.")).toEqual({ kind: "none" });
    expect(parseBotBrowserTarget("Read http://example.com")).toMatchObject({ kind: "invalid" });
    expect(parseBotBrowserTarget("Read https://user:secret@example.com")).toMatchObject({ kind: "invalid" });
  });

  it("requires one quoted and human-readable browser action from chat", () => {
    expect(parseBotBrowserAction('Click "Pricing" on https://codelit.io')).toEqual({
      kind: "action",
      request: {
        url: "https://codelit.io/",
        host: "codelit.io",
        action: "click",
        target: "label:Pricing",
        targetLabel: "Pricing",
        valueLength: 0,
      },
    });
    expect(parseBotBrowserAction('Type \u201crelease ready\u201d into \u201cSearch\u201d on https://codelit.io/docs')).toEqual({
      kind: "action",
      request: {
        url: "https://codelit.io/docs",
        host: "codelit.io",
        action: "type",
        target: "label:Search",
        targetLabel: "Search",
        value: "release ready",
        valueLength: 13,
      },
    });
    expect(parseBotBrowserAction('Download "Release report" from https://codelit.io/releases')).toEqual({
      kind: "action",
      request: {
        url: "https://codelit.io/releases",
        host: "codelit.io",
        action: "download",
        target: "label:Release report",
        targetLabel: "Release report",
        valueLength: 0,
      },
    });
    expect(parseBotBrowserAction("Click Pricing on https://codelit.io")).toMatchObject({
      kind: "action",
      request: { action: "click", targetLabel: "Pricing" },
    });
    expect(parseBotBrowserAction('Click the "Pricing" button on https://codelit.io')).toMatchObject({
      kind: "action",
      request: { action: "click", targetLabel: "Pricing" },
    });
    expect(parseBotBrowserAction("Click New Tab in Safari")).toEqual({ kind: "none" });
    expect(parseBotBrowserAction("Inspect https://codelit.io")).toEqual({ kind: "none" });
  });

  it("auto-approves only the managed read-only browser capability", () => {
    const policy: BotPermissionPolicy = {
      approvalMode: "safe-auto",
      browserDomains: [],
      projectAccess: "ask",
      browserAccess: "ask",
      writeActions: "always-ask",
      computerUse: "ask",
    };
    const publicPage = { url: "https://codelit.io/pricing", host: "codelit.io" };
    expect(shouldAutoApproveBotAction(policy, "browser-read", publicPage)).toBe(true);
    for (const action of [
      "browser-interact",
      "computer-use",
      "download",
      "external-write",
      "project-write",
    ] as const) {
      expect(shouldAutoApproveBotAction(policy, action, publicPage)).toBe(false);
    }
    expect(shouldAutoApproveBotAction({ ...policy, approvalMode: "ask" }, "browser-read", publicPage)).toBe(false);
    expect(shouldAutoApproveBotAction({ ...policy, browserAccess: "disabled" }, "browser-read", publicPage)).toBe(false);
    expect(shouldAutoApproveBotAction(policy, "browser-read", {
      url: "https://accounts.example.com/login",
      host: "accounts.example.com",
    })).toBe(false);
    expect(shouldAutoApproveBotAction(policy, "browser-read", {
      url: "https://example.com/report?token=private",
      host: "example.com",
    })).toBe(false);
    expect(shouldAutoApproveBotAction(policy, "browser-read", {
      url: "http://localhost:3108/health",
      host: "localhost",
    })).toBe(false);
    expect(shouldAutoApproveBotAction(policy, "browser-read", {
      url: "https://login.example.com/",
      host: "example.com",
    })).toBe(false);
  });

  it("scopes persistent browser reads to one bot domain without weakening sensitive gates", () => {
    const policy: BotPermissionPolicy = {
      approvalMode: "ask",
      browserDomains: ["codelit.io", "*.docs.example.com"],
      projectAccess: "ask",
      browserAccess: "ask",
      writeActions: "always-ask",
      computerUse: "ask",
    };
    expect(botBrowserAutoApprovalSource(policy, "browser-read", {
      url: "https://codelit.io/pricing",
      host: "codelit.io",
    })).toBe("bot-domain-scope");
    expect(botBrowserAutoApprovalSource(policy, "browser-read", {
      url: "https://api.docs.example.com/reference",
      host: "api.docs.example.com",
    })).toBe("bot-domain-scope");
    expect(botBrowserDomainMatches("docs.example.com", "*.docs.example.com")).toBe(false);
    expect(botBrowserAutoApprovalSource(policy, "browser-read", {
      url: "https://codelit.io/settings",
      host: "codelit.io",
    })).toBeNull();
    expect(botBrowserAutoApprovalSource(policy, "browser-read", {
      url: "https://codelit.io/pricing?session=private",
      host: "codelit.io",
    })).toBeNull();
    expect(botBrowserAutoApprovalSource(policy, "browser-interact", {
      url: "https://codelit.io/pricing",
      host: "codelit.io",
    })).toBeNull();
    expect(botBrowserAutoApprovalSource({ ...policy, browserDomains: [] }, "browser-read", {
      url: "https://codelit.io/pricing",
      host: "codelit.io",
    })).toBeNull();
  });

  it("continues once the matching approved browser is visibly open", () => {
    expect(isBotBrowserSessionOpen(browserSession("loading"), "browser-run-1")).toBe(false);
    expect(isBotBrowserSessionOpen(browserSession("ready"), "browser-run-1")).toBe(true);
    expect(isBotBrowserSessionOpen(browserSession("loading", false), "browser-run-1")).toBe(false);
    expect(isBotBrowserSessionOpen(browserSession("failed"), "browser-run-1")).toBe(false);
    expect(isBotBrowserSessionOpen(browserSession("ready"), "browser-run-2")).toBe(false);
    expect(isBotBrowserSessionOpen(null, "browser-run-1")).toBe(false);
  });
});
