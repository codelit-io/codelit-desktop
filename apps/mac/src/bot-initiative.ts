import type {
  BotGoal,
  BotMemory,
  BotRoutineSnapshot,
  BotSkill,
  LocalBotRecord,
  LocalSchedule,
  LocalScheduleCadence,
} from "./contracts";

const DAY_NUMBERS: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

const TIME_PATTERN = "(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?";
const SCHEDULE_PATTERNS: Array<{
  cadence: LocalScheduleCadence;
  weekdays: number[];
  pattern: RegExp;
  label: (time: string, match: RegExpMatchArray) => string;
}> = [
  {
    cadence: "weekdays",
    weekdays: [1, 2, 3, 4, 5],
    pattern: new RegExp(`\\bevery\\s+weekdays?\\s+${TIME_PATTERN}\\b`, "i"),
    label: (time) => `Every weekday at ${displayTime(time)}`,
  },
  {
    cadence: "daily",
    weekdays: [],
    pattern: new RegExp(`\\b(?:every\\s+day|daily)\\s+${TIME_PATTERN}\\b`, "i"),
    label: (time) => `Every day at ${displayTime(time)}`,
  },
  {
    cadence: "weekly",
    weekdays: [],
    pattern: new RegExp(`\\bevery\\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\\s+${TIME_PATTERN}\\b`, "i"),
    label: (time, match) => `Every ${titleCase(match[1])} at ${displayTime(time)}`,
  },
];

export type BotControlIntent =
  | { kind: "set-goal"; outcome: string }
  | { kind: "complete-goal" }
  | { kind: "teach-skill"; name: string; instructions: string; replace: boolean }
  | { kind: "import-skill" }
  | { kind: "show-skills" }
  | { kind: "forget-skill"; query: string }
  | { kind: "remember"; body: string; scope: BotMemory["scope"]; retentionDays?: 7 | 30 | 90 }
  | { kind: "show-memory" }
  | { kind: "review-memory-proposals" }
  | { kind: "forget-memory"; query: string | null; all: boolean }
  | { kind: "show-routines" }
  | { kind: "pause-routines" }
  | { kind: "undo-change" }
  | {
      kind: "update-routine-schedule";
      query: string | null;
      cadence: LocalScheduleCadence;
      localTime: string;
      weekdays: number[];
      triggerLabel: string;
    }
  | { kind: "watch-project"; prompt: string; triggerLabel: string }
  | {
      kind: "schedule";
      cadence: LocalScheduleCadence;
      localTime: string;
      weekdays: number[];
      prompt: string;
      triggerLabel: string;
    };

export type BotDelegationIntent =
  | {
      kind: "delegate";
      targetBotIds: string[];
      task: string;
      expectedOutput: string;
      maxActions: number;
      deadlineMinutes: number;
    }
  | { kind: "delegation-error"; message: string };

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function normalizeTime(hourText: string, minuteText?: string, meridiem?: string) {
  let hour = Number(hourText);
  const minute = Number(minuteText || "0");
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem.toLowerCase() === "pm" && hour !== 12) hour += 12;
    if (meridiem.toLowerCase() === "am" && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function displayTime(value: string) {
  const [hourText, minuteText] = value.split(":");
  const hour = Number(hourText);
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12}:${minuteText} ${suffix}`;
}

function schedulePatternMatch(text: string) {
  for (const definition of SCHEDULE_PATTERNS) {
    const match = text.match(definition.pattern);
    if (!match) continue;
    const timeOffset = definition.cadence === "weekly" ? 2 : 1;
    const localTime = normalizeTime(match[timeOffset], match[timeOffset + 1], match[timeOffset + 2]);
    if (!localTime) return null;
    return {
      cadence: definition.cadence,
      localTime,
      weekdays: definition.cadence === "weekly"
        ? [DAY_NUMBERS[match[1].toLowerCase()]]
        : definition.weekdays,
      triggerLabel: definition.label(localTime, match),
      match,
    };
  }
  return null;
}

function routineQuery(value: string) {
  const query = value
    .replace(/^(?:called|named)\s+/i, "")
    .replace(/^[\s'"“”‘’]+|[\s'"“”‘’.]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return !query || /^(?:this|that|it)$/i.test(query) ? null : query;
}

function cleanRoutinePrompt(value: string) {
  return value
    .replace(/\b(?:please\s+)?(?:schedule|repeat)\s+(?:this\s+)?/i, "")
    .replace(/\bdo\s+this\b/i, "")
    .replace(/^[,.:;\s]+|[,.:;\s]+$/g, "")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const SENSITIVE_MEMORY_MARKERS = [
  "password",
  "passcode",
  "api key",
  "access token",
  "refresh token",
  "private key",
  "secret key",
  "seed phrase",
  "recovery phrase",
  "one-time code",
  "one time code",
  "verification code",
  "security code",
  "credit card",
  "card number",
  "social security",
  "-----begin",
];

export function botMemorySafetyError(value: string) {
  const normalized = value.toLowerCase().replace(/[_-]+/g, " ");
  return SENSITIVE_MEMORY_MARKERS.some((marker) => normalized.includes(marker))
    ? "I will not save passwords, tokens, payment details, recovery phrases, or one-time codes as memory."
    : null;
}

export function classifyBotMemory(value: string): BotMemory["kind"] {
  const normalized = value.trim().toLowerCase();
  if (/^(?:i|we)\s+(?:prefer|like|want)|\bpreference\b|\balways\s+(?:use|show|write|ask|include|keep|format)\b/.test(normalized)) {
    return "preference";
  }
  if (/^(?:we\s+)?(?:decided|chose|agreed)|\bdecision\b/.test(normalized)) return "decision";
  if (/^(?:when|whenever|before|after)\b|\b(?:process|procedure|workflow|steps?)\b/.test(normalized)) {
    return "procedure";
  }
  return "fact";
}

export interface InferredBotMemoryProposal {
  body: string;
  kind: BotMemory["kind"];
  confidence: number;
}

export function inferBotMemoryProposal(value: string): InferredBotMemoryProposal | null {
  const candidates = value
    .replace(/\r/g, "\n")
    .split(/\n+|(?<=[.!?])\s+/)
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const stableCue = /^(?:i\s+prefer\b|my\s+preference\s+is\b|we\s+(?:decided|agreed|chose)\b|always\s+(?:use|write|show|ask|include|keep|format)\b|for\s+this\s+(?:project|workspace|repository|repo),?\s+(?:use|keep|write|show|include)\b)/i;
  const body = candidates.find((candidate) => stableCue.test(candidate))
    ?.replace(/[.!?]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!body || body.length < 8 || body.length > 280 || /[a-z][a-z\d+.-]*:\/\//i.test(body)) {
    return null;
  }
  if (botMemorySafetyError(body)) return null;
  return {
    body,
    kind: classifyBotMemory(body),
    confidence: 0.86,
  };
}

function memoryBody(value: string) {
  return value
    .replace(/^[\s:,-]+|[\s]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function skillName(value: string) {
  const name = value
    .replace(/^[\s'"“”‘’]+|[\s'"“”‘’.]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return name.length >= 2 && name.length <= 64 && !/[\n\r\t]/.test(name) ? name : "";
}

function skillInstructions(value: string) {
  return value
    .replace(/^[\s:,-]+|[\s]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function describeBotSkill(instructions: string) {
  const clean = instructions.replace(/\s+/g, " ").trim();
  if (clean.length <= 140) return clean;
  return `${clean.slice(0, 137).trimEnd()}...`;
}

export function parseBotControlIntent(value: string, priorRequest?: string): BotControlIntent | null {
  const text = value.trim();
  if (!text) return null;
  if (/^(?:please\s+)?(?:undo|revert)(?:\s+(?:that|the|my|last|latest)\s+(?:bot\s+|routine\s+)?change)?[.!]?$/i.test(text)) {
    return { kind: "undo-change" };
  }
  if (/^(?:import|add)\s+(?:a\s+)?skill(?:\s+package)?[.!]?$/i.test(text)) {
    return { kind: "import-skill" };
  }
  if (/^(?:show|list)\s+(?:me\s+)?(?:my\s+|your\s+|the\s+)?skills\??$/i.test(text)
    || /^what\s+skills\s+do\s+you\s+(?:know|have)\??$/i.test(text)) {
    return { kind: "show-skills" };
  }
  const forgetSkill = text.match(/^(?:forget|delete|remove)\s+(?:the\s+)?skill\s+(?:called\s+|named\s+)?(.+?)\.?$/i);
  if (forgetSkill?.[1]) {
    const query = skillName(forgetSkill[1]);
    return query ? { kind: "forget-skill", query } : null;
  }
  const updateSkill = text.match(/^update\s+(?:the\s+)?skill\s+["“]?([^:"”]+?)["”]?\s*:\s*(.+)$/i);
  if (updateSkill?.[1] && updateSkill[2]) {
    const name = skillName(updateSkill[1]);
    const instructions = skillInstructions(updateSkill[2]);
    return name && instructions ? { kind: "teach-skill", name, instructions, replace: true } : null;
  }
  const teachPrior = text.match(/^(?:teach|save)\s+(?:this|that|it)\s+as\s+(?:a\s+)?skill\s+(?:called|named)\s+(.+?)\.?$/i);
  if (teachPrior?.[1]) {
    const name = skillName(teachPrior[1]);
    const instructions = skillInstructions(priorRequest || "");
    return name && instructions ? { kind: "teach-skill", name, instructions, replace: false } : null;
  }
  const teachSkill = text.match(/^(?:teach|create|save)\s+(?:me\s+)?(?:a\s+)?skill\s+(?:called|named)\s+["“]?([^:"”]+?)["”]?\s*(?::|\bthat\b)\s*(.+)$/i);
  if (teachSkill?.[1] && teachSkill[2]) {
    const name = skillName(teachSkill[1]);
    const instructions = skillInstructions(teachSkill[2]);
    return name && instructions ? { kind: "teach-skill", name, instructions, replace: false } : null;
  }
  if (/^(?:what\s+do\s+you\s+know(?:\s+about\s+(?:me|this\s+project))?|show\s+(?:me\s+)?(?:your|my|the)?\s*memor(?:y|ies)|list\s+(?:your|my|the)?\s*memor(?:y|ies))\??$/i.test(text)) {
    return { kind: "show-memory" };
  }
  if (/^(?:review|show|list)\s+(?:my\s+|your\s+|the\s+)?memory\s+(?:suggestions|proposals)\??$/i.test(text)) {
    return { kind: "review-memory-proposals" };
  }
  if (/^forget\s+(?:everything|everything\s+you\s+know|all\s+memor(?:y|ies))\.?$/i.test(text)) {
    return { kind: "forget-memory", query: null, all: true };
  }
  const forget = text.match(/^forget\s+(?:that\s+)?(.+?)\.?$/i);
  if (forget?.[1]) {
    const query = /^(?:this|that|it)$/i.test(forget[1].trim()) ? null : memoryBody(forget[1]);
    return { kind: "forget-memory", query, all: false };
  }
  const sharedMemory = text.match(/^remember\s+(?:(?:this\s+)?for|across)\s+(?:all|every)\s+bots?\s*(?:that|:)?\s*(.*)$/i);
  if (sharedMemory) {
    const body = memoryBody(sharedMemory[1] || priorRequest || "");
    return body ? { kind: "remember", body, scope: "workspace" } : null;
  }
  const expiringMemory = text.match(/^remember(?:\s+this)?\s+for\s+(7|30|90)\s+days?\s*(?:that|:)?\s*(.*)$/i);
  if (expiringMemory) {
    const body = memoryBody(expiringMemory[2] || priorRequest || "");
    const retentionDays = Number(expiringMemory[1]) as 7 | 30 | 90;
    return body ? { kind: "remember", body, scope: "bot", retentionDays } : null;
  }
  const privateMemory = text.match(/^remember(?:\s+this)?\s*(?:that|:)?\s*(.*)$/i);
  if (privateMemory) {
    const body = memoryBody(privateMemory[1] || priorRequest || "");
    return body ? { kind: "remember", body, scope: "bot" } : null;
  }
  const goal = text.match(/^(?:set|change|update|make)\s+(?:your\s+|the\s+)?goal\s+(?:to|as)\s+(.+)$/i)
    || text.match(/^goal\s*:\s*(.+)$/i);
  if (goal?.[1]?.trim()) return { kind: "set-goal", outcome: goal[1].trim() };
  if (/^(?:mark\s+)?(?:the\s+|your\s+)?goal\s+(?:as\s+)?(?:done|complete|completed)$/i.test(text)) {
    return { kind: "complete-goal" };
  }
  if (/^(?:show|list|what\s+are)\s+(?:me\s+)?(?:my\s+|your\s+|the\s+)?routines\??$/i.test(text)) {
    return { kind: "show-routines" };
  }
  if (/^(?:pause|stop)\s+(?:all\s+)?(?:my\s+|your\s+|the\s+)?routines$/i.test(text)) {
    return { kind: "pause-routines" };
  }

  const scheduleMatch = schedulePatternMatch(text);
  if (scheduleMatch?.match.index !== undefined) {
    const prefix = text.slice(0, scheduleMatch.match.index).trim();
    const update = prefix.match(
      /^(?:change|move|reschedule|update)\s+(?:(?:the|my)\s+)?routine(?:\s+(.+?))?\s+(?:to|for)$/i,
    ) || prefix.match(
      /^(?:change|move|reschedule|update)\s+(?:(?:the|my)\s+)?(.+?)\s+routine\s+(?:to|for)$/i,
    );
    if (update) {
      return {
        kind: "update-routine-schedule",
        query: routineQuery(update[1] || ""),
        cadence: scheduleMatch.cadence,
        localTime: scheduleMatch.localTime,
        weekdays: scheduleMatch.weekdays,
        triggerLabel: scheduleMatch.triggerLabel,
      };
    }
  }

  const projectChange = text.match(
    /^(?:when|whenever)\s+(?:this|the)\s+(?:project|folder|repository|repo)\s+changes?\s*[,.:;-]?\s*(.*)$/i,
  );
  const projectWatch = text.match(
    /^(?:watch|monitor)\s+(?:this|the)\s+(?:project|folder|repository|repo)\s+(?:and|to)\s+(.+)$/i,
  );
  if (projectChange || projectWatch) {
    const requestedPrompt = cleanRoutinePrompt(projectChange?.[1] || projectWatch?.[1] || "");
    const prompt = requestedPrompt || priorRequest?.trim()
      || "Summarize what changed and report only material differences.";
    return {
      kind: "watch-project",
      prompt,
      triggerLabel: "When this project changes",
    };
  }

  if (scheduleMatch) {
    const prompt = cleanRoutinePrompt(text.replace(scheduleMatch.match[0], ""));
    const resolvedPrompt = /^(?:it|this|that)?$/i.test(prompt) || !prompt ? priorRequest?.trim() || "" : prompt;
    if (!resolvedPrompt) return null;
    return {
      kind: "schedule",
      cadence: scheduleMatch.cadence,
      localTime: scheduleMatch.localTime,
      weekdays: scheduleMatch.weekdays,
      prompt: resolvedPrompt,
      triggerLabel: scheduleMatch.triggerLabel,
    };
  }
  return null;
}

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanDelegatedTask(value: string) {
  return value
    .replace(/^[\s,:;-]+|[\s]+$/g, "")
    .replace(/^(?:please\s+)?(?:ask|have)\s+/i, "")
    .replace(/^(?:please\s+)?delegate(?:\s+this|\s+the\s+task)?\s+to\s+/i, "")
    .replace(/^[\s,:;-]+|[\s]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function parseBotDelegationIntent(
  value: string,
  bots: LocalBotRecord[],
  activeBotId: string,
  groupMemberIds: string[] = [],
): BotDelegationIntent | null {
  const text = value.trim();
  if (!text) return null;
  if (bots.length < 2) {
    return /^(?:please\s+)?(?:ask|have|delegate\b)/i.test(text) || /@[A-Za-z0-9]/.test(text)
      ? { kind: "delegation-error", message: "Create another bot before asking a specialist." }
      : null;
  }
  const available = bots
    .filter((bot) => bot.id !== activeBotId)
    .sort((left, right) => right.name.length - left.name.length || left.name.localeCompare(right.name));
  const selected = new Map<string, LocalBotRecord>();
  let task = text;
  const teamRequest = text.match(/^(?:please\s+)?(?:ask|have)\s+(?:the\s+)?team\s+to\s+(.+)$/i)
    || text.match(/^@team(?:\s+|\s*:\s*)(.+)$/i);
  if (teamRequest) {
    for (const memberId of groupMemberIds) {
      const member = available.find((bot) => bot.id === memberId);
      if (member) selected.set(member.id, member);
    }
    if (!selected.size) {
      return {
        kind: "delegation-error",
        message: "Add one or two teammates to this conversation first.",
      };
    }
    task = teamRequest[1];
  }
  for (const bot of available) {
    const mention = new RegExp(`@${escapePattern(bot.name)}(?=$|[\\s,:;.!?])`, "gi");
    if (!mention.test(task)) continue;
    selected.set(bot.id, bot);
    task = task.replace(mention, " ");
  }

  if (!selected.size) {
    const ask = text.match(/^(?:please\s+)?(?:ask|have)\s+(.+?)\s+to\s+(.+)$/i);
    const delegate = text.match(
      /^(?:please\s+)?delegate(?:\s+this|\s+the\s+task)?\s+to\s+(.+?)\s*:\s*(.+)$/i,
    );
    const targetText = ask?.[1] || delegate?.[1];
    if (targetText) {
      const requestedNames = targetText
        .split(/\s*(?:,|\band\b)\s*/i)
        .map((name) => name.replace(/^@/, "").trim())
        .filter(Boolean);
      for (const name of requestedNames) {
        const match = available.find((bot) => bot.name.localeCompare(name, undefined, {
          sensitivity: "accent",
        }) === 0);
        if (!match) {
          return { kind: "delegation-error", message: `There is no other bot named ${name}.` };
        }
        selected.set(match.id, match);
      }
      task = ask?.[2] || delegate?.[2] || "";
    }
  }

  if (!selected.size) {
    if (/^(?:please\s+)?(?:ask|have|delegate\b)/i.test(text) || /@[A-Za-z0-9]/.test(text)) {
      return { kind: "delegation-error", message: "Mention an available bot by its exact name." };
    }
    return null;
  }
  if (selected.size > 2) {
    return { kind: "delegation-error", message: "Ask one or two specialist bots at a time." };
  }
  const selectedNames = Array.from(selected.values()).map((bot) => escapePattern(bot.name));
  task = cleanDelegatedTask(task)
    .replace(new RegExp(`^(?:${selectedNames.join("|")})(?:\\s+and\\s+(?:${selectedNames.join("|")}))?\\s+to\\s+`, "i"), "")
    .trim();
  if (!task) {
    return { kind: "delegation-error", message: "Tell the specialist what result you need." };
  }
  return {
    kind: "delegate",
    targetBotIds: Array.from(selected.keys()),
    task,
    expectedOutput: selected.size === 1
      ? "One concise evidence-backed result."
      : "One concise evidence-backed result per specialist, combined without duplication.",
    maxActions: 4,
    deadlineMinutes: 30,
  };
}

function normalizedSkillText(value: string) {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function skillsForBotRequest(skills: BotSkill[], request: string) {
  const task = ` ${normalizedSkillText(request)} `;
  return skills
    .filter((skill) => ["built-in", "taught", "user-authored", "imported"].includes(skill.source)
      && ["packaged", "reviewed"].includes(skill.trustState)
      && /^[a-f0-9]{64}$/.test(skill.checksum)
      && task.includes(` ${normalizedSkillText(skill.name)} `))
    .sort((left, right) => right.name.length - left.name.length || left.name.localeCompare(right.name))
    .slice(0, 3);
}

export function botSkillVersions(skills: BotSkill[]) {
  return Object.fromEntries(
    skills
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((skill) => [skill.id, skill.version]),
  );
}

export function botSkillSnapshotMatches(current: BotSkill[], selected: BotSkill[]) {
  const currentById = new Map(current.map((skill) => [skill.id, skill]));
  return selected.every((skill) => {
    const latest = currentById.get(skill.id);
    return latest?.version === skill.version && latest.checksum === skill.checksum;
  });
}

export function createBotGoal(job: string, createdAt: string, id = `goal-${crypto.randomUUID()}`): BotGoal {
  return {
    id,
    outcome: job.trim(),
    successCriteria: [
      "Produce one concrete result backed by inspectable evidence.",
      "Keep external changes and sensitive actions behind approval.",
    ],
    status: "active",
    nextAction: "Take the smallest useful read-only step with the context available now.",
    createdAt,
    updatedAt: createdAt,
  };
}

export function createRoutineSnapshot(
  bot: LocalBotRecord,
  routineId: string,
  prompt: string,
  triggerLabel: string,
  createdAt: string,
): BotRoutineSnapshot {
  return {
    schemaVersion: 1,
    kind: "bot-routine",
    routineId,
    botId: bot.id,
    botVersion: bot.currentVersion,
    goalId: bot.spec.goal.id,
    prompt,
    triggerLabel,
    permissionSnapshot: bot.spec.permissionPolicy,
    createdAt,
  };
}

export function readBotRoutineSnapshot(schedule: LocalSchedule): BotRoutineSnapshot | null {
  const value = schedule.snapshot;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Partial<BotRoutineSnapshot>;
  if (snapshot.schemaVersion !== 1
    || snapshot.kind !== "bot-routine"
    || typeof snapshot.routineId !== "string"
    || typeof snapshot.botId !== "string"
    || typeof snapshot.botVersion !== "number"
    || typeof snapshot.goalId !== "string"
    || typeof snapshot.prompt !== "string"
    || typeof snapshot.triggerLabel !== "string"
    || typeof snapshot.createdAt !== "string"
    || !snapshot.permissionSnapshot) return null;
  return snapshot as BotRoutineSnapshot;
}

export function routinesForBot(schedules: LocalSchedule[], botId: string) {
  return schedules.filter((schedule) => readBotRoutineSnapshot(schedule)?.botId === botId);
}

export async function botMemorySnapshotHash(memories: BotMemory[]) {
  if (!memories.length) return "none";
  const canonical = memories
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(({ id, botId, scope, kind, body, expiresAt, updatedAt }) => ({
      id,
      botId: botId || null,
      scope,
      kind,
      body,
      expiresAt: expiresAt || null,
      updatedAt,
    }));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function previousUserRequest(blocks: Array<{ type: string; text?: string }>) {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.type === "user-message" && block.text?.trim()) return block.text.trim();
  }
  return undefined;
}
