export type AgentRuntimeControl =
  | "managed-ai"
  | "managed-browser"
  | "hosted-runs"
  | "provider-writes"
  | "experimental-runtimes";

type RuntimeEnvironment = Record<string, string | undefined>;

const CONTROL_CONFIG: Record<AgentRuntimeControl, {
  envKey: string;
  defaultEnabled: boolean;
  disabledMessage: string;
}> = {
  "managed-ai": {
    envKey: "CODELIT_MANAGED_AI_ENABLED",
    defaultEnabled: true,
    disabledMessage: "Codelit-managed AI is temporarily paused. Use Run with my keys or try again later.",
  },
  "managed-browser": {
    envKey: "CODELIT_MANAGED_BROWSER_ENABLED",
    defaultEnabled: true,
    disabledMessage: "Managed browser runs are temporarily paused. No browser session was started.",
  },
  "hosted-runs": {
    envKey: "CODELIT_HOSTED_RUNS_ENABLED",
    defaultEnabled: true,
    disabledMessage: "Hosted runs are temporarily paused. Existing workflows remain saved.",
  },
  "provider-writes": {
    envKey: "CODELIT_PROVIDER_WRITES_ENABLED",
    defaultEnabled: true,
    disabledMessage: "Connected-app writes are temporarily paused. No external change was made.",
  },
  "experimental-runtimes": {
    envKey: "CODELIT_EXPERIMENTAL_RUNTIMES_ENABLED",
    defaultEnabled: false,
    disabledMessage: "This experimental runtime is not available yet.",
  },
};

const DISABLED_VALUES = new Set(["0", "false", "off", "disabled"]);
const ENABLED_VALUES = new Set(["1", "true", "on", "enabled"]);

export class AgentRuntimeDisabledError extends Error {
  readonly code = "runtime-disabled";
  readonly status = 503;

  constructor(readonly control: AgentRuntimeControl) {
    super(CONTROL_CONFIG[control].disabledMessage);
    this.name = "AgentRuntimeDisabledError";
  }
}

export function isAgentRuntimeEnabled(control: AgentRuntimeControl, env: RuntimeEnvironment = process.env): boolean {
  const config = CONTROL_CONFIG[control];
  const value = env[config.envKey]?.trim().toLowerCase();
  if (!value) return config.defaultEnabled;
  if (DISABLED_VALUES.has(value)) return false;
  if (ENABLED_VALUES.has(value)) return true;
  return config.defaultEnabled;
}

export function assertAgentRuntimeEnabled(control: AgentRuntimeControl, env: RuntimeEnvironment = process.env): void {
  if (!isAgentRuntimeEnabled(control, env)) throw new AgentRuntimeDisabledError(control);
}

export function agentRuntimeControlSnapshot(env: RuntimeEnvironment = process.env): Record<AgentRuntimeControl, boolean> {
  return {
    "managed-ai": isAgentRuntimeEnabled("managed-ai", env),
    "managed-browser": isAgentRuntimeEnabled("managed-browser", env),
    "hosted-runs": isAgentRuntimeEnabled("hosted-runs", env),
    "provider-writes": isAgentRuntimeEnabled("provider-writes", env),
    "experimental-runtimes": isAgentRuntimeEnabled("experimental-runtimes", env),
  };
}
