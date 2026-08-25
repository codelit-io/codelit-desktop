import type { BotDataColumnType } from "./contracts";

export const AGENTIC_NATIVE_ACTIONS = [
  "set_goal",
  "create_routine",
  "watch_project",
  "create_table",
  "add_table_row",
  "delegate",
] as const;

export type AgenticNativeAction = typeof AGENTIC_NATIVE_ACTIONS[number];

export interface AgenticNativeActionDefinition {
  name: AgenticNativeAction;
  description: string;
  argumentShape: string;
  inputSchema: Record<string, unknown>;
}

export interface AgenticNativeActionProposal {
  action: AgenticNativeAction;
  arguments: Record<string, unknown>;
}

export interface AgenticNativeCapabilities {
  hasProject: boolean;
  schedulesAvailable: boolean;
  teammateNames: string[];
}

const COLUMN_TYPES = ["text", "number", "boolean", "date", "url"] as const;
const CADENCES = ["daily", "weekdays", "weekly"] as const;
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function objectSchema(properties: Record<string, unknown>, required: string[]) {
  return { type: "object", additionalProperties: false, properties, required };
}

export function buildAgenticNativeActions(
  capabilities: AgenticNativeCapabilities,
): AgenticNativeActionDefinition[] {
  const actions: AgenticNativeActionDefinition[] = [
    {
      name: "set_goal",
      description: "Change this bot's local goal when the user explicitly asks for a new ongoing outcome.",
      argumentShape: '{"outcome":"string"}',
      inputSchema: objectSchema({
        outcome: { type: "string", minLength: 3, maxLength: 500 },
      }, ["outcome"]),
    },
    {
      name: "create_table",
      description: "Create one private local table for this bot. This changes only data stored on this Mac.",
      argumentShape: '{"name":"string","columns":[{"name":"string","type":"text|number|boolean|date|url"}]}',
      inputSchema: objectSchema({
        name: { type: "string", minLength: 1, maxLength: 80 },
        columns: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: objectSchema({
            name: { type: "string", minLength: 1, maxLength: 80 },
            type: { type: "string", enum: COLUMN_TYPES },
          }, ["name", "type"]),
        },
      }, ["name", "columns"]),
    },
    {
      name: "add_table_row",
      description: "Add one row to an existing private local table using the table's exact visible name.",
      argumentShape: '{"tableName":"exact visible name","values":{"column":"text|number|boolean|null"}}',
      inputSchema: objectSchema({
        tableName: { type: "string", minLength: 1, maxLength: 80 },
        values: { type: "object", additionalProperties: true, maxProperties: 40 },
      }, ["tableName", "values"]),
    },
  ];

  if (capabilities.schedulesAvailable) {
    actions.push({
      name: "create_routine",
      description: "Prepare a disabled local clock routine for review. For weekly work, use one weekday number where 0 is Sunday and 6 is Saturday.",
      argumentShape: '{"prompt":"string","cadence":"daily|weekdays|weekly","localTime":"HH:MM","weekdays":[1]}',
      inputSchema: objectSchema({
        prompt: { type: "string", minLength: 3, maxLength: 1_200 },
        cadence: { type: "string", enum: CADENCES },
        localTime: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
        weekdays: {
          type: "array",
          minItems: 0,
          maxItems: 7,
          items: { type: "integer", minimum: 0, maximum: 6 },
        },
      }, ["prompt", "cadence", "localTime"]),
    });
  }

  if (capabilities.schedulesAvailable && capabilities.hasProject) {
    actions.push({
      name: "watch_project",
      description: "Prepare a disabled local project-change watch for review using the already approved project folder.",
      argumentShape: '{"prompt":"string"}',
      inputSchema: objectSchema({
        prompt: { type: "string", minLength: 3, maxLength: 1_200 },
      }, ["prompt"]),
    });
  }

  const teammateNames = [...new Set(capabilities.teammateNames.map((name) => name.trim()).filter(Boolean))]
    .slice(0, 20);
  if (teammateNames.length) {
    actions.push({
      name: "delegate",
      description: `Delegate one bounded task to one or two teammates already in this conversation: ${teammateNames.join(", ")}.`,
      argumentShape: '{"targetBotNames":["exact teammate name"],"task":"string","expectedOutput":"string"}',
      inputSchema: objectSchema({
        targetBotNames: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          uniqueItems: true,
          items: { type: "string", enum: teammateNames },
        },
        task: { type: "string", minLength: 3, maxLength: 1_200 },
        expectedOutput: { type: "string", minLength: 3, maxLength: 500 },
      }, ["targetBotNames", "task"]),
    });
  }

  return actions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key) && !BLOCKED_KEYS.has(key));
}

function boundedText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string"
    && value.trim().length >= min
    && value.trim().length <= max
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function validColumnType(value: unknown): value is BotDataColumnType {
  return typeof value === "string" && COLUMN_TYPES.some((type) => type === value);
}

function validRowValue(value: unknown) {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

export function validateAgenticNativeArguments(
  action: AgenticNativeAction,
  value: unknown,
  definition?: AgenticNativeActionDefinition,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (action === "set_goal") {
    return hasExactKeys(value, ["outcome"])
      && boundedText(value.outcome, 3, 500)
      ? { outcome: value.outcome.trim() }
      : null;
  }
  if (action === "create_table") {
    if (!hasExactKeys(value, ["name", "columns"])
      || !boundedText(value.name, 1, 80)
      || !Array.isArray(value.columns)
      || value.columns.length < 1
      || value.columns.length > 20) return null;
    const columns = value.columns.flatMap((column) => (
      isRecord(column)
      && hasExactKeys(column, ["name", "type"])
      && boundedText(column.name, 1, 80)
      && validColumnType(column.type)
        ? [{ name: column.name.trim(), type: column.type }]
        : []
    ));
    if (columns.length !== value.columns.length
      || new Set(columns.map((column) => column.name.toLowerCase())).size !== columns.length) return null;
    return { name: value.name.trim(), columns };
  }
  if (action === "add_table_row") {
    if (!hasExactKeys(value, ["tableName", "values"])
      || !boundedText(value.tableName, 1, 80)
      || !isRecord(value.values)) return null;
    const entries = Object.entries(value.values);
    if (!entries.length || entries.length > 40 || entries.some(([key, item]) => (
      !boundedText(key, 1, 80) || BLOCKED_KEYS.has(key) || !validRowValue(item)
    ))) return null;
    return { tableName: value.tableName.trim(), values: Object.fromEntries(entries) };
  }
  if (action === "create_routine") {
    if (!hasExactKeys(value, ["prompt", "cadence", "localTime"], ["weekdays"])
      || !boundedText(value.prompt, 3, 1_200)
      || typeof value.cadence !== "string"
      || !CADENCES.some((cadence) => cadence === value.cadence)
      || typeof value.localTime !== "string"
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.localTime)
      || (value.weekdays !== undefined && (!Array.isArray(value.weekdays)
        || value.weekdays.length > 7
        || value.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)))) return null;
    const weekdays = value.cadence === "weekdays"
      ? [1, 2, 3, 4, 5]
      : value.cadence === "daily"
        ? []
        : [...new Set((value.weekdays as number[] | undefined) || [])];
    if (value.cadence === "weekly" && weekdays.length !== 1) return null;
    return {
      prompt: value.prompt.trim(),
      cadence: value.cadence,
      localTime: value.localTime,
      weekdays,
    };
  }
  if (action === "watch_project") {
    return hasExactKeys(value, ["prompt"])
      && boundedText(value.prompt, 3, 1_200)
      ? { prompt: value.prompt.trim() }
      : null;
  }
  if (action === "delegate") {
    if (!hasExactKeys(value, ["targetBotNames", "task"], ["expectedOutput"])
      || !Array.isArray(value.targetBotNames)
      || value.targetBotNames.length < 1
      || value.targetBotNames.length > 2
      || value.targetBotNames.some((name) => !boundedText(name, 1, 80))
      || new Set(value.targetBotNames.map((name) => String(name).toLowerCase())).size !== value.targetBotNames.length
      || !boundedText(value.task, 3, 1_200)
      || (value.expectedOutput !== undefined && !boundedText(value.expectedOutput, 3, 500))) return null;
    const allowed = definition?.inputSchema
      && isRecord(definition.inputSchema.properties)
      && isRecord(definition.inputSchema.properties.targetBotNames)
      && isRecord(definition.inputSchema.properties.targetBotNames.items)
      && Array.isArray(definition.inputSchema.properties.targetBotNames.items.enum)
      ? new Set(definition.inputSchema.properties.targetBotNames.items.enum.filter((name): name is string => typeof name === "string"))
      : null;
    if (!allowed || value.targetBotNames.some((name) => !allowed.has(String(name)))) return null;
    return {
      targetBotNames: value.targetBotNames.map((name) => String(name)),
      task: value.task.trim(),
      expectedOutput: typeof value.expectedOutput === "string"
        ? value.expectedOutput.trim()
        : "One concise evidence-backed result.",
    };
  }
  return null;
}

export function nativeRoutineTriggerLabel(input: {
  cadence: "daily" | "weekdays" | "weekly";
  localTime: string;
  weekdays: number[];
}) {
  const [hourValue, minuteValue] = input.localTime.split(":").map(Number);
  const period = hourValue >= 12 ? "PM" : "AM";
  const hour = hourValue % 12 || 12;
  const time = `${hour}:${String(minuteValue).padStart(2, "0")} ${period}`;
  if (input.cadence === "daily") return `Every day at ${time}`;
  if (input.cadence === "weekdays") return `Every weekday at ${time}`;
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return `Every ${names[input.weekdays[0]] || "week"} at ${time}`;
}
