import type { AgentWorkflowAgent, AgentWorkflowTool } from "../stores/agent-workflow-store";
import {
  sanitizeAgentLibraryAssetRef,
  type AgentLibraryAssetRef,
} from "./agent-library-contract";
import { canonicalJson } from "./canonical-json";

export const AGENT_LIBRARY_STORAGE_KEY = "codelit-agent-role-library-v1";
export const AGENT_LIBRARY_TEAMMATE_BODY_VERSION = 1 as const;

export interface ReusableAgentDefinition {
  libraryId: string;
  name: string;
  role: string;
  responsibilities: string[];
  input: string;
  output: string;
  modelPreference: string;
  escalationPolicy: string;
  libraryRef?: AgentLibraryAssetRef<"teammate">;
}

export interface ReusableAgentAssetBody {
  version: typeof AGENT_LIBRARY_TEAMMATE_BODY_VERSION;
  name: string;
  role: string;
  responsibilities: string[];
  input: string;
  output: string;
  modelPreference: string;
  escalationPolicy: string;
}

export interface AgentDefinitionCheck {
  id: "role" | "output" | "model" | "tools";
  label: string;
  passed: boolean;
  detail: string;
}

export interface ReusableAgentDefinitionUpsert {
  definition: ReusableAgentDefinition;
  definitions: ReusableAgentDefinition[];
  updated: boolean;
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi,
  /\b(?:sk|rk|pk|gh[opusr])[-_][A-Za-z0-9_-]{12,}\b/gi,
  /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g,
  /\bglpat-[A-Za-z0-9_-]{12,}\b/gi,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|secret)\s*[:=]\s*[^\s,;]{6,}/gi,
];
const HIGH_ENTROPY_TOKEN = /[A-Za-z0-9+/_=-]{32,}/g;
const CREDENTIAL_REMOVED = "[credential removed]";
const SAFE_LIBRARY_ID = /^[A-Za-z0-9:_-]{1,160}$/;
const MAX_LIBRARY_ITEMS = 24;

type LibraryReadableStorage = Pick<Storage, "getItem">;
type LibraryWritableStorage = Pick<Storage, "setItem">;

function tokenEntropy(value: string) {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) || 0) + 1);
  return [...counts.values()].reduce((entropy, count) => {
    const probability = count / value.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
}

function looksLikeHighEntropyCredential(value: string) {
  const classes = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
    /[+/_=-]/.test(value),
  ].filter(Boolean).length;
  return classes >= 3
    && new Set(value).size / value.length >= 0.35
    && tokenEntropy(value) >= 4;
}

function safeText(value: unknown, max = 500) {
  let text = typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ")
    : "";
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, CREDENTIAL_REMOVED);
  text = text.replace(HIGH_ENTROPY_TOKEN, (token) => (
    looksLikeHighEntropyCredential(token) ? CREDENTIAL_REMOVED : token
  ));
  return text.trim().slice(0, max);
}

export function sanitizeAgentLibraryText(value: unknown, max = 500) {
  return safeText(value, max);
}

export function agentLibraryValueHasRedactions(value: unknown) {
  return canonicalJson(value).includes(CREDENTIAL_REMOVED);
}

function definitionName(value: unknown) {
  return safeText(value, 100) || "Reusable agent";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function createReusableAgentDefinition(agent: AgentWorkflowAgent, libraryId?: string): ReusableAgentDefinition {
  const safeLibraryId = typeof libraryId === "string" && SAFE_LIBRARY_ID.test(libraryId)
    ? libraryId
    : globalThis.crypto?.randomUUID?.() || `role-${Date.now()}`;
  return {
    libraryId: safeLibraryId,
    name: definitionName(agent.name),
    role: safeText(agent.role),
    responsibilities: agent.responsibilities.slice(0, 10).map((item) => safeText(item, 240)).filter(Boolean),
    input: safeText(agent.input, 300),
    output: safeText(agent.output, 300),
    modelPreference: safeText(agent.modelPreference, 120),
    escalationPolicy: safeText(agent.escalationPolicy, 400),
  };
}

export function uniqueReusableAgentName(
  name: string,
  existingAgents: Array<Pick<AgentWorkflowAgent, "name">>,
) {
  const baseName = definitionName(name);
  const names = new Set(existingAgents.map((agent) => normalizedDefinitionName(agent.name)));
  if (!names.has(normalizedDefinitionName(baseName))) return baseName;

  for (let copy = 2; copy < 10_000; copy += 1) {
    const suffix = ` ${copy}`;
    const candidate = `${baseName.slice(0, Math.max(1, 100 - suffix.length)).trimEnd()}${suffix}`;
    if (!names.has(normalizedDefinitionName(candidate))) return candidate;
  }
  const suffix = ` ${Date.now().toString().slice(-8)}`;
  return `${baseName.slice(0, 100 - suffix.length).trimEnd()}${suffix}`;
}

export function agentFromReusableDefinition(
  definition: ReusableAgentDefinition,
  id: string,
  existingAgents: Array<Pick<AgentWorkflowAgent, "name">> = [],
): AgentWorkflowAgent {
  const libraryRef = sanitizeAgentLibraryAssetRef(definition.libraryRef, "teammate");
  return {
    id,
    name: uniqueReusableAgentName(definition.name, existingAgents),
    role: definition.role,
    responsibilities: [...definition.responsibilities],
    input: definition.input,
    output: definition.output,
    tools: [],
    modelPreference: definition.modelPreference,
    escalationPolicy: definition.escalationPolicy,
    ...(libraryRef ? { libraryRef } : {}),
  };
}

function normalizedDefinitionName(value: string) {
  return definitionName(value).toLowerCase();
}

export function sanitizeReusableAgentDefinition(
  value: unknown,
  fallbackLibraryId?: string,
): ReusableAgentDefinition | null {
  const item = record(value);
  const libraryId = typeof item.libraryId === "string" && SAFE_LIBRARY_ID.test(item.libraryId)
    ? item.libraryId
    : typeof fallbackLibraryId === "string" && SAFE_LIBRARY_ID.test(fallbackLibraryId)
      ? fallbackLibraryId
      : globalThis.crypto?.randomUUID?.() || `role-${Date.now()}`;
  if (
    !libraryId
    || typeof item.name !== "string"
    || typeof item.role !== "string"
    || !Array.isArray(item.responsibilities)
    || !item.responsibilities.every((responsibility) => typeof responsibility === "string")
    || typeof item.input !== "string"
    || typeof item.output !== "string"
    || typeof item.modelPreference !== "string"
    || typeof item.escalationPolicy !== "string"
  ) {
    return null;
  }
  return createReusableAgentDefinition({
    id: "library-sanitizer",
    name: item.name,
    role: item.role,
    responsibilities: item.responsibilities,
    input: item.input,
    output: item.output,
    tools: [],
    modelPreference: item.modelPreference,
    escalationPolicy: item.escalationPolicy,
  }, libraryId);
}

export function createReusableAgentAssetBody(
  definition: ReusableAgentDefinition,
): ReusableAgentAssetBody {
  const sanitized = sanitizeReusableAgentDefinition(definition, definition.libraryId)
    || createReusableAgentDefinition(agentFromReusableDefinition(definition, "library-sanitizer"), definition.libraryId);
  return {
    version: AGENT_LIBRARY_TEAMMATE_BODY_VERSION,
    name: sanitized.name,
    role: sanitized.role,
    responsibilities: sanitized.responsibilities,
    input: sanitized.input,
    output: sanitized.output,
    modelPreference: sanitized.modelPreference,
    escalationPolicy: sanitized.escalationPolicy,
  };
}

export function reusableAgentDefinitionHasRedactions(
  definition: ReusableAgentDefinition,
): boolean {
  return agentLibraryValueHasRedactions(createReusableAgentAssetBody(definition));
}

export function reusableAgentDefinitionFingerprint(
  definition: ReusableAgentDefinition,
): string {
  return canonicalJson(createReusableAgentAssetBody(definition));
}

export function mergeReusableAgentDefinitionsPreferCloud(
  browserDefinitions: readonly ReusableAgentDefinition[],
  cloudDefinitions: readonly ReusableAgentDefinition[],
): ReusableAgentDefinition[] {
  const fingerprints = new Set<string>();
  return [...cloudDefinitions, ...browserDefinitions].filter((definition) => {
    const fingerprint = reusableAgentDefinitionFingerprint(definition);
    if (fingerprints.has(fingerprint)) return false;
    fingerprints.add(fingerprint);
    return true;
  });
}

export function reusableAgentDefinitionFromAssetBody(
  value: unknown,
  libraryId: string,
): ReusableAgentDefinition | null {
  const body = record(value);
  if (body.version !== AGENT_LIBRARY_TEAMMATE_BODY_VERSION) return null;
  return sanitizeReusableAgentDefinition({ ...body, libraryId }, libraryId);
}

function sanitizedDefinitions(definitions: ReusableAgentDefinition[]) {
  return definitions
    .slice(-MAX_LIBRARY_ITEMS)
    .flatMap((item) => {
      const definition = sanitizeReusableAgentDefinition(item);
      return definition ? [definition] : [];
    });
}

export function upsertReusableAgentDefinition(
  definitions: ReusableAgentDefinition[],
  agent: AgentWorkflowAgent,
): ReusableAgentDefinitionUpsert {
  const sanitized = sanitizedDefinitions(definitions);
  const expectedName = normalizedDefinitionName(agent.name);
  const existingIndex = sanitized.findIndex((item) => normalizedDefinitionName(item.name) === expectedName);
  const existing = existingIndex >= 0 ? sanitized[existingIndex] : null;
  const definition = createReusableAgentDefinition(agent, existing?.libraryId);
  if (existingIndex < 0) {
    return {
      definition,
      definitions: [...sanitized, definition].slice(-MAX_LIBRARY_ITEMS),
      updated: false,
    };
  }
  return {
    definition,
    definitions: sanitized.map((item, index) => index === existingIndex ? definition : item),
    updated: true,
  };
}

export function removeReusableAgentDefinition(
  definitions: ReusableAgentDefinition[],
  libraryId: string,
): ReusableAgentDefinition[] {
  return sanitizedDefinitions(definitions).filter((item) => item.libraryId !== libraryId);
}

export function restoreReusableAgentDefinition(
  definitions: ReusableAgentDefinition[],
  definition: ReusableAgentDefinition,
) {
  const sanitized = sanitizedDefinitions(definitions);
  const [restored] = sanitizedDefinitions([definition]);
  if (!restored) return sanitized;
  const alreadyPresent = sanitized.some((item) => (
    item.libraryId === restored.libraryId
    || normalizedDefinitionName(item.name) === normalizedDefinitionName(restored.name)
  ));
  return alreadyPresent ? sanitized : [...sanitized, restored].slice(-MAX_LIBRARY_ITEMS);
}

export function loadReusableAgentDefinitions(storage?: LibraryReadableStorage | null) {
  const target = storage === undefined ? browserStorage() : storage;
  if (!target) return [];
  try {
    const parsed = JSON.parse(target.getItem(AGENT_LIBRARY_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? sanitizedDefinitions(parsed) : [];
  } catch {
    return [];
  }
}

export function persistReusableAgentDefinitions(
  definitions: ReusableAgentDefinition[],
  storage?: LibraryWritableStorage | null,
) {
  const target = storage === undefined ? browserStorage() : storage;
  if (!target) return false;
  try {
    target.setItem(AGENT_LIBRARY_STORAGE_KEY, JSON.stringify(sanitizedDefinitions(definitions)));
    return true;
  } catch {
    return false;
  }
}

export function testAgentDefinition(agent: AgentWorkflowAgent, tools: AgentWorkflowTool[]) {
  const knownTools = new Set(tools.map((tool) => tool.id));
  const missingToolCount = agent.tools.filter((toolId) => !knownTools.has(toolId)).length;
  const checks: AgentDefinitionCheck[] = [
    { id: "role", label: "Focused role", passed: Boolean(agent.role.trim()), detail: agent.role.trim() ? "The agent has a clear assignment." : "Describe the one outcome this agent owns." },
    { id: "output", label: "Defined output", passed: Boolean(agent.output.trim()), detail: agent.output.trim() ? "The next agent knows what it will receive." : "Define the artifact this agent must produce." },
    { id: "model", label: "Model ready", passed: Boolean(agent.modelPreference.trim()), detail: agent.modelPreference.trim() ? "A model route is selected." : "Choose a model for this role." },
    { id: "tools", label: "Tool scope", passed: missingToolCount === 0, detail: missingToolCount ? `${missingToolCount} tool grant no longer exists.` : agent.tools.length ? `${agent.tools.length} explicit tool grant${agent.tools.length === 1 ? "" : "s"}.` : "No tools required." },
  ];
  return { passed: checks.every((check) => check.passed), checks };
}
