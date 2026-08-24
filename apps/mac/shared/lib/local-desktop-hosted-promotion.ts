import { validateBrowserToolConfig } from "./browser-policy";
import { parseAgentWorkflow } from "./agent-workflow-parser";
import { parseProductBoard } from "./product-board-parser";
import { parseSystemResponse } from "./system-parser";
import type {
  AgentBrowserAction,
  AgentRiskLevel,
  AgentWorkflow,
  AgentWorkflowTool,
} from "../stores/agent-workflow-store";
import type { HostedScheduleTrigger } from "./hosted-trigger";

export const DESKTOP_HOSTED_PROMOTION_VERSION = 1 as const;
export const DESKTOP_HOSTED_PROMOTION_MAX_BYTES = 320_000;

const SAFE_ID = /^[A-Za-z0-9:_-]{1,160}$/;
const SECRET_KEY = /(?:^|[_-])(api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)(?:$|[_-])/i;
const ABSOLUTE_LOCAL_PATH = /(?:^|[\s"'])(?:~\/|\/Users\/|\/Volumes\/|\/private\/|\/var\/folders\/)/;
const MAX_AGENTS = 20;
const MAX_TEXT = 4_000;

export type DesktopPromotionArtifactKind = "agent-team" | "product-plan" | "architecture";
export type DesktopScheduleCadence = "once" | "daily" | "weekdays" | "weekly";
export type DesktopHostedPromotionIntent = "run-24-7" | "cloud-browser" | "public-trigger" | "collaboration" | "sync";

export interface DesktopPromotionArtifact {
  threadId: string;
  artifactId: string;
  version: string;
  kind: DesktopPromotionArtifactKind;
  title: string;
  payload: unknown;
}

export interface DesktopPromotionSchedule {
  id: string;
  title: string;
  cadence: DesktopScheduleCadence;
  localTime: string;
  timezone: string;
  weekdays: number[];
  missedPolicy: "skip" | "run-once" | "run-every";
  maxRetries: number;
}

export interface DesktopPromotionReviewItem {
  id: string;
  label: string;
  detail: string;
}

export interface DesktopHostedPromotionEnvelope {
  version: typeof DESKTOP_HOSTED_PROMOTION_VERSION;
  promotionId: string;
  createdAt: string;
  source: {
    threadId?: string;
    scheduleId?: string;
    artifactId: string;
    artifactVersion: string;
    artifactKind: DesktopPromotionArtifactKind;
    title: string;
  };
  intent?: DesktopHostedPromotionIntent;
  mode: "run-24-7" | "sync-only";
  readiness: "ready-for-cloud-review" | "needs-cloud-setup" | "sync-only";
  workflowJson?: string;
  artifactJson?: string;
  recommendedTrigger?: HostedScheduleTrigger;
  review: {
    transfers: DesktopPromotionReviewItem[];
    staysOnMac: DesktopPromotionReviewItem[];
    needsCloudSetup: DesktopPromotionReviewItem[];
    scheduleChanges: DesktopPromotionReviewItem[];
  };
}

interface DesktopAgentTeam {
  goal: string;
  agents: Array<{
    id: string;
    name: string;
    role: string;
    tools: string[];
    toolInputs: Record<string, Record<string, unknown>>;
  }>;
  handoffs: Array<{ from: string; to: string; label: string }>;
}

interface DesktopProductPlan {
  problem: string;
  audience: string;
  outcomes: string[];
  milestones: string[];
}

interface DesktopArchitecture {
  summary: string;
  components: Array<{ id: string; name: string; detail: string }>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanText(value: unknown, max = MAX_TEXT) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function assertSafeId(value: unknown, label: string) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertNoCredentialMaterial(value: unknown, path = "payload", depth = 0): void {
  if (depth > 12) throw new Error("The local artifact is too deeply nested to promote safely");
  if (typeof value === "string") {
    if (ABSOLUTE_LOCAL_PATH.test(value)) {
      throw new Error("Local file paths cannot be included in a hosted promotion");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) throw new Error("The local artifact is too large to promote safely");
    value.forEach((item, index) => assertNoCredentialMaterial(item, `${path}.${index}`, depth + 1));
    return;
  }
  const input = record(value);
  if (!input) return;
  for (const [key, nested] of Object.entries(input)) {
    if (SECRET_KEY.test(key)) {
      throw new Error(`Credential-shaped field ${path}.${key} cannot be included in a hosted promotion`);
    }
    assertNoCredentialMaterial(nested, `${path}.${key}`, depth + 1);
  }
}

function readStringArray(value: unknown, limit: number) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).map((item) => cleanText(item, 160)).filter(Boolean);
}

function readToolInputs(value: unknown) {
  const input = record(value);
  if (!input) return {};
  const entries = Object.entries(input).slice(0, 30).flatMap(([key, candidate]) => {
    const item = record(candidate);
    return item ? [[cleanText(key, 160), item] as const] : [];
  }).filter(([key]) => Boolean(key));
  return Object.fromEntries(entries);
}

function readDesktopAgentTeam(value: unknown): DesktopAgentTeam | null {
  const input = record(value);
  if (!input || !Array.isArray(input.agents) || !input.agents.length || input.agents.length > MAX_AGENTS) return null;
  const agents = input.agents.flatMap((candidate) => {
    const item = record(candidate);
    if (!item) return [];
    const id = cleanText(item.id, 160);
    const name = cleanText(item.name, 160);
    const role = cleanText(item.role, 1_000);
    if (!SAFE_ID.test(id) || !name || !role) return [];
    return [{
      id,
      name,
      role,
      tools: readStringArray(item.tools, 30),
      toolInputs: readToolInputs(item.toolInputs),
    }];
  });
  if (agents.length !== input.agents.length) return null;
  const agentIds = new Set(agents.map((agent) => agent.id));
  const handoffs = Array.isArray(input.handoffs)
    ? input.handoffs.slice(0, 60).flatMap((candidate) => {
      const item = record(candidate);
      const from = cleanText(item?.from, 160);
      const to = cleanText(item?.to, 160);
      if (!agentIds.has(from) || !agentIds.has(to)) return [];
      return [{ from, to, label: cleanText(item?.label, 240) || "Always next" }];
    })
    : [];
  return {
    goal: cleanText(input.goal, 4_000) || "Complete the approved Team outcome.",
    agents,
    handoffs,
  };
}

function readDesktopProductPlan(value: unknown): DesktopProductPlan | null {
  const input = record(value);
  if (!input) return null;
  const outcomes = readStringArray(input.outcomes, 80);
  const milestones = readStringArray(input.milestones, 80);
  const problem = cleanText(input.problem, 4_000);
  const audience = cleanText(input.audience, 1_000);
  if (!problem && !outcomes.length && !milestones.length) return null;
  return { problem, audience, outcomes, milestones };
}

function readDesktopArchitecture(value: unknown): DesktopArchitecture | null {
  const input = record(value);
  if (!input || !Array.isArray(input.components) || !input.components.length || input.components.length > 100) return null;
  const components = input.components.flatMap((candidate) => {
    const item = record(candidate);
    const id = cleanText(item?.id, 160);
    const name = cleanText(item?.name, 160);
    if (!SAFE_ID.test(id) || !name) return [];
    return [{ id, name, detail: cleanText(item?.detail, 2_000) }];
  });
  if (components.length !== input.components.length) return null;
  return { summary: cleanText(input.summary, 4_000), components };
}

function buildCloudProductPlan(title: string, value: unknown) {
  const plan = readDesktopProductPlan(value);
  if (!plan) throw new Error("The local Product Plan is invalid or empty");
  const cards = [
    ...plan.outcomes.map((outcome, index) => ({
      id: `desktop-outcome-${index + 1}`,
      type: "requirement",
      title: outcome.slice(0, 160),
      description: outcome,
      priority: index < 3 ? "must-have" : "should-have",
      status: "idea",
    })),
    ...plan.milestones.map((milestone, index) => ({
      id: `desktop-milestone-${index + 1}`,
      type: "milestone",
      title: milestone.slice(0, 160),
      description: milestone,
      priority: "must-have",
      status: "idea",
    })),
  ];
  if (!cards.length) {
    cards.push({
      id: "desktop-outcome-1",
      type: "requirement",
      title: plan.problem.slice(0, 160),
      description: plan.problem,
      priority: "must-have",
      status: "idea",
    });
  }
  const milestoneIds = cards.filter((card) => card.type === "milestone").map((card) => card.id);
  const board = parseProductBoard(JSON.stringify({
    title,
    description: plan.problem,
    targetAudience: plan.audience,
    cards,
    flows: milestoneIds.slice(1).map((id, index) => ({
      id: `desktop-flow-${index + 1}`,
      from: milestoneIds[index],
      to: id,
      label: "Then",
    })),
  }));
  if (!board) throw new Error("The local Product Plan could not be converted safely");
  return board;
}

function buildCloudArchitecture(title: string, value: unknown) {
  const architecture = readDesktopArchitecture(value);
  if (!architecture) throw new Error("The local Architecture is invalid or empty");
  const parsed = parseSystemResponse(JSON.stringify({
    title,
    description: architecture.summary,
    nodes: architecture.components.map((component) => ({
      id: component.id,
      label: component.name,
      description: component.detail,
      type: "service",
    })),
    edges: architecture.components.slice(1).map((component, index) => ({
      id: `desktop-edge-${index + 1}`,
      from: architecture.components[index].id,
      to: component.id,
      label: "Then",
      dataFlow: "medium",
    })),
  }));
  if (!parsed) throw new Error("The local Architecture could not be converted safely");
  return parsed;
}

function browserTarget(value: unknown) {
  const raw = cleanText(value, 200);
  const [prefix, ...remainder] = raw.split(":");
  const targetValue = remainder.join(":").trim();
  if (!targetValue) return null;
  if (prefix === "text") return { kind: "text" as const, value: targetValue };
  if (prefix === "label") return { kind: "label" as const, value: targetValue };
  if (prefix === "testId") return { kind: "testId" as const, value: targetValue };
  if (prefix === "role") return { kind: "role" as const, value: targetValue };
  return null;
}

function browserToolForLocalInput({
  id,
  name,
  input,
}: {
  id: string;
  name: "Browser read" | "Browser act";
  input: Record<string, unknown>;
}): { tool?: AgentWorkflowTool; blocker?: DesktopPromotionReviewItem } {
  const startUrl = cleanText(input.url, 2_048);
  const approvedDomains = readStringArray(input.allowedDomains, 10).map((domain) => domain.toLowerCase());
  const goal = cleanText(input.objective, 2_000);
  const actions: AgentBrowserAction[] = [];
  if (name === "Browser act") {
    const target = browserTarget(input.target);
    const action = cleanText(input.action, 20);
    if (!target || (action !== "click" && action !== "type")) {
      return { blocker: { id: `browser-${id}`, label: "Browser action", detail: "Choose a supported visible target during cloud setup." } };
    }
    if (action === "type") {
      return { blocker: { id: `browser-${id}`, label: "Browser typing", detail: "Typed values stay on this Mac. Re-enter the action during cloud setup." } };
    }
    actions.push({ type: "click", target });
  } else {
    actions.push({ type: "observe" }, { type: "screenshot" });
  }
  const reviewed = validateBrowserToolConfig({
    startUrl,
    approvedDomains,
    mode: name === "Browser act" ? "write" : "read",
    persistSession: name === "Browser act",
    maxDurationSeconds: name === "Browser act" ? 70 : 45,
    ...(name === "Browser act"
      ? { actions }
      : {
          goal,
          successCriteria: "Return visible evidence for the next teammate.",
        }),
  });
  if (!reviewed.ok) {
    return { blocker: { id: `browser-${id}`, label: name, detail: "Review the HTTPS website and approved domains during cloud setup." } };
  }
  return {
    tool: {
      id,
      name,
      type: "browser",
      executorId: "browser",
      executionConfig: { browser: reviewed.config },
      description: name === "Browser act"
        ? "Perform one exact approved action in Codelit's managed browser."
        : "Inspect one approved website in Codelit's managed browser.",
      authMode: "none",
      riskLevel: name === "Browser act" ? "high" : "low",
    },
    blocker: {
      id: `browser-session-${id}`,
      label: "Hosted browser session",
      detail: "Choose a saved Codelit Cloud browser session before activation. Local cookies and login state stay on this Mac.",
    },
  };
}

function riskForTools(tools: AgentWorkflowTool[]): AgentRiskLevel {
  return tools.some((tool) => tool.riskLevel === "high") ? "high" : "low";
}

function buildHostedWorkflow(title: string, team: DesktopAgentTeam) {
  const tools: AgentWorkflowTool[] = [];
  const toolsByAgent = new Map<string, string[]>();
  const blockers: DesktopPromotionReviewItem[] = [];
  let toolIndex = 0;
  for (const agent of team.agents) {
    const hostedToolIds: string[] = [];
    for (const localTool of agent.tools) {
      toolIndex += 1;
      const id = `desktop-tool-${toolIndex}`;
      if (localTool === "Browser read" || localTool === "Browser act") {
        const result = browserToolForLocalInput({
          id,
          name: localTool,
          input: agent.toolInputs[localTool] || {},
        });
        if (result.tool) {
          tools.push(result.tool);
          hostedToolIds.push(result.tool.id);
        }
        if (result.blocker) blockers.push(result.blocker);
        continue;
      }
      blockers.push({
        id: `tool-${agent.id}-${toolIndex}`,
        label: localTool.startsWith("mcp::") ? "Local MCP tool" : "Local project tool",
        detail: localTool.startsWith("mcp::")
          ? "Choose a cloud connected app or remote MCP replacement. Local server details stay on this Mac."
          : "Choose a hosted GitHub or connected-app replacement. Local files and folder access stay on this Mac.",
      });
    }
    toolsByAgent.set(agent.id, hostedToolIds);
  }
  const agentIds = new Set(team.agents.map((agent) => agent.id));
  const nextFor = (agentId: string, index: number) => {
    const explicit = team.handoffs.find((handoff) => handoff.from === agentId && agentIds.has(handoff.to));
    return explicit ? [explicit.to] : team.agents[index + 1] ? [team.agents[index + 1].id] : [];
  };
  const workflow: AgentWorkflow = {
    title,
    description: team.goal,
    audience: "The owner of this Codelit workspace",
    goal: team.goal,
    triggers: [{
      id: "desktop-promotion-trigger",
      name: "Codelit Cloud",
      source: "Codelit for Mac",
      event: "reviewed hosted schedule",
      description: "The owner reviews and publishes this schedule in Codelit Cloud.",
    }],
    tools,
    agents: team.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      responsibilities: [agent.role],
      input: "The Team goal and the prior teammate handoff.",
      output: `A bounded ${agent.name} result with evidence and the next handoff.`,
      tools: toolsByAgent.get(agent.id) || [],
      modelPreference: "Managed model chosen during cloud setup",
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
    modelRoutes: [],
    guardrails: [{
      id: "desktop-promotion-boundary",
      title: "Reviewed cloud boundary",
      policy: "Use only the hosted tools and connections explicitly approved during cloud setup.",
      severity: riskForTools(tools),
    }],
    evaluations: [],
    deployTargets: ["Codelit Cloud", "Immutable hosted receipts"],
  };
  const parsed = parseAgentWorkflow(JSON.stringify(workflow));
  if (!parsed) throw new Error("The local Agent Team could not be converted safely");
  return { workflow: parsed, blockers };
}

function reviewItem(id: string, label: string, detail: string): DesktopPromotionReviewItem {
  return { id, label, detail };
}

function scheduleReview(schedule: DesktopPromotionSchedule) {
  const shared = {
    version: 1 as const,
    kind: "schedule" as const,
    dailyRunLimit: 12,
    dedupeWindowMinutes: 1_440,
    timezone: schedule.timezone,
  };
  if (schedule.cadence === "weekdays") {
    return {
      trigger: { ...shared, intervalMinutes: 1_440 as const, weekdaysOnly: true },
      blockers: [] as DesktopPromotionReviewItem[],
    };
  }
  if (schedule.cadence === "daily") {
    return { trigger: { ...shared, intervalMinutes: 1_440 as const }, blockers: [] as DesktopPromotionReviewItem[] };
  }
  if (schedule.cadence === "weekly") {
    return {
      trigger: { ...shared, intervalMinutes: 10_080 as const },
      blockers: [reviewItem("schedule-weekly", "Weekly start time", "Hosted weekly runs begin from the time you publish. Review the cloud schedule before activation.")],
    };
  }
  return {
    trigger: undefined,
    blockers: [reviewItem("schedule-once", "One-time schedule", "One-time local runs are not activated automatically in Codelit Cloud. Choose a hosted trigger during setup.")],
  };
}

export function createDesktopHostedPromotion({
  artifact,
  schedule,
  intent,
  promotionId,
  now = Date.now(),
}: {
  artifact: DesktopPromotionArtifact;
  schedule?: DesktopPromotionSchedule;
  intent?: DesktopHostedPromotionIntent;
  promotionId?: string;
  now?: number;
}): DesktopHostedPromotionEnvelope {
  assertSafeId(artifact.artifactId, "Artifact id");
  assertSafeId(artifact.version, "Artifact version");
  assertSafeId(artifact.threadId, "Thread id");
  if (schedule) assertSafeId(schedule.id, "Schedule id");
  assertNoCredentialMaterial(artifact.payload);
  const title = cleanText(artifact.title, 160);
  if (!title) throw new Error("Artifact title is required");
  const createdAt = new Date(now).toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Promotion time is invalid");
  const resolvedIntent = intent || (artifact.kind === "agent-team" && schedule ? "run-24-7" : "sync");
  if (resolvedIntent === "run-24-7" && (!schedule || artifact.kind !== "agent-team")) {
    throw new Error("Run 24/7 requires a saved Agent Team schedule");
  }
  if ((resolvedIntent === "cloud-browser" || resolvedIntent === "public-trigger") && artifact.kind !== "agent-team") {
    throw new Error(`${resolvedIntent === "cloud-browser" ? "Cloud browser" : "Public trigger"} requires an Agent Team`);
  }
  const resolvedPromotionId = promotionId
    || `desktop-promotion-${(schedule?.id || artifact.artifactId).slice(0, 80)}-${now}`;
  assertSafeId(resolvedPromotionId, "Promotion id");

  const base: Pick<DesktopHostedPromotionEnvelope, "version" | "promotionId" | "createdAt" | "source" | "intent"> = {
    version: DESKTOP_HOSTED_PROMOTION_VERSION,
    promotionId: resolvedPromotionId,
    createdAt,
    source: {
      threadId: artifact.threadId,
      ...(schedule ? { scheduleId: schedule.id } : {}),
      artifactId: artifact.artifactId,
      artifactVersion: artifact.version,
      artifactKind: artifact.kind,
      title,
    },
    intent: resolvedIntent,
  };
  const staysOnMac = [
    reviewItem("local-files", "Project files", "Folder access, file contents, paths, Git state, and security-scoped bookmarks stay on this Mac."),
    reviewItem("local-auth", "Local intelligence", "Codex, Claude, Gemini, Ollama, MLX, API keys, tokens, cookies, and sign-in sessions do not transfer."),
    reviewItem("local-history", "Local run history", "Local receipts, checkpoints, browser history, and prior run evidence stay on this Mac."),
  ];
  if (artifact.kind !== "agent-team") {
    const cloudArtifact = artifact.kind === "product-plan"
      ? buildCloudProductPlan(title, artifact.payload)
      : buildCloudArchitecture(title, artifact.payload);
    const needsCloudSetup = resolvedIntent === "collaboration"
      ? [reviewItem("collaboration", "Workspace access", "Choose the shared workspace, members, and roles after the reviewed copy is imported.")]
      : [];
    return {
      ...base,
      mode: "sync-only",
      readiness: "sync-only",
      artifactJson: JSON.stringify(cloudArtifact),
      review: {
        transfers: [reviewItem("artifact", artifact.kind === "product-plan" ? "Product Plan" : "Architecture", "A sanitized artifact copy can be added to your cloud workspace after sign-in.")],
        staysOnMac,
        needsCloudSetup,
        scheduleChanges: [],
      },
    };
  }

  const team = readDesktopAgentTeam(artifact.payload);
  if (!team) throw new Error("The local Agent Team is invalid or too large to promote");
  const { workflow, blockers: toolBlockers } = buildHostedWorkflow(title, team);
  if (resolvedIntent !== "run-24-7") {
    const intentSetup: Record<Exclude<DesktopHostedPromotionIntent, "run-24-7" | "sync">, DesktopPromotionReviewItem> = {
      "cloud-browser": reviewItem("cloud-browser", "Managed browser", "Choose a cloud browser profile and sign in separately. Local cookies and browser history never transfer."),
      "public-trigger": reviewItem("public-trigger", "Public trigger", "Choose a webhook or connected-app event after the reviewed Team copy is imported."),
      collaboration: reviewItem("collaboration", "Workspace access", "Choose the shared workspace, members, and roles after the reviewed copy is imported."),
    };
    const requestedSetup = resolvedIntent === "sync" ? [] : [intentSetup[resolvedIntent]];
    const needsCloudSetup = Array.from(new Map(
      [...toolBlockers, ...requestedSetup].map((item) => [`${item.label}:${item.detail}`, item]),
    ).values());
    const envelope: DesktopHostedPromotionEnvelope = {
      ...base,
      mode: "sync-only",
      readiness: "needs-cloud-setup",
      workflowJson: JSON.stringify(workflow),
      review: {
        transfers: [
          reviewItem("team", "Agent Team design", `${team.agents.length} teammate${team.agents.length === 1 ? "" : "s"}, handoffs, goal, and safety boundaries.`),
          ...(workflow.tools.length ? [reviewItem("browser", "Browser configuration", `${workflow.tools.length} browser tool${workflow.tools.length === 1 ? "" : "s"} with reviewed HTTPS domains and no saved session.`)] : []),
        ],
        staysOnMac,
        needsCloudSetup,
        scheduleChanges: [],
      },
    };
    if (JSON.stringify(envelope).length > DESKTOP_HOSTED_PROMOTION_MAX_BYTES) {
      throw new Error("The hosted promotion is too large to continue");
    }
    return envelope;
  }

  const scheduleResult = scheduleReview(schedule!);
  const needsCloudSetup = Array.from(new Map(toolBlockers.map((item) => [`${item.label}:${item.detail}`, item])).values());
  const workflowJson = JSON.stringify(workflow);
  const envelope: DesktopHostedPromotionEnvelope = {
    ...base,
    mode: "run-24-7",
    readiness: needsCloudSetup.length || scheduleResult.blockers.length ? "needs-cloud-setup" : "ready-for-cloud-review",
    workflowJson,
    ...(scheduleResult.trigger ? { recommendedTrigger: scheduleResult.trigger } : {}),
    review: {
      transfers: [
        reviewItem("team", "Agent Team design", `${team.agents.length} teammate${team.agents.length === 1 ? "" : "s"}, handoffs, goal, and safety boundaries.`),
        ...(workflow.tools.length ? [reviewItem("browser", "Hosted browser setup", `${workflow.tools.length} browser tool${workflow.tools.length === 1 ? "" : "s"} with reviewed HTTPS domains and no saved session.`)] : []),
      ],
      staysOnMac,
      needsCloudSetup,
      scheduleChanges: [
        reviewItem("schedule-time", "Start time", `The local ${schedule!.localTime} clock time is not copied. Hosted recurrence starts only after final cloud approval.`),
        reviewItem("schedule-policy", "Retry and missed-run policy", `Local ${schedule!.missedPolicy} handling and ${schedule!.maxRetries} retr${schedule!.maxRetries === 1 ? "y" : "ies"} stay local. Review hosted limits separately.`),
        ...scheduleResult.blockers,
      ],
    },
  };
  const serialized = JSON.stringify(envelope);
  if (serialized.length > DESKTOP_HOSTED_PROMOTION_MAX_BYTES) {
    throw new Error("The hosted promotion is too large to continue");
  }
  return envelope;
}

export function parseDesktopHostedPromotion(value: unknown): DesktopHostedPromotionEnvelope | null {
  try {
    const input = record(value);
    if (!input || input.version !== DESKTOP_HOSTED_PROMOTION_VERSION) return null;
    const serialized = JSON.stringify(value);
    if (serialized.length > DESKTOP_HOSTED_PROMOTION_MAX_BYTES) return null;
    assertNoCredentialMaterial(value);
    const source = record(input.source);
    const review = record(input.review);
    if (!source || !review) return null;
    const artifactKind = source.artifactKind;
    if (artifactKind !== "agent-team" && artifactKind !== "product-plan" && artifactKind !== "architecture") return null;
    assertSafeId(input.promotionId, "Promotion id");
    if (source.threadId !== undefined) assertSafeId(source.threadId, "Thread id");
    if (source.scheduleId !== undefined) assertSafeId(source.scheduleId, "Schedule id");
    if (source.scheduleId === undefined && source.threadId === undefined) return null;
    assertSafeId(source.artifactId, "Artifact id");
    assertSafeId(source.artifactVersion, "Artifact version");
    if (typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt))) return null;
    if (input.mode !== "run-24-7" && input.mode !== "sync-only") return null;
    const intent = input.intent;
    if (intent !== undefined && !["run-24-7", "cloud-browser", "public-trigger", "collaboration", "sync"].includes(String(intent))) return null;
    if (input.readiness !== "ready-for-cloud-review" && input.readiness !== "needs-cloud-setup" && input.readiness !== "sync-only") return null;
    const lists = [review.transfers, review.staysOnMac, review.needsCloudSetup, review.scheduleChanges];
    if (lists.some((list) => !Array.isArray(list) || list.length > 60 || list.some((item) => {
      const candidate = record(item);
      return !candidate || !SAFE_ID.test(String(candidate.id || "")) || !cleanText(candidate.label, 160) || !cleanText(candidate.detail, 1_000);
    }))) return null;
    if (input.mode === "run-24-7") {
      if (!source.scheduleId || (intent !== undefined && intent !== "run-24-7")) return null;
      if (typeof input.workflowJson !== "string") return null;
      const rawWorkflow = JSON.parse(input.workflowJson) as unknown;
      assertNoCredentialMaterial(rawWorkflow, "workflowJson");
      const parsedWorkflow = parseAgentWorkflow(input.workflowJson);
      if (!parsedWorkflow) return null;
      const trigger = input.recommendedTrigger;
      if (trigger !== undefined) {
        const candidate = record(trigger);
        if (!candidate || candidate.version !== 1 || candidate.kind !== "schedule" || ![60, 360, 1_440, 10_080].includes(Number(candidate.intervalMinutes))) return null;
      }
      return {
        ...(value as DesktopHostedPromotionEnvelope),
        workflowJson: JSON.stringify(parsedWorkflow),
      };
    } else {
      if (input.recommendedTrigger !== undefined) return null;
      if (artifactKind === "agent-team") {
        if (typeof input.workflowJson !== "string" || input.artifactJson !== undefined) return null;
        if (intent !== undefined && !["cloud-browser", "public-trigger", "collaboration", "sync"].includes(String(intent))) return null;
        const rawWorkflow = JSON.parse(input.workflowJson) as unknown;
        assertNoCredentialMaterial(rawWorkflow, "workflowJson");
        const parsedWorkflow = parseAgentWorkflow(input.workflowJson);
        if (!parsedWorkflow) return null;
        return {
          ...(value as DesktopHostedPromotionEnvelope),
          workflowJson: JSON.stringify(parsedWorkflow),
        };
      }
      if (input.workflowJson !== undefined || typeof input.artifactJson !== "string") return null;
      if (intent !== undefined && intent !== "sync" && intent !== "collaboration") return null;
      const rawArtifact = JSON.parse(input.artifactJson) as unknown;
      assertNoCredentialMaterial(rawArtifact, "artifactJson");
      const parsedArtifact = artifactKind === "product-plan"
        ? parseProductBoard(input.artifactJson)
        : parseSystemResponse(input.artifactJson);
      if (!parsedArtifact) return null;
      return {
        ...(value as DesktopHostedPromotionEnvelope),
        artifactJson: JSON.stringify(parsedArtifact),
      };
    }
  } catch {
    return null;
  }
}
