import type {
  AgentRunInputDefinition,
  AgentRunInputField,
  AgentRunInputOption,
  AgentRunInputFieldType,
} from "../stores/agent-workflow-store";
import { agentLibraryValueHasRedactions, sanitizeAgentLibraryText } from "./agent-library";

const FIELD_ID = /^[a-z][A-Za-z0-9_]{0,39}$/;
const FIELD_TYPES = new Set<AgentRunInputFieldType>(["text", "textarea", "email", "url", "integer", "currency", "select"]);
const OPTION_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const HANDOFF_TOKEN = /\{\{handoff(?:\.([A-Za-z][A-Za-z0-9_.-]{0,159}))?\}\}/g;
const MAX_FIELDS = 6;
const MAX_HANDOFF_CHARS = 8_000;
const RUN_INPUT_DRAFT_PREFIX = "codelit-agent-run-input-draft:v1:";

interface RunInputDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function cleanText(value: unknown, max: number) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function sanitizeField(value: unknown): AgentRunInputField | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = cleanText(raw.id, 40);
  const label = cleanText(raw.label, 80);
  const type = cleanText(raw.type, 20) as AgentRunInputFieldType;
  if (!FIELD_ID.test(id) || !label || type && !FIELD_TYPES.has(type)) return null;
  const placeholder = cleanText(raw.placeholder, 160);
  const options = (Array.isArray(raw.options) ? raw.options : []).slice(0, 8).flatMap((option): AgentRunInputOption[] => {
    if (!option || typeof option !== "object" || Array.isArray(option)) return [];
    const candidate = option as Record<string, unknown>;
    const optionValue = cleanText(candidate.value, 40);
    const optionLabel = cleanText(candidate.label, 80);
    return OPTION_VALUE.test(optionValue) && optionLabel ? [{ value: optionValue, label: optionLabel }] : [];
  });
  const min = typeof raw.min === "number" && Number.isSafeInteger(raw.min) ? raw.min : undefined;
  const max = typeof raw.max === "number" && Number.isSafeInteger(raw.max) ? raw.max : undefined;
  if (type === "select" && (options.length < 2 || options.length !== (Array.isArray(raw.options) ? raw.options.length : 0) || new Set(options.map((option) => option.value)).size !== options.length)) return null;
  if (type !== "select" && raw.options !== undefined) return null;
  const boundedNumber = type === "integer" || type === "currency";
  if (!boundedNumber && (raw.min !== undefined || raw.max !== undefined)) return null;
  if (boundedNumber && ((raw.min !== undefined && min === undefined) || (raw.max !== undefined && max === undefined) || (min !== undefined && max !== undefined && min > max))) return null;
  return {
    id,
    label,
    ...(type && type !== "text" ? { type } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(raw.required === true ? { required: true } : {}),
    ...(type === "select" ? { options } : {}),
    ...(boundedNumber && min !== undefined ? { min } : {}),
    ...(boundedNumber && max !== undefined ? { max } : {}),
  };
}

export function sanitizeAgentRunInput(value: unknown): AgentRunInputDefinition | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const title = cleanText(raw.title, 100);
  const fields = (Array.isArray(raw.fields) ? raw.fields : []).slice(0, MAX_FIELDS).map(sanitizeField);
  if (!title || !fields.length || fields.some((field) => !field)) return undefined;
  const reviewed = fields as AgentRunInputField[];
  if (new Set(reviewed.map((field) => field.id)).size !== reviewed.length) return undefined;
  const preset = raw.preset === undefined ? undefined : raw.preset === "github-issue" ? raw.preset : null;
  if (preset === null) return undefined;
  if (preset === "github-issue") {
    const repository = reviewed.find((field) => field.id === "repository");
    const issueNumber = reviewed.find((field) => field.id === "issueNumber");
    if (!repository?.required || repository.type && repository.type !== "text") return undefined;
    if (!issueNumber?.required || issueNumber.type !== "integer" || (issueNumber.min ?? 0) < 1) return undefined;
  }
  const description = cleanText(raw.description, 300);
  const submitLabel = cleanText(raw.submitLabel, 40);
  return {
    title,
    ...(preset ? { preset } : {}),
    ...(description ? { description } : {}),
    ...(submitLabel ? { submitLabel } : {}),
    fields: reviewed,
  };
}

export function sanitizeAgentRunInputValues(definition: AgentRunInputDefinition, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const field of definition.fields) {
    const candidate = raw[field.id];
    if (typeof candidate !== "string") continue;
    const max = field.type === "textarea" ? 4_000 : 500;
    const clean = candidate.replace(/[\u0000\u007f]/g, " ").trim().slice(0, max);
    if (clean) values[field.id] = clean;
  }
  return values;
}

function runInputDraftKey(workflowId: string) {
  const id = cleanText(workflowId, 200);
  return id ? `${RUN_INPUT_DRAFT_PREFIX}${encodeURIComponent(id)}` : "";
}

function sanitizeAgentRunInputDraftValues(definition: AgentRunInputDefinition, value: unknown) {
  const values = sanitizeAgentRunInputValues(definition, value);
  return Object.fromEntries(Object.entries(values).filter(([, candidate]) => (
    !agentLibraryValueHasRedactions(sanitizeAgentLibraryText(candidate, 4_000))
  )));
}

export function hasAgentRunInputDraft(workflowId: string, storage?: RunInputDraftStorage) {
  const key = runInputDraftKey(workflowId);
  if (!key || !storage) return false;
  try {
    return storage.getItem(key) !== null;
  } catch {
    return false;
  }
}

export function clearAgentRunInputDraft(workflowId: string, storage?: RunInputDraftStorage) {
  const key = runInputDraftKey(workflowId);
  if (!key || !storage?.removeItem) return;
  try {
    storage.removeItem(key);
  } catch {
    // The active flow can continue when browser storage is unavailable.
  }
}

export function isDerivedAgentRunInputField(definition: AgentRunInputDefinition, fieldId: string) {
  return fieldId === "approvedDomain"
    && definition.fields.some((field) => field.id === "websiteUrl" && field.type === "url");
}

export function prepareAgentRunInputValues(definition: AgentRunInputDefinition, values: Record<string, string>) {
  if (!isDerivedAgentRunInputField(definition, "approvedDomain")) return values;
  const websiteUrl = values.websiteUrl?.trim();
  if (!websiteUrl) return { ...values, approvedDomain: "" };
  try {
    const parsed = new URL(websiteUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return { ...values, approvedDomain: "" };
    }
    return { ...values, approvedDomain: parsed.hostname.toLowerCase() };
  } catch {
    return { ...values, approvedDomain: "" };
  }
}

export function readAgentRunInputDraft(
  definition: AgentRunInputDefinition,
  workflowId: string,
  storage?: RunInputDraftStorage,
) {
  const key = runInputDraftKey(workflowId);
  if (!key || !storage) return {};
  try {
    const serialized = storage.getItem(key);
    if (!serialized) return {};
    return prepareAgentRunInputValues(definition, sanitizeAgentRunInputDraftValues(definition, JSON.parse(serialized)));
  } catch {
    return {};
  }
}

export function writeAgentRunInputDraft(
  definition: AgentRunInputDefinition,
  workflowId: string,
  values: Record<string, string>,
  storage?: RunInputDraftStorage,
) {
  const key = runInputDraftKey(workflowId);
  if (!key || !storage) return;
  const safeValues = prepareAgentRunInputValues(definition, sanitizeAgentRunInputDraftValues(definition, values));
  try {
    storage.setItem(key, JSON.stringify(safeValues));
  } catch {
    // A run can still start when tab storage is unavailable.
  }
}

function currencyMinorUnits(value: string): number | null {
  const normalized = value.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(amount) ? amount : null;
}

function currencyLabel(value: number) {
  return `$${(value / 100).toFixed(2)}`;
}

export function agentRunInputFieldError(field: AgentRunInputField, rawValue: string | undefined): string | null {
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (field.required && !value) return `${field.label} is required`;
  if (!value) return null;
  if (field.type === "email" && !/^[^\s@]{1,128}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/.test(value)) {
    return `${field.label} must be a valid email`;
  }
  if (field.type === "url") {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) {
        return `${field.label} must be a credential-free HTTPS URL`;
      }
    } catch {
      return `${field.label} must be a credential-free HTTPS URL`;
    }
  }
  if (field.type === "integer") {
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
      return `${field.label} must be a whole number`;
    }
    const number = Number(value);
    if (field.min !== undefined && number < field.min) return `${field.label} must be at least ${field.min}`;
    if (field.max !== undefined && number > field.max) return `${field.label} must be at most ${field.max}`;
  }
  if (field.type === "currency") {
    const amount = currencyMinorUnits(value);
    if (amount === null) return `${field.label} must be a valid amount with up to two decimal places`;
    if (field.min !== undefined && amount < field.min) return `${field.label} must be at least ${currencyLabel(field.min)}`;
    if (field.max !== undefined && amount > field.max) return `${field.label} must be at most ${currencyLabel(field.max)}`;
  }
  if (field.type === "select" && !field.options?.some((option) => option.value === value)) {
    return `${field.label} is invalid`;
  }
  return null;
}

export function agentRunInputValuesReady(definition: AgentRunInputDefinition | undefined, values: Record<string, string>) {
  if (!definition) return true;
  const reviewedValues = prepareAgentRunInputValues(definition, values);
  return definition.fields.every((field) => !agentRunInputFieldError(field, reviewedValues[field.id]));
}

export function buildAgentRunHandoff(definition: AgentRunInputDefinition, values: Record<string, string>) {
  const reviewedValues = prepareAgentRunInputValues(definition, values);
  const payload: Record<string, string> = {};
  for (const field of definition.fields) {
    const max = field.type === "textarea" ? 4_000 : 500;
    const value = typeof reviewedValues[field.id] === "string"
      ? reviewedValues[field.id].replace(/[\u0000\u007f]/g, " ").trim().slice(0, max)
      : "";
    const error = agentRunInputFieldError(field, value);
    if (error) throw new Error(error);
    if (value) payload[field.id] = field.type === "currency" ? String(currencyMinorUnits(value)) : value;
  }
  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_HANDOFF_CHARS) throw new Error("Run brief is too long. Shorten the details and try again");
  return serialized;
}

function structuredHandoff(handoff: string): Record<string, unknown> | null {
  const trimmed = handoff.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  const embedded = firstBrace >= 0 && lastBrace > firstBrace ? trimmed.slice(firstBrace, lastBrace + 1) : "";
  for (const candidate of [fenced, trimmed, embedded]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Try the next bounded representation.
    }
  }
  return null;
}

export function agentRunInputValuesFromHandoff(
  definition: AgentRunInputDefinition,
  handoff: string,
) {
  const data = structuredHandoff(handoff.slice(0, MAX_HANDOFF_CHARS));
  if (!data) return {};
  const values: Record<string, string> = {};
  for (const field of definition.fields) {
    const candidate = data[field.id];
    if (typeof candidate !== "string" && typeof candidate !== "number" && typeof candidate !== "boolean") continue;
    if (field.type === "currency") {
      const minorUnits = typeof candidate === "number" ? candidate : Number(candidate);
      if (!Number.isSafeInteger(minorUnits)) continue;
      values[field.id] = (minorUnits / 100).toFixed(2).replace(/\.00$/, "");
      continue;
    }
    values[field.id] = String(candidate);
  }
  return prepareAgentRunInputValues(definition, sanitizeAgentRunInputValues(definition, values));
}

function fieldValue(data: Record<string, unknown> | null, path: string) {
  let value: unknown = data;
  for (const segment of path.split(".").slice(0, 6)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    value = (value as Record<string, unknown>)[segment];
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    try { return JSON.stringify(value); } catch { return ""; }
  }
  return "";
}

export function renderAgentHandoffTemplate(template: string, handoff: string, max: number) {
  const safeHandoff = handoff.replace(/[\u0000\u007f]/g, " ").trim().slice(0, MAX_HANDOFF_CHARS);
  const data = structuredHandoff(safeHandoff);
  return template.replace(HANDOFF_TOKEN, (_token, path: string | undefined) => (
    path ? fieldValue(data, path) : safeHandoff
  )).slice(0, max).trim();
}
