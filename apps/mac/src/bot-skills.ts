import type {
  BotSkill,
  BotSkillCheck,
  BotSkillEffect,
  BotSkillField,
} from "./contracts";
import { parseBotBrowserTarget } from "./bot-policy";

type BotSkillInputValue = string | number | boolean;

export interface BotSkillCheckResult {
  id: string;
  label: string;
  phase: BotSkillCheck["phase"];
  passed: boolean;
}

export interface BotSkillRunReceipt {
  skillId: string;
  skillVersion: number;
  checksum: string;
  source: BotSkill["source"];
  trustState: BotSkill["trustState"];
  inputs: Array<{
    id: string;
    type: BotSkillField["type"];
    present: boolean;
    valueLength?: number;
    host?: string;
  }>;
  effects: BotSkillEffect[];
  checks: BotSkillCheckResult[];
}

export type BotSkillRunPreparation =
  | {
      status: "ready";
      promptContext: string[];
      receipts: BotSkillRunReceipt[];
    }
  | { status: "invalid"; message: string };

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function explicitInput(request: string, field: BotSkillField) {
  const names = [field.id, field.label]
    .map((value) => escapePattern(value.trim()))
    .filter(Boolean)
    .join("|");
  const match = request.match(new RegExp(
    `(?:^|[\\s,;])(?:${names})\\s*(?:=|:)\\s*(?:"([^"]{1,1000})"|'([^']{1,1000})'|([^,;\\n]{1,1000}))`,
    "i",
  ));
  return (match?.[1] || match?.[2] || match?.[3] || "")
    .replace(/\s+(?:and\s+)?[a-z][a-z0-9 _-]{0,40}\s*(?:=|:)\s*$/i, "")
    .trim();
}

function naturalTextInput(skill: BotSkill, field: BotSkillField, request: string) {
  const explicit = explicitInput(request, field);
  if (explicit) return explicit;
  if (field.id === "focus") {
    const focused = request.match(/\bfocus(?:ed)?\s+(?:on|upon)\s+(.+)$/i)?.[1]?.trim();
    if (focused) return focused;
  }
  const requiredTextFields = skill.inputSchema.filter((candidate) => (
    candidate.required && candidate.type === "text"
  ));
  if (requiredTextFields.length === 1 && requiredTextFields[0].id === field.id) {
    const tail = request.match(new RegExp(
      `${escapePattern(skill.name)}(?:\\s+skill)?\\s+(?:for|about|with)\\s+(.+)$`,
      "i",
    ))?.[1]?.trim();
    if (tail) return tail;
  }
  return "";
}

function fieldValue(skill: BotSkill, field: BotSkillField, request: string): BotSkillInputValue | undefined {
  if (field.type === "url") {
    const explicit = explicitInput(request, field);
    const target = parseBotBrowserTarget(explicit || request);
    return target.kind === "target" ? target.url : explicit || undefined;
  }
  const raw = field.type === "text"
    ? naturalTextInput(skill, field, request)
    : explicitInput(request, field);
  if (!raw) return undefined;
  if (field.type === "number") {
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }
  if (field.type === "boolean") {
    if (/^(?:true|yes|on|1)$/i.test(raw)) return true;
    if (/^(?:false|no|off|0)$/i.test(raw)) return false;
    return undefined;
  }
  if (field.type === "date") {
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) && Number.isFinite(Date.parse(`${raw}T00:00:00Z`))
      ? raw
      : undefined;
  }
  if (field.type === "choice") {
    return field.options?.find((option) => option.localeCompare(raw, undefined, { sensitivity: "accent" }) === 0);
  }
  return raw.slice(0, 1_000);
}

function publicHttpsInput(value: BotSkillInputValue | undefined) {
  if (typeof value !== "string") return false;
  const target = parseBotBrowserTarget(value);
  if (target.kind !== "target") return false;
  try {
    const url = new URL(target.url);
    return url.protocol === "https:"
      && url.hostname !== "localhost"
      && url.hostname !== "127.0.0.1"
      && url.hostname !== "::1";
  } catch {
    return false;
  }
}

function beforeCheck(
  check: BotSkillCheck,
  inputs: Map<string, BotSkillInputValue>,
  projectApproved: boolean,
): BotSkillCheckResult {
  const passed = check.rule === "required"
    ? inputs.has(check.inputId || "")
    : check.rule === "public-https"
      ? publicHttpsInput(inputs.get(check.inputId || ""))
      : check.rule === "project-approved"
        ? projectApproved
        : false;
  return { id: check.id, label: check.label, phase: check.phase, passed };
}

function inputHint(skill: BotSkill, missing: BotSkillField[]) {
  if (skill.examples[0]?.request) return ` Try: ${skill.examples[0].request}`;
  return ` Add ${missing.map((field) => field.label).join(" and ")} to the request.`;
}

export function prepareBotSkillRuns(
  skills: BotSkill[],
  request: string,
  options: { projectApproved: boolean },
): BotSkillRunPreparation {
  const promptContext: string[] = [];
  const receipts: BotSkillRunReceipt[] = [];
  for (const skill of skills) {
    if (skill.trustState === "unreviewed") {
      return { status: "invalid", message: `${skill.name} must be reviewed before it can run.` };
    }
    const inputs = new Map<string, BotSkillInputValue>();
    for (const field of skill.inputSchema) {
      const value = fieldValue(skill, field, request);
      if (value !== undefined && value !== "") inputs.set(field.id, value);
    }
    const missing = skill.inputSchema.filter((field) => field.required && !inputs.has(field.id));
    if (missing.length) {
      return {
        status: "invalid",
        message: `${skill.name} needs ${missing.map((field) => field.label).join(" and ")}.${inputHint(skill, missing)}`,
      };
    }
    const checks = skill.checks
      .filter((check) => check.phase === "before")
      .map((check) => beforeCheck(check, inputs, options.projectApproved));
    const failed = checks.find((check) => !check.passed);
    if (failed) {
      return { status: "invalid", message: `${skill.name} cannot start: ${failed.label}.` };
    }
    const inputValues = skill.inputSchema.flatMap((field) => {
      const value = inputs.get(field.id);
      return value === undefined ? [] : [`${field.label}: ${String(value)}`];
    });
    promptContext.push([
      `Skill contract for "${skill.name}" v${skill.version}.`,
      ...(inputValues.length ? [`Validated inputs: ${inputValues.join("; ")}`] : []),
      `Declared effects: ${skill.effects.length
        ? skill.effects.map((effect) => `${effect.kind} (${effect.risk})`).join(", ")
        : "none"}.`,
      "Do not perform an effect that is not declared here or that lacks the bot's current permission.",
    ].join(" "));
    receipts.push({
      skillId: skill.id,
      skillVersion: skill.version,
      checksum: skill.checksum,
      source: skill.source,
      trustState: skill.trustState,
      inputs: skill.inputSchema.map((field) => {
        const value = inputs.get(field.id);
        const target = field.type === "url" && typeof value === "string"
          ? parseBotBrowserTarget(value)
          : null;
        return {
          id: field.id,
          type: field.type,
          present: value !== undefined,
          ...(typeof value === "string" ? { valueLength: value.length } : {}),
          ...(target?.kind === "target" ? { host: target.host } : {}),
        };
      }),
      effects: skill.effects,
      checks,
    });
  }
  return { status: "ready", promptContext, receipts };
}

export function completeBotSkillChecks(
  skills: BotSkill[],
  receipts: BotSkillRunReceipt[],
  output: string,
) {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  return receipts.map((receipt) => {
    const skill = byId.get(receipt.skillId);
    const after = (skill?.checks || [])
      .filter((check) => check.phase === "after")
      .map((check): BotSkillCheckResult => ({
        id: check.id,
        label: check.label,
        phase: check.phase,
        passed: check.rule === "output-present" && output.trim().length > 0,
      }));
    return { ...receipt, checks: [...receipt.checks, ...after] };
  });
}

export function botSkillChecksPassed(receipts: BotSkillRunReceipt[]) {
  return receipts.every((receipt) => receipt.checks.every((check) => check.passed));
}
