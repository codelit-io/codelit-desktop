import type {
  BotSkill,
  BrowserTeachingEvent,
  BrowserTeachingRisk,
  LocalBrowserTeachingCapture,
  LocalBrowserTeachingDryRun,
} from "./contracts";
import { parseBotBrowserTarget } from "./bot-policy";

const RECIPE_START = "[codelit-browser-recipe-v1]";
const RECIPE_END = "[/codelit-browser-recipe-v1]";
const MAX_RECIPE_STEPS = 32;
const MAX_RECIPE_INPUTS = 8;

export interface TaughtBrowserRecipeInput {
  id: string;
  label: string;
  type: "text" | "email" | "number";
}

export interface TaughtBrowserRecipeStep {
  id: string;
  type: BrowserTeachingEvent["type"];
  url: string;
  risk: BrowserTeachingRisk;
  target?: {
    expression: string;
    label: string;
  };
  inputId?: string;
}

export interface TaughtBrowserRecipe {
  schemaVersion: 1;
  startUrl: string;
  approvedDomains: string[];
  inputs: TaughtBrowserRecipeInput[];
  steps: TaughtBrowserRecipeStep[];
  capturedAt: string;
}

export interface TaughtBrowserRecipeDraft {
  name: string;
  description: string;
  instructions: string;
  capabilityIds: ["browser-read", "browser-act"];
  recipe: TaughtBrowserRecipe;
}

export interface BrowserTeachingRequest {
  name: string;
  url: string;
  host: string;
}

export interface BrowserSkillRunRequest {
  skill: BotSkill;
  recipe: TaughtBrowserRecipe;
}

function clean(value: unknown, max: number) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function safeName(value: string, host: string) {
  const candidate = clean(value, 64)
    .replace(/^["'“”‘’\s:,-]+|["'“”‘’\s.,;:-]+$/g, "")
    .replace(/^(?:called|named)\s+/i, "");
  if (candidate.length >= 2) return candidate;
  const brand = host.split(".")[0]?.replace(/[^a-z0-9]+/gi, " ").trim() || "Website";
  return `${brand.charAt(0).toUpperCase()}${brand.slice(1)} task`;
}

export function parseBrowserTeachingRequest(value: string): BrowserTeachingRequest | null {
  const text = clean(value, 2_000);
  if (!/(?:\bteach\b|\brecord\b|\bdemonstrate\b).{0,40}\b(?:browser|website|web)\b/i.test(text)
    && !/\bteach\s+(?:this|a)\s+task\b/i.test(text)) return null;
  const target = parseBotBrowserTarget(text);
  if (target.kind !== "target") return null;
  const withoutUrl = text.replace(target.url, " ").replace(/https?:\/\/[^\s<>'"`]+/i, " ");
  const called = withoutUrl.match(/\b(?:called|named)\s+["“]?(.+?)["”]?(?:\s+at\s*$|$)/i)?.[1] || "";
  const remainder = withoutUrl
    .replace(/^(?:please\s+)?(?:teach|record|demonstrate)\s+(?:me\s+)?(?:this\s+|a\s+)?(?:browser|website|web)?\s*(?:task|workflow|skill)?\s*/i, "")
    .replace(/\b(?:called|named)\b.*$/i, "")
    .replace(/\bat\s*$/i, "");
  return {
    name: safeName(called || remainder, target.host),
    url: target.url,
    host: target.host,
  };
}

function inputType(value: string): TaughtBrowserRecipeInput["type"] {
  if (value === "email") return "email";
  if (value === "number") return "number";
  return "text";
}

function inputId(label: string, used: Set<string>) {
  const stem = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 28);
  const base = /^[a-z]/.test(stem) ? stem : "browser_input";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base.slice(0, 25)}_${suffix++}`;
  used.add(candidate);
  return candidate;
}

export function browserProtectedStepLabel(risk: BrowserTeachingRisk) {
  if (risk === "cross-domain") return "Approve a new website boundary manually";
  if (risk === "login") return "Take over for identity or consent";
  if (risk === "payment") return "Review the purchase step manually";
  if (risk === "destructive") return "Review the irreversible step manually";
  if (risk === "upload") return "Take over for file selection";
  if (risk === "download") return "Approve one quarantined download";
  if (risk === "private-data") return "Take over for the private control";
  return "Take over for this unsupported control";
}

function actionLabel(step: TaughtBrowserRecipeStep, inputs: TaughtBrowserRecipeInput[]) {
  if (step.type === "navigate") return `Open ${new URL(step.url).hostname}`;
  if (step.risk !== "none") return browserProtectedStepLabel(step.risk);
  const label = step.target?.label || "page control";
  if (step.type === "fill") {
    const input = inputs.find((candidate) => candidate.id === step.inputId);
    return `Enter ${input?.label || label} at run time`;
  }
  return `Click ${label}`;
}

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, 500);
  } catch {
    return "";
  }
}

export function buildTaughtBrowserRecipeDraft(
  nameValue: string,
  capture: LocalBrowserTeachingCapture,
  dryRun: LocalBrowserTeachingDryRun,
): TaughtBrowserRecipeDraft {
  if (!dryRun.passed) throw new Error("Check the browser replay before saving this skill.");
  const name = safeName(nameValue, capture.approvedDomains[0] || "website");
  const startUrl = safeUrl(capture.startUrl);
  const approvedDomains = [...new Set(capture.approvedDomains.map((domain) => clean(domain.toLowerCase(), 253)).filter(Boolean))].slice(0, 16);
  if (!startUrl || !approvedDomains.length || !approvedDomains.includes(new URL(startUrl).hostname.toLowerCase())) {
    throw new Error("The demonstrated website boundary is invalid.");
  }
  const usedInputs = new Set<string>();
  const inputs: TaughtBrowserRecipeInput[] = [];
  const steps: TaughtBrowserRecipeStep[] = [];
  for (const [index, event] of capture.events.slice(0, MAX_RECIPE_STEPS).entries()) {
    const url = safeUrl(event.url);
    if (!url) continue;
    const risk = event.risk;
    const target = event.target && risk === "none"
      ? { expression: clean(event.target.expression, 180), label: clean(event.target.label, 120) || "Page control" }
      : undefined;
    if (event.type !== "navigate" && risk === "none" && (!target?.expression || !target.label)) continue;
    let fieldId: string | undefined;
    if (event.type === "fill" && risk === "none") {
      if (inputs.length >= MAX_RECIPE_INPUTS) throw new Error(`A taught task can ask for at most ${MAX_RECIPE_INPUTS} run-time values.`);
      fieldId = inputId(target?.label || "Browser input", usedInputs);
      inputs.push({ id: fieldId, label: target?.label || "Browser input", type: inputType(event.target?.inputType || "") });
    }
    steps.push({
      id: `step-${index + 1}`,
      type: event.type,
      url,
      risk,
      ...(target ? { target } : {}),
      ...(fieldId ? { inputId: fieldId } : {}),
    });
  }
  if (!steps.some((step) => step.risk === "none" && step.type !== "navigate")) {
    throw new Error("Demonstrate at least one safe click or field before saving this task.");
  }
  const recipe: TaughtBrowserRecipe = {
    schemaVersion: 1,
    startUrl,
    approvedDomains,
    inputs,
    steps,
    capturedAt: capture.startedAt,
  };
  const summary = steps.map((step, index) => `${index + 1}. ${actionLabel(step, inputs)}`).join("\n");
  const instructions = [
    "Repeat this reviewed browser task inside its approved website boundary.",
    "Ask for every run-time input when the task starts. Never retain entered values.",
    "Require Allow once before each click or typed input, and stop for every takeover step.",
    summary,
    RECIPE_START,
    JSON.stringify(recipe),
    RECIPE_END,
  ].join("\n");
  if (instructions.length > 4_000) throw new Error("This demonstration is too long. Teach a smaller task with fewer steps.");
  return {
    name,
    description: `${steps.length} reviewed browser ${steps.length === 1 ? "step" : "steps"} on ${new URL(startUrl).hostname}.`,
    instructions,
    capabilityIds: ["browser-read", "browser-act"],
    recipe,
  };
}

function validRisk(value: unknown): value is BrowserTeachingRisk {
  return ["none", "cross-domain", "private-data", "login", "payment", "destructive", "upload", "download", "unsupported"].includes(String(value));
}

export function parseTaughtBrowserRecipe(value: string): TaughtBrowserRecipe | null {
  const start = value.indexOf(RECIPE_START);
  const end = value.indexOf(RECIPE_END, start + RECIPE_START.length);
  if (start < 0 || end < 0) return null;
  try {
    const raw = JSON.parse(value.slice(start + RECIPE_START.length, end).trim()) as Partial<TaughtBrowserRecipe>;
    if (raw.schemaVersion !== 1 || !safeUrl(raw.startUrl || "")
      || !Array.isArray(raw.approvedDomains) || raw.approvedDomains.length < 1 || raw.approvedDomains.length > 16
      || !raw.approvedDomains.every((domain) => typeof domain === "string" && domain.length > 0 && domain.length <= 253)
      || !Array.isArray(raw.inputs) || raw.inputs.length > MAX_RECIPE_INPUTS
      || !raw.inputs.every((input) => input && typeof input.id === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(input.id)
        && typeof input.label === "string" && input.label.length > 0 && input.label.length <= 120
        && ["text", "email", "number"].includes(input.type))
      || !Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > MAX_RECIPE_STEPS
      || typeof raw.capturedAt !== "string" || !Number.isFinite(Date.parse(raw.capturedAt))) return null;
    const inputIds = new Set(raw.inputs.map((input) => input.id));
    if (!raw.steps.every((step) => step && typeof step.id === "string"
      && ["navigate", "click", "fill", "select"].includes(step.type)
      && Boolean(safeUrl(step.url)) && validRisk(step.risk)
      && (step.type === "navigate" || step.risk !== "none" || (step.target
        && typeof step.target.expression === "string" && step.target.expression.length > 0 && step.target.expression.length <= 180
        && typeof step.target.label === "string" && step.target.label.length > 0 && step.target.label.length <= 120))
      && (step.type !== "fill" || step.risk !== "none" || (typeof step.inputId === "string" && inputIds.has(step.inputId))))) return null;
    return raw as TaughtBrowserRecipe;
  } catch {
    return null;
  }
}

export function taughtBrowserRecipeForSkill(skill: BotSkill) {
  if (!skill.capabilityIds.includes("browser-act") || skill.trustState !== "reviewed") return null;
  return parseTaughtBrowserRecipe(skill.instructions);
}

function normalizedRunName(value: string) {
  return clean(value, 100)
    .replace(/^["'“”‘’\s]+|["'“”‘’\s.!]+$/g, "")
    .toLowerCase();
}

export function parseBrowserSkillRunRequest(
  value: string,
  skills: BotSkill[],
): BrowserSkillRunRequest | null {
  const text = clean(value, 2_000);
  const match = text.match(
    /^(?:run|replay|start|use)\s+(?:the\s+)?(?:(?:browser\s+)?(?:task|skill)\s+)?(.+?)(?:\s+(?:again|now))?[.!]?$/i,
  );
  if (!match) return null;
  const requestedName = normalizedRunName(match[1] || "");
  if (!requestedName) return null;
  for (const skill of skills) {
    if (normalizedRunName(skill.name) !== requestedName) continue;
    const recipe = taughtBrowserRecipeForSkill(skill);
    if (recipe) return { skill, recipe };
  }
  return null;
}

function runtimeInputValue(
  input: TaughtBrowserRecipeInput,
  values: Readonly<Record<string, string>>,
) {
  const value = values[input.id] ?? "";
  if (!value.trim()) throw new Error(`${input.label} is required for this run.`);
  if (value.length > 4_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${input.label} is not a valid run-time value.`);
  }
  if (input.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error(`Enter a valid ${input.label.toLocaleLowerCase()}.`);
  }
  if (input.type === "number" && !Number.isFinite(Number(value))) {
    throw new Error(`Enter a valid number for ${input.label.toLocaleLowerCase()}.`);
  }
  return value;
}

export function browserReplayToolInputs(
  skill: Pick<BotSkill, "name">,
  recipe: TaughtBrowserRecipe,
  step: TaughtBrowserRecipeStep,
  values: Readonly<Record<string, string>>,
): Record<string, Record<string, unknown>> {
  if (step.risk !== "none" || !["click", "fill"].includes(step.type) || !step.target?.expression) {
    throw new Error("This browser step requires manual takeover.");
  }
  const url = safeUrl(step.url);
  const host = url ? new URL(url).hostname.toLowerCase() : "";
  if (!url || !recipe.approvedDomains.includes(host)) {
    throw new Error("This browser step left the skill's approved website boundary.");
  }
  const action: Record<string, unknown> = {
    url,
    objective: `Run ${skill.name}: ${step.target.label}`,
    allowedDomains: [...recipe.approvedDomains],
    action: step.type === "fill" ? "type" : "click",
    target: step.target.expression,
  };
  if (step.type === "fill") {
    const input = recipe.inputs.find((candidate) => candidate.id === step.inputId);
    if (!input) throw new Error("This browser step is missing its declared run-time input.");
    action.value = runtimeInputValue(input, values);
  }
  return { "Browser act": action };
}
