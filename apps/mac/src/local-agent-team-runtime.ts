import { buildAgentSimulation } from "@/lib/agent-workflow-export";
import {
  runWorkflowLive,
  type LiveRunApprovalDecision,
  type LiveRunResume,
  type LiveRunTranscript,
  type ModelCallContext,
} from "@/lib/agent-live-run";
import type { AgentRiskLevel, AgentWorkflow, AgentWorkflowTool } from "@/stores/agent-workflow-store";
import {
  isProviderId,
  type AgentTeamPayload,
  type IntelligenceSelection,
  type LocalArtifactVersion,
  type LocalWorkspaceSnapshot,
  type ProviderProbe,
  type ProviderRunEvent,
  type ProviderRunEventType,
  type ProviderTaskResult,
} from "./contracts";
import {
  beginLocalRun,
  cancelIntelligenceTask,
  createNativeToolRuntimeAdapter,
  discardPreparedMcpApproval,
  prepareNativeToolApproval,
  recordLocalRunApproval,
  recordProviderRun,
  runIntelligenceTask,
  saveLocalRunCheckpoint,
} from "./runtime";

export interface LocalAgentApprovalRequest {
  id: string;
  runId: string;
  stepIndex: number;
  title: string;
  actor: string;
  tools: string[];
  handoff: string;
  preview: string[];
  canApprove: boolean;
  approvalSha256?: string;
  preparationError?: string;
}

export interface LocalAgentTeamRunCallbacks {
  onSnapshot: (snapshot: LocalWorkspaceSnapshot) => void;
  onEvent: (event: ProviderRunEvent) => void;
  onStepChange: (stepIndex: number | null) => void;
  awaitApproval: (request: LocalAgentApprovalRequest) => Promise<LiveRunApprovalDecision>;
}

export interface LocalAgentTeamRunResult {
  runId: string;
  snapshot: LocalWorkspaceSnapshot;
  transcript: LiveRunTranscript;
  result: ProviderTaskResult;
}

export interface LocalAgentTeamRunContext {
  schemaVersion: 1;
  artifactId: string;
  artifactVersion: string;
  title: string;
  team: AgentTeamPayload;
  fallbackEngine: IntelligenceSelection;
}

export interface RecoverableLocalAgentTeamRun {
  runId: string;
  resumeFrom: LiveRunResume;
  context: LocalAgentTeamRunContext;
}

function toolRisk(name: string): AgentRiskLevel {
  return name === "Browser act"
    || name.startsWith("mcp::")
    || /\b(write|patch|apply|commit|push|deploy|send|post|delete|update|shell|test|typecheck|lint)\b/i.test(name)
    ? "high"
    : "low";
}

function requiresNativePreparation(tools: string[]) {
  return tools.some((name) => name === "Browser act"
    || name.startsWith("mcp::")
    || /^(patch apply|apply patch|apply approved patch|project test|project typecheck|project lint)$/i.test(name.trim()));
}

function workflowFromTeam(title: string, team: AgentTeamPayload): AgentWorkflow {
  const toolNames = Array.from(new Set(team.agents.flatMap((agent) => agent.tools)));
  const tools: AgentWorkflowTool[] = toolNames.map((name, index) => ({
    id: `local-tool-${index + 1}`,
    name,
    type: name === "Browser read" || name === "Browser act"
      ? "browser"
      : name.startsWith("mcp::")
      ? "custom"
      : /git|repo|folder|file|diff|check|shell/i.test(name) ? "repo" : "runtime",
    description: name === "Browser read"
      ? "Inspect visible content inside this Project's isolated in-window browser."
      : name === "Browser act"
        ? "Perform one exact approved click or typed input inside this Project's isolated browser."
        : name.startsWith("mcp::")
      ? "Call one explicitly approved tool from a reviewed server on this Mac."
      : `Run ${name} inside the selected local project boundary.`,
    authMode: "none",
    riskLevel: toolRisk(name),
    ...(name === "Browser read" || name === "Browser act" ? { executorId: "browser" as const } : {}),
  }));
  const toolIdByName = new Map(tools.map((tool) => [tool.name, tool.id]));
  const agentIds = new Set(team.agents.map((agent) => agent.id));
  const nextFor = (agentId: string, index: number) => {
    const explicit = team.handoffs.find((handoff) => handoff.from === agentId);
    if (explicit && agentIds.has(explicit.to)) return [explicit.to];
    return team.agents[index + 1] ? [team.agents[index + 1].id] : [];
  };
  return {
    title,
    description: team.goal,
    audience: "The owner of this local workspace",
    goal: team.goal,
    triggers: [{
      id: "local-run",
      name: "Run here",
      source: "Codelit for Mac",
      event: "manual request",
      description: "The user starts this Team on their Mac.",
    }],
    tools,
    agents: team.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      responsibilities: [agent.role],
      input: "The Team goal, selected project context, and prior teammate handoff.",
      output: `A bounded ${agent.name} result with evidence and the next handoff.`,
      tools: agent.tools.flatMap((name) => toolIdByName.get(name) || []),
      modelPreference: agent.model,
      escalationPolicy: "Stop safely and preserve the latest completed checkpoint.",
    })),
    steps: team.agents.map((agent, index) => ({
      id: agent.id,
      title: agent.name,
      actor: agent.id,
      action: agent.role,
      onSuccess: `Hand off the verified ${agent.name} result.`,
      onFailure: "Stop safely, preserve evidence, and explain the exact repair.",
      next: nextFor(agent.id, index),
      handoffMode: "always-next",
      retryPolicy: { maxAttempts: 2 },
    })),
    modelRoutes: team.agents.map((agent, index) => ({
      id: `local-model-${index + 1}`,
      task: agent.name,
      provider: agent.provider,
      model: agent.model,
      reason: "Use the engine selected on this teammate.",
      fallback: "Stop and ask the user to choose a ready local engine.",
    })),
    guardrails: [{
      id: "local-boundary",
      title: "Selected project only",
      policy: "Read and write only inside the user-approved project boundary.",
      severity: "high",
    }],
    evaluations: [],
    deployTargets: ["This Mac", "Encrypted local receipt store"],
  };
}

function readySelection(
  team: AgentTeamPayload,
  context: ModelCallContext | undefined,
  providers: ProviderProbe[],
  fallback: IntelligenceSelection,
) {
  const agent = team.agents.find((candidate) => candidate.id === context?.stepId);
  if (!agent) return { selection: fallback, usedFallback: false, requested: "" };
  const provider = providers.find((candidate) => candidate.id === agent.provider && candidate.canRun);
  if (!provider) {
    return {
      selection: fallback,
      usedFallback: true,
      requested: `${agent.provider}/${agent.model}`,
    };
  }
  const configured = provider.models.find((model) => model.id === agent.model && model.status === "ready");
  const model = configured || provider.models.find((candidate) => candidate.status === "ready");
  return model
    ? {
        selection: { provider: provider.id, model: model.id },
        usedFallback: model.id !== agent.model,
        requested: `${agent.provider}/${agent.model}`,
      }
    : {
        selection: fallback,
        usedFallback: true,
        requested: `${agent.provider}/${agent.model}`,
      };
}

function modelOutput(result: ProviderTaskResult) {
  if (!result.structuredOutput) return result.text;
  return [result.structuredOutput.summary, ...result.structuredOutput.items]
    .filter(Boolean)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readSelection(value: unknown): IntelligenceSelection | null {
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.model !== "string") {
    return null;
  }
  if (!isProviderId(value.provider)) return null;
  return { provider: value.provider as IntelligenceSelection["provider"], model: value.model };
}

export function readLocalAgentTeamPayload(value: unknown): AgentTeamPayload | null {
  if (!isRecord(value) || typeof value.goal !== "string" || !Array.isArray(value.agents)) {
    return null;
  }
  const agents = value.agents.flatMap((agent) => {
    if (!isRecord(agent)
      || typeof agent.id !== "string"
      || typeof agent.name !== "string") return [];
    return [{
      id: agent.id,
      name: agent.name,
      role: typeof agent.role === "string" ? agent.role : "",
      provider: typeof agent.provider === "string" ? agent.provider : "codex",
      model: typeof agent.model === "string" ? agent.model : "default",
      tools: Array.isArray(agent.tools)
        ? agent.tools.filter((tool): tool is string => typeof tool === "string")
        : [],
      toolInputs: readToolInputs(agent.toolInputs),
    }];
  });
  if (agents.length !== value.agents.length) return null;
  const rawHandoffs = Array.isArray(value.handoffs) ? value.handoffs : [];
  const handoffs = rawHandoffs.flatMap((handoff) => {
    if (!isRecord(handoff)
      || typeof handoff.from !== "string"
      || typeof handoff.to !== "string"
      || typeof handoff.label !== "string") return [];
    return [{ from: handoff.from, to: handoff.to, label: handoff.label }];
  });
  return handoffs.length === rawHandoffs.length ? { goal: value.goal, agents, handoffs } : null;
}

function readToolInputs(value: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([tool, inputs]) => (
    (tool.startsWith("mcp::") || tool === "Browser read" || tool === "Browser act")
      && isRecord(inputs) ? [[tool, inputs]] : []
  )));
}

export function localBrowserSessionId(artifactId: string) {
  const bounded = artifactId.replace(/[^A-Za-z0-9_-]/g, "-").slice(-72) || "local-artifact";
  return `browser-${bounded}`;
}

export function readLocalAgentTeamCheckpoint(
  runId: string,
  body: unknown,
): RecoverableLocalAgentTeamRun | null {
  if (!isRecord(body)
    || !Number.isInteger(body.stepIndex)
    || typeof body.stepIndex !== "number"
    || body.stepIndex < 0
    || body.stepIndex > 512
    || typeof body.handoff !== "string"
    || !Array.isArray(body.priorSteps)
    || !isRecord(body.runContext)) return null;
  const context = body.runContext;
  const team = readLocalAgentTeamPayload(context.team);
  const fallbackEngine = readSelection(context.fallbackEngine);
  if (context.schemaVersion !== 1
    || typeof context.artifactId !== "string"
    || typeof context.artifactVersion !== "string"
    || typeof context.title !== "string"
    || !team
    || !fallbackEngine) return null;
  return {
    runId,
    resumeFrom: {
      stepIndex: body.stepIndex,
      handoff: body.handoff,
      priorSteps: body.priorSteps as LiveRunResume["priorSteps"],
      ...(body.gateApproved === true ? { gateApproved: true } : {}),
    },
    context: {
      schemaVersion: 1,
      artifactId: context.artifactId,
      artifactVersion: context.artifactVersion,
      title: context.title,
      team,
      fallbackEngine,
    },
  };
}

export async function runLocalAgentTeam(input: {
  snapshot: LocalWorkspaceSnapshot;
  artifact: LocalArtifactVersion;
  title: string;
  team: AgentTeamPayload;
  providers: ProviderProbe[];
  fallbackEngine: IntelligenceSelection;
  signal: AbortSignal;
  runId?: string;
  resumeFrom?: LiveRunResume;
  executionGuard?: () => Promise<void>;
  callbacks: LocalAgentTeamRunCallbacks;
}): Promise<LocalAgentTeamRunResult> {
  if (!input.team.agents.length) throw new Error("Add at least one teammate before running this Team.");
  const runId = input.runId || `team-${crypto.randomUUID()}`;
  const runContext: LocalAgentTeamRunContext = {
    schemaVersion: 1,
    artifactId: input.artifact.artifactId,
    artifactVersion: input.artifact.version,
    title: input.title,
    team: input.team,
    fallbackEngine: input.fallbackEngine,
  };
  let snapshot = await beginLocalRun(
    input.snapshot,
    input.artifact.artifactId,
    runId,
    input.fallbackEngine,
  );
  input.callbacks.onSnapshot(snapshot);
  snapshot = await saveLocalRunCheckpoint(snapshot, runId, {
    stepIndex: input.resumeFrom?.stepIndex || 0,
    handoff: input.resumeFrom?.handoff || "",
    priorSteps: input.resumeFrom?.priorSteps || [],
    gateApproved: input.resumeFrom?.gateApproved,
    runContext,
  });
  input.callbacks.onSnapshot(snapshot);

  let sequence = 0;
  let meteredProviderInvocationStarted = false;
  const events: ProviderRunEvent[] = [];
  const emit = (
    eventType: ProviderRunEventType,
    message: string,
    payload?: unknown,
    provider = "local-team",
    model = input.fallbackEngine.model,
  ) => {
    const event: ProviderRunEvent = {
      runId,
      sequence: ++sequence,
      eventType,
      provider,
      model,
      message: message.slice(0, 12_000),
      ...(payload === undefined ? {} : { payload }),
      createdAt: new Date().toISOString(),
    };
    events.push(event);
    input.callbacks.onEvent(event);
  };
  const forwardNativeEvent = (event: ProviderRunEvent) => {
    emit(event.eventType, event.message, event.payload, event.provider, event.model);
  };
  const approvalHashes = new Map<string, string>();

  emit("started", `Running ${input.title} on this Mac`);
  const workflow = workflowFromTeam(input.title, input.team);
  const simulation = buildAgentSimulation(workflow);
  simulation.steps = simulation.steps.map((step) => ({
    ...step,
    gate: step.tools.some((tool) => toolRisk(tool) === "high")
      ? "Human approval required before local write"
      : step.gate,
  }));

  const browserSessionId = localBrowserSessionId(input.artifact.artifactId);
  const toolRuntime = createNativeToolRuntimeAdapter(
    forwardNativeEvent,
    (step) => {
      const teammate = input.team.agents.find((agent) => agent.id === step.id);
      const hasBrowserTool = step.tools.some((tool) => tool === "Browser read" || tool === "Browser act");
      return {
        approvalSha256: approvalHashes.get(step.id),
        ...(hasBrowserTool ? {
          toolInputs: teammate?.toolInputs || {},
          browserSessionId,
          browserProjectId: input.artifact.projectId,
        } : {}),
      };
    },
    async () => {
      await input.executionGuard?.();
    },
  );
  const transcript = await runWorkflowLive(
    workflow,
    simulation,
    {
      onEvent(lines) {
        for (const line of lines) emit("message", line);
      },
      onStepStart(index) {
        input.callbacks.onStepChange(index);
      },
      onStepChunk() {},
      onStepDone() {},
      async onCheckpoint(checkpoint) {
        snapshot = await saveLocalRunCheckpoint(snapshot, runId, { ...checkpoint, runContext });
        input.callbacks.onSnapshot(snapshot);
        emit("checkpoint", `Checkpoint saved after ${checkpoint.priorSteps.length} completed step${checkpoint.priorSteps.length === 1 ? "" : "s"}`, {
          stepIndex: checkpoint.stepIndex,
        });
      },
      async awaitApproval(index, context) {
        const step = simulation.steps[index];
        let preview: string[] = [];
        let approvalSha256: string | undefined;
        let preparationError: string | undefined;
        if (requiresNativePreparation(step?.tools || [])) {
          try {
            const teammate = input.team.agents.find((agent) => agent.id === step?.id);
            const approvalArguments = [
              runId,
              step?.tools || [],
              context.priorSteps.at(-1)?.output || context.handoff,
              teammate?.toolInputs || {},
              forwardNativeEvent,
              input.signal,
            ] as const;
            const prepared = step?.tools.some((tool) => tool === "Browser act")
              ? await prepareNativeToolApproval(...approvalArguments, {
                  sessionId: browserSessionId,
                  projectId: input.artifact.projectId,
                })
              : await prepareNativeToolApproval(...approvalArguments);
            preview = [prepared.summary, ...prepared.evidence];
            approvalSha256 = prepared.approvalSha256;
            if (approvalSha256 && step?.id) approvalHashes.set(step.id, approvalSha256);
          } catch (reason) {
            preparationError = reason instanceof Error ? reason.message : String(reason);
            preparationError = preparationError.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500);
            emit("failed", `Local action preview could not be prepared: ${preparationError}`);
          }
        }
        const approval: LocalAgentApprovalRequest = {
          id: `${runId}-approval-${index}`,
          runId,
          stepIndex: index,
          title: step?.title || `Step ${index + 1}`,
          actor: step?.actor || "Local teammate",
          tools: step?.tools || [],
          handoff: context.handoff,
          preview,
          canApprove: !preparationError,
          ...(approvalSha256 ? { approvalSha256 } : {}),
          ...(preparationError ? { preparationError } : {}),
        };
        snapshot = await recordLocalRunApproval(snapshot, {
          ...approval,
          status: "awaiting",
          body: approval,
        });
        input.callbacks.onSnapshot(snapshot);
        emit("approval-required", `Review ${approval.title} before local changes run`, approval);
        const requestedDecision = await input.callbacks.awaitApproval(approval);
        const decision = requestedDecision === "approve" && !approval.canApprove
          ? "hold"
          : requestedDecision;
        if (decision !== "approve" && approvalSha256) {
          approvalHashes.delete(step?.id || "");
          await discardPreparedMcpApproval(runId).catch(() => undefined);
        }
        snapshot = await recordLocalRunApproval(snapshot, {
          ...approval,
          status: decision === "approve"
            ? "approved"
            : decision === "deny"
              ? "denied"
              : decision === "hold"
                ? "held"
                : decision,
          body: { ...approval, decision },
        });
        input.callbacks.onSnapshot(snapshot);
        return decision;
      },
      signal: input.signal,
    },
    {
      runId,
      executionMode: "device-local",
      fundingSources: ["user-device"],
      toolRuntime,
      ...(input.resumeFrom ? { resumeFrom: input.resumeFrom } : {}),
      async callModel(prompt, signal, context) {
        await input.executionGuard?.();
        const route = readySelection(
          input.team,
          context,
          input.providers,
          input.fallbackEngine,
        );
        const selection = route.selection;
        if (route.usedFallback) {
          emit(
            "message",
            `model.route → ${route.requested} is not ready; using ${selection.provider}/${selection.model} for this run`,
          );
        }
        const childRunId = `${runId}-model-${context?.stepIndex || 0}`;
        const cancel = () => { void cancelIntelligenceTask(childRunId); };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          const result = await runIntelligenceTask(
            selection,
            prompt,
            forwardNativeEvent,
            input.snapshot.workspaceFolder?.path,
            childRunId,
            "fixed",
            false,
            () => {
              if (["openai", "anthropic", "gemini"].includes(selection.provider)) {
                meteredProviderInvocationStarted = true;
              }
            },
          );
          if (result.status !== "completed") throw new Error(result.text);
          return modelOutput(result);
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      },
    },
  );
  input.callbacks.onStepChange(null);

  const canceled = input.signal.aborted || transcript.failure?.code === "interrupted";
  const status = transcript.status === "completed" ? "completed" : canceled ? "canceled" : "failed";
  const finalOutput = transcript.steps.at(-1)?.output.trim();
  const summary = finalOutput
    || (transcript.failure
      ? `Stopped safely at ${transcript.failure.stepTitle || "the current step"}: ${transcript.failure.code.replace(/-/g, " ")}.`
      : `${input.title} completed locally.`);
  emit(
    status === "completed" ? "completed" : status === "canceled" ? "canceled" : "failed",
    summary,
    { transcript },
  );
  const result: ProviderTaskResult = {
    runId,
    provider: "local-team",
    model: input.fallbackEngine.model,
    status,
    ...(status === "completed" ? { structuredOutput: { summary, items: transcript.steps.map((step) => `${step.actor}: ${step.output}`).slice(0, 12) } } : {}),
    text: summary,
    durationMs: transcript.durationMs,
    commandPath: "codelit-local-team",
    evidence: Array.from(new Set(transcript.steps.flatMap((step) => step.liveTools || []))),
    selectionMode: "fixed",
    meteredFallbackAuthorized: false,
    meteredProviderInvocationStarted,
    billingFallback: false,
  };
  snapshot = await recordProviderRun(snapshot, input.artifact.artifactId, result, events, {
    schemaVersion: 1,
    teamVersion: input.artifact.version,
    transcript,
  });
  input.callbacks.onSnapshot(snapshot);
  return { runId, snapshot, transcript, result };
}
