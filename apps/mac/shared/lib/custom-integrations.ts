import type { AgentRiskLevel } from "../stores/agent-workflow-store";
import { renderAgentHandoffTemplate } from "./agent-run-input";
import { sanitizeRemoteHeaderName, type SafeRemoteMethod } from "./safe-remote-contract";

export type CustomIntegrationKind = "webhook" | "openapi" | "mcp";
export const CUSTOM_INTEGRATIONS_CHANGED_EVENT = "codelit:custom-integrations-changed";
export type CustomIntegrationAuthMode = "none" | "bearer" | "api-key" | "oauth-token";
export type CustomIntegrationLifecycle = "connected" | "inspected" | "tested" | "sampled" | "live" | "drifted" | "revoked" | "blocked";
export type ReviewedJsonType = "string" | "number" | "integer" | "boolean" | "array" | "object";

export interface CustomConnectionRuntimePolicy {
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  writesRequireApproval: true;
  redirects: "blocked";
}

export const DEFAULT_CUSTOM_CONNECTION_POLICY: CustomConnectionRuntimePolicy = {
  timeoutMs: 15_000,
  maxRequestBytes: 32 * 1024,
  maxResponseBytes: 64 * 1024,
  writesRequireApproval: true,
  redirects: "blocked",
};

export interface ReviewedJsonSchema {
  type: ReviewedJsonType;
  description?: string;
  required?: string[];
  properties?: Record<string, ReviewedJsonSchema>;
  items?: ReviewedJsonSchema;
  enum?: Array<string | number | boolean>;
  maxLength?: number;
  maxItems?: number;
  additionalProperties?: false;
}

export interface ReviewedOpenApiOperation {
  id: string;
  name: string;
  method: SafeRemoteMethod;
  path: string;
  inputLocation: "query" | "json-body";
  effect: "read" | "write";
  risk: AgentRiskLevel;
  inputSchema: ReviewedJsonSchema;
  responseSchema?: ReviewedJsonSchema;
}

export interface ReviewedMcpTool {
  name: string;
  description: string;
  inputSchema: ReviewedJsonSchema;
  effect: "read" | "write";
  destructive: boolean;
  idempotent: boolean;
  risk: AgentRiskLevel;
}

export interface CustomConnectionAuth {
  mode: CustomIntegrationAuthMode;
  headerName?: string;
}

export interface PublicCustomConnection {
  id: string;
  kind: CustomIntegrationKind;
  name: string;
  endpoint: string;
  host: string;
  auth: CustomConnectionAuth;
  approvedScopes: string[];
  policy: CustomConnectionRuntimePolicy;
  operations: ReviewedOpenApiOperation[];
  tools: ReviewedMcpTool[];
  status: "ready" | "blocked";
  lifecycle: CustomIntegrationLifecycle;
  blockedReason?: string;
  fingerprint?: string;
  lastInspectedAt?: string;
  lastTestedAt?: string;
  lastSampledAt?: string;
  sampleOperationId?: string;
  liveAt?: string;
  driftedAt?: string;
  revokedAt?: string;
  oauth?: {
    resourceMetadataUrl: string;
    authorizationServers: string[];
    scopesSupported: string[];
  };
  createdAt: string;
  updatedAt: string;
}

export interface CustomActionConfig {
  kind: CustomIntegrationKind;
  connectionId: string;
  operationId: string;
  connectionName: string;
  operationName: string;
  host: string;
  effect: "read" | "write";
  risk: AgentRiskLevel;
  input: Record<string, unknown>;
}

export interface ImportedOpenApiReview {
  operation: ReviewedOpenApiOperation;
  auth: CustomConnectionAuth;
  blockedReason?: string;
}

interface CustomConnectionBoundary {
  approvedScopes: string[];
  policy: CustomConnectionRuntimePolicy;
}

export type CustomConnectionDraft = CustomConnectionBoundary & (
  | {
    kind: "webhook";
    name: string;
    endpoint: string;
    auth: { mode: "none" };
    credential?: string;
    operations: [];
    tools: [];
  }
  | {
    kind: "openapi";
    name: string;
    endpoint: string;
    auth: CustomConnectionAuth;
    credential?: string;
    operations: ReviewedOpenApiOperation[];
    tools: [];
  }
  | {
    kind: "mcp";
    name: string;
    endpoint: string;
    auth: CustomConnectionAuth;
    credential?: string;
    operations: [];
    tools: ReviewedMcpTool[];
  }
);

export type CustomConnectionDraftResult =
  | { ok: true; draft: CustomConnectionDraft }
  | { ok: false; reason: string };

const SCHEMA_TYPES = new Set<ReviewedJsonType>(["string", "number", "integer", "boolean", "array", "object"]);
const METHODS = new Set<SafeRemoteMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9_-]{10,160}$/;
const RISK_RANK: Record<AgentRiskLevel, number> = { low: 0, medium: 1, high: 2 };
const MAX_SCHEMA_DEPTH = 4;
const MAX_SCHEMA_PROPERTIES = 64;
const MAX_INPUT_BYTES = 24 * 1024;
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:./_-]{0,119}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, max: number) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function riskAtLeast(value: unknown, minimum: AgentRiskLevel): AgentRiskLevel {
  const risk: AgentRiskLevel = value === "high" || value === "medium" || value === "low" ? value : minimum;
  return RISK_RANK[risk] >= RISK_RANK[minimum] ? risk : minimum;
}

function approvedScopes(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => SCOPE_PATTERN.test(item))))
    .slice(0, 20);
}

function runtimePolicy(value: unknown): CustomConnectionRuntimePolicy {
  const raw = record(value) || {};
  const timeoutMs = typeof raw.timeoutMs === "number" && Number.isSafeInteger(raw.timeoutMs)
    ? Math.max(1_000, Math.min(raw.timeoutMs, 30_000))
    : DEFAULT_CUSTOM_CONNECTION_POLICY.timeoutMs;
  const maxResponseBytes = typeof raw.maxResponseBytes === "number" && Number.isSafeInteger(raw.maxResponseBytes)
    ? Math.max(4 * 1024, Math.min(raw.maxResponseBytes, 256 * 1024))
    : DEFAULT_CUSTOM_CONNECTION_POLICY.maxResponseBytes;
  return { ...DEFAULT_CUSTOM_CONNECTION_POLICY, timeoutMs, maxResponseBytes };
}

function endpoint(value: unknown) {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > 2_048) return null;
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.hash
      || parsed.search
      || parsed.port && parsed.port !== "443"
      || !host.includes(".")
      || host === "localhost"
      || [".localhost", ".local", ".internal", ".home", ".lan"].some((suffix) => host.endsWith(suffix))
      || /%(?:2e|2f|5c)/i.test(parsed.pathname)
    ) return null;
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/");
    return parsed.toString();
  } catch {
    return null;
  }
}

export function sanitizeReviewedJsonSchema(value: unknown): ReviewedJsonSchema | null {
  let propertyCount = 0;
  const visit = (candidate: unknown, depth: number): ReviewedJsonSchema | null => {
    const raw = record(candidate);
    const type = raw?.type;
    if (!raw || !SCHEMA_TYPES.has(type as ReviewedJsonType) || depth > MAX_SCHEMA_DEPTH) return null;
    const output: ReviewedJsonSchema = { type: type as ReviewedJsonType };
    const description = text(raw.description, 240);
    if (description) output.description = description;
    if (output.type === "string") {
      output.maxLength = typeof raw.maxLength === "number" && Number.isSafeInteger(raw.maxLength)
        ? Math.max(1, Math.min(raw.maxLength, 8_000))
        : 8_000;
    }
    if (Array.isArray(raw.enum)) {
      const values = raw.enum.filter((item): item is string | number | boolean => {
        if (output.type === "string") return typeof item === "string" && item.length <= (output.maxLength || 8_000);
        if (output.type === "number") return typeof item === "number" && Number.isFinite(item);
        if (output.type === "integer") return typeof item === "number" && Number.isSafeInteger(item);
        if (output.type === "boolean") return typeof item === "boolean";
        return false;
      }).slice(0, 20);
      if (raw.enum.length && !values.length) return null;
      if (values.length) output.enum = values;
    }
    if (output.type === "array") {
      const items = visit(raw.items || { type: "string" }, depth + 1);
      if (!items) return null;
      output.items = items;
      output.maxItems = typeof raw.maxItems === "number" && Number.isSafeInteger(raw.maxItems)
        ? Math.max(1, Math.min(raw.maxItems, 100))
        : 50;
    }
    if (output.type === "object") {
      const rawProperties = record(raw.properties) || {};
      const properties: Record<string, ReviewedJsonSchema> = {};
      for (const [key, child] of Object.entries(rawProperties)) {
        if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(key) || propertyCount >= MAX_SCHEMA_PROPERTIES) return null;
        const parsed = visit(child, depth + 1);
        if (!parsed) return null;
        propertyCount += 1;
        properties[key] = parsed;
      }
      output.properties = properties;
      output.required = Array.isArray(raw.required)
        ? Array.from(new Set(raw.required.filter((item): item is string => typeof item === "string" && Object.prototype.hasOwnProperty.call(properties, item)))).slice(0, MAX_SCHEMA_PROPERTIES)
        : [];
      output.additionalProperties = false;
    }
    return output;
  };
  return visit(value, 0);
}

function reviewedPath(value: unknown) {
  if (typeof value !== "string") return "";
  const path = value.trim();
  if (!path.startsWith("/") || path.length > 1_024 || /[\\?#{}]/.test(path)) return "";
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return "";
  return path.replace(/\/{2,}/g, "/");
}

export function sanitizeReviewedOpenApiOperation(value: unknown): ReviewedOpenApiOperation | null {
  const raw = record(value);
  const method = text(raw?.method, 10).toUpperCase() as SafeRemoteMethod;
  const path = reviewedPath(raw?.path);
  const id = text(raw?.id, 128);
  const name = text(raw?.name, 120) || id;
  const inputSchema = sanitizeReviewedJsonSchema(raw?.inputSchema || { type: "object", properties: {}, additionalProperties: false });
  const inputLocation = raw?.inputLocation === "query" || raw?.inputLocation === "json-body"
    ? raw.inputLocation
    : method === "GET" || method === "DELETE" ? "query" : "json-body";
  const responseSchema = raw?.responseSchema === undefined ? undefined : sanitizeReviewedJsonSchema(raw.responseSchema);
  if (!raw || !ID_PATTERN.test(id) || !name || !METHODS.has(method) || !path || !inputSchema || (method === "GET" && inputLocation !== "query") || raw.responseSchema !== undefined && !responseSchema) return null;
  const effect = method === "GET" ? "read" : "write";
  return {
    id,
    name,
    method,
    path,
    inputLocation,
    effect,
    risk: riskAtLeast(raw.risk, effect === "read" ? "low" : "medium"),
    inputSchema,
    ...(responseSchema ? { responseSchema } : {}),
  };
}

export function sanitizeReviewedMcpTool(value: unknown): ReviewedMcpTool | null {
  const raw = record(value);
  const annotations = record(raw?.annotations) || {};
  const name = text(raw?.name, 128);
  const description = text(raw?.description, 500) || "Remote MCP tool";
  const inputSchema = sanitizeReviewedJsonSchema(raw?.inputSchema || { type: "object", properties: {}, additionalProperties: false });
  if (!raw || !ID_PATTERN.test(name) || !inputSchema) return null;
  const destructive = raw.destructive === true || annotations.destructiveHint === true;
  const effect = destructive
    ? "write"
    : raw.effect === "read" || raw.effect === "write"
      ? raw.effect
      : annotations.readOnlyHint === true ? "read" : "write";
  const idempotent = raw.idempotent === true || annotations.idempotentHint === true;
  return {
    name,
    description,
    inputSchema,
    effect,
    destructive,
    idempotent,
    risk: riskAtLeast(raw.risk, destructive ? "high" : effect === "read" ? "low" : "medium"),
  };
}

function auth(value: unknown): { auth: CustomConnectionAuth; credential?: string } | null {
  const raw = record(value) || {};
  const mode = raw.mode === "bearer" || raw.mode === "api-key" || raw.mode === "oauth-token" ? raw.mode : raw.mode === "none" || raw.mode === undefined ? "none" : null;
  if (!mode) return null;
  const credential = typeof raw.credential === "string" ? raw.credential.trim().slice(0, 8_192) : "";
  if (mode !== "none" && !credential) return null;
  if (mode === "api-key") {
    const headerName = sanitizeRemoteHeaderName(raw.headerName || "X-API-Key");
    if (!headerName || headerName.toLowerCase() === "authorization") return null;
    return { auth: { mode, headerName }, credential };
  }
  return { auth: { mode }, ...(credential ? { credential } : {}) };
}

export function sanitizeCustomConnectionDraft(value: unknown): CustomConnectionDraftResult {
  const raw = record(value);
  const kind = raw?.kind;
  const name = text(raw?.name, 100);
  const safeEndpoint = endpoint(raw?.endpoint);
  if (!raw || !name || !safeEndpoint || (kind !== "webhook" && kind !== "openapi" && kind !== "mcp")) {
    return { ok: false, reason: "Name, supported kind, and a public credential-free HTTPS endpoint are required" };
  }
  const boundary = { approvedScopes: approvedScopes(raw.approvedScopes), policy: runtimePolicy(raw.policy) };
  if (kind === "webhook") return { ok: true, draft: { kind, name, endpoint: safeEndpoint, auth: { mode: "none" }, operations: [], tools: [], ...boundary } };
  const reviewedAuth = auth(raw.auth);
  if (!reviewedAuth) return { ok: false, reason: "The reviewed authentication configuration is invalid" };
  if (kind === "openapi") {
    const rawOperations = Array.isArray(raw.operations) ? raw.operations.slice(0, 50) : [];
    const operations = rawOperations.map(sanitizeReviewedOpenApiOperation).filter((item): item is ReviewedOpenApiOperation => Boolean(item));
    if (!operations.length || operations.length !== rawOperations.length || new Set(operations.map((item) => item.id)).size !== operations.length) {
      return { ok: false, reason: "OpenAPI operations must have unique IDs, fixed paths, bounded schemas, and supported methods" };
    }
    return { ok: true, draft: { kind, name, endpoint: safeEndpoint, ...reviewedAuth, operations, tools: [], ...boundary } };
  }
  const rawTools = Array.isArray(raw.tools) ? raw.tools.slice(0, 100) : [];
  const tools = rawTools.map(sanitizeReviewedMcpTool).filter((item): item is ReviewedMcpTool => Boolean(item));
  const normalizedNames = tools.map((item) => item.name.toLowerCase());
  if (tools.length !== rawTools.length || new Set(normalizedNames).size !== tools.length) {
    return { ok: false, reason: "Remote MCP tool names and bounded schemas must be unique and valid" };
  }
  return { ok: true, draft: { kind, name, endpoint: safeEndpoint, ...reviewedAuth, operations: [], tools, ...boundary } };
}

function sanitizeInputValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_SCHEMA_DEPTH) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.replace(/[\u0000\u007f]/g, " ").slice(0, 8_000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeInputValue(item, depth + 1)).filter((item) => item !== undefined);
  const raw = record(value);
  if (!raw) return undefined;
  return Object.fromEntries(Object.entries(raw).slice(0, MAX_SCHEMA_PROPERTIES).flatMap(([key, item]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(key)) return [];
    const parsed = sanitizeInputValue(item, depth + 1);
    return parsed === undefined ? [] : [[key, parsed]];
  }));
}

export function sanitizeCustomActionConfig(value: unknown): CustomActionConfig | null {
  const raw = record(value);
  const kind = raw?.kind;
  const connectionId = text(raw?.connectionId, 160);
  const operationId = text(raw?.operationId, 128);
  const connectionName = text(raw?.connectionName, 100);
  const operationName = text(raw?.operationName, 120);
  const host = text(raw?.host, 253).toLowerCase();
  const effect = raw?.effect === "read" ? "read" : raw?.effect === "write" ? "write" : null;
  const risk = raw?.risk === "low" || raw?.risk === "medium" || raw?.risk === "high" ? raw.risk : null;
  const input = sanitizeInputValue(raw?.input || {});
  if (
    !raw
    || (kind !== "webhook" && kind !== "openapi" && kind !== "mcp")
    || !CONNECTION_ID_PATTERN.test(connectionId)
    || !ID_PATTERN.test(operationId)
    || !connectionName
    || !operationName
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
    || !effect
    || !risk
    || (kind === "webhook" && effect !== "write")
    || !record(input)
  ) return null;
  const config: CustomActionConfig = { kind, connectionId, operationId, connectionName, operationName, host, effect, risk, input: input as Record<string, unknown> };
  return new TextEncoder().encode(JSON.stringify(config.input)).byteLength <= MAX_INPUT_BYTES ? config : null;
}

export function sanitizeImportedOpenApiReview(value: unknown): ImportedOpenApiReview | null {
  const raw = record(value);
  const operation = sanitizeReviewedOpenApiOperation(raw?.operation);
  const rawAuth = record(raw?.auth);
  const mode = rawAuth?.mode === "none" || rawAuth?.mode === "bearer" || rawAuth?.mode === "api-key" || rawAuth?.mode === "oauth-token" ? rawAuth.mode : null;
  if (!raw || !operation || !mode) return null;
  const headerName = mode === "api-key" ? sanitizeRemoteHeaderName(rawAuth?.headerName || "X-API-Key") : undefined;
  if (mode === "api-key" && (!headerName || headerName.toLowerCase() === "authorization")) return null;
  const blockedReason = text(raw.blockedReason, 300);
  return {
    operation,
    auth: { mode, ...(headerName ? { headerName } : {}) },
    ...(blockedReason ? { blockedReason } : {}),
  };
}

export function customActionPreview(config: CustomActionConfig) {
  const target = `${config.connectionName} (${config.host})`;
  if (config.kind === "webhook") return [`Send one signed webhook to ${target}`];
  if (config.kind === "mcp") return [`${config.effect === "read" ? "Read with" : "Call"} reviewed MCP tool ${config.operationName} on ${target}`];
  return [`${config.effect === "read" ? "Read with" : "Call"} ${config.operationName} on ${target}`];
}

export function customActionApprovalPreview(config: CustomActionConfig) {
  const input = JSON.stringify(config.input);
  return [...customActionPreview(config), `Input: ${input.length > 2_000 ? `${input.slice(0, 2_000)}...` : input}`];
}

export function renderCustomActionInput(input: Record<string, unknown>, handoff: string): Record<string, unknown> {
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return renderAgentHandoffTemplate(value, handoff, 8_000);
    if (Array.isArray(value)) return value.map(visit);
    const raw = record(value);
    return raw ? Object.fromEntries(Object.entries(raw).map(([key, child]) => [key, visit(child)])) : value;
  };
  return visit(input) as Record<string, unknown>;
}

export function validateReviewedJson(value: unknown, schema: ReviewedJsonSchema, path = "$", errors: string[] = []): string[] {
  if (errors.length >= 20) return errors;
  const fail = (message: string) => { errors.push(`${path} ${message}`); };
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) fail("is not an approved enum value");
  if (schema.type === "string") {
    if (typeof value !== "string") fail("must be a string");
    else if (value.length > (schema.maxLength || 8_000)) fail("exceeds the string limit");
  } else if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) fail("must be a finite number");
  } else if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) fail("must be an integer");
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") fail("must be a boolean");
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) fail("must be an array");
    else if (value.length > (schema.maxItems || 50)) fail("exceeds the item limit");
    else value.forEach((item, index) => validateReviewedJson(item, schema.items || { type: "string" }, `${path}[${index}]`, errors));
  } else if (schema.type === "object") {
    const raw = record(value);
    if (!raw) fail("must be an object");
    else {
      const properties = schema.properties || {};
      for (const required of schema.required || []) if (!Object.prototype.hasOwnProperty.call(raw, required)) errors.push(`${path}.${required} is required`);
      for (const [key, child] of Object.entries(raw)) {
        const childSchema = properties[key];
        if (!childSchema) errors.push(`${path}.${key} is not an approved property`);
        else validateReviewedJson(child, childSchema, `${path}.${key}`, errors);
        if (errors.length >= 20) break;
      }
    }
  }
  return errors.slice(0, 20);
}
