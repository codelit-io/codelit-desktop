import type { BotDataColumn, BotDataColumnType, LocalBotTable } from "./contracts";

const COLUMN_TYPES = new Set<BotDataColumnType>(["text", "number", "boolean", "date", "url"]);
const DATA_EXAMPLE = "Create a table called Leads with columns Name, Company, Status";

export type BotDataIntent =
  | { kind: "create-table"; name: string; columns: BotDataColumn[] }
  | { kind: "add-row"; tableName: string; values: Record<string, string | number | boolean | null> }
  | { kind: "show-table"; tableName: string }
  | { kind: "list-tables" }
  | { kind: "export-table"; tableName: string }
  | { kind: "data-error"; message: string };

function cleanName(value: string, max: number) {
  const name = value
    .replace(/^[\s'"`]+|[\s'"`.]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return name && name.length <= max && !/[\r\n\t]/.test(name) ? name : "";
}

function splitFields(value: string) {
  const fields: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote) {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ",") {
      fields.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (quote) return null;
  fields.push(current.trim());
  return fields.filter(Boolean);
}

function parseColumn(value: string): BotDataColumn | null {
  const typed = value.match(/^(.+?)(?:\s*:\s*|\s+)(text|number|boolean|date|url)$/i);
  const name = cleanName(typed?.[1] || value, 48);
  if (!name) return null;
  const type = (typed?.[2]?.toLowerCase() || "text") as BotDataColumnType;
  return COLUMN_TYPES.has(type) ? { name, type } : null;
}

function unquoteValue(value: string) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" ? parsed : trimmed.slice(1, -1);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  }
  if (/^null$/i.test(trimmed)) return null;
  if (/^(?:true|yes)$/i.test(trimmed)) return true;
  if (/^(?:false|no)$/i.test(trimmed)) return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseRowValues(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const values: Record<string, string | number | boolean | null> = {};
      for (const [key, cell] of Object.entries(parsed)) {
        if (!["string", "number", "boolean"].includes(typeof cell) && cell !== null) return null;
        values[key] = cell as string | number | boolean | null;
      }
      return values;
    } catch {
      return null;
    }
  }
  const fields = splitFields(trimmed);
  if (!fields?.length) return null;
  const values: Record<string, string | number | boolean | null> = {};
  for (const field of fields) {
    const separator = field.indexOf("=");
    if (separator <= 0) return null;
    const key = cleanName(field.slice(0, separator), 48);
    if (!key || Object.keys(values).some((candidate) => candidate.toLowerCase() === key.toLowerCase())) {
      return null;
    }
    values[key] = unquoteValue(field.slice(separator + 1));
  }
  return values;
}

export function parseBotDataIntent(value: string): BotDataIntent | null {
  const text = value.trim();
  if (!text) return null;
  if (/^(?:show|list)\s+(?:my\s+|the\s+)?(?:local\s+)?tables\??$/i.test(text)) {
    return { kind: "list-tables" };
  }
  const create = text.match(
    /^(?:please\s+)?(?:create|make)\s+(?:a\s+)?(?:local\s+)?table\s+(?:(?:called|named)\s+)?(.+?)\s+with\s+columns?\s+(.+?)\.?$/i,
  );
  if (create) {
    const name = cleanName(create[1], 64);
    const fields = splitFields(create[2]);
    const parsedColumns = fields?.map(parseColumn) || [];
    if (!name || parsedColumns.length < 1 || parsedColumns.length > 16
      || parsedColumns.some((column) => !column)) {
      return { kind: "data-error", message: `Use a table name and 1-16 unique columns. For example: ${DATA_EXAMPLE}.` };
    }
    const columns = parsedColumns as BotDataColumn[];
    const unique = new Set(columns.map((column) => column.name.toLowerCase()));
    if (unique.size !== columns.length) {
      return { kind: "data-error", message: `Use a table name and 1-16 unique columns. For example: ${DATA_EXAMPLE}.` };
    }
    return { kind: "create-table", name, columns };
  }
  const add = text.match(
    /^(?:please\s+)?(?:add|append|save)\s+(?:a\s+)?(?:new\s+)?(?:row\s+)?(?:to|in)\s+(?:the\s+)?(?:table\s+)?(.+?)\s*:\s*(.+)$/i,
  );
  if (add) {
    const tableName = cleanName(add[1], 64);
    const values = parseRowValues(add[2]);
    if (!tableName || !values || !Object.keys(values).length) {
      return {
        kind: "data-error",
        message: 'Use column=value pairs. For example: Add to Leads: Name="Ada", Company="Codelit", Status="New".',
      };
    }
    return { kind: "add-row", tableName, values };
  }
  const show = text.match(/^(?:please\s+)?(?:show|open|view)\s+(?:me\s+)?(?:the\s+)?(?:local\s+)?table\s+(.+?)\.?$/i);
  if (show) {
    const tableName = cleanName(show[1], 64);
    return tableName ? { kind: "show-table", tableName } : { kind: "data-error", message: DATA_EXAMPLE };
  }
  const exportMatch = text.match(/^(?:please\s+)?export\s+(?:the\s+)?(?:local\s+)?table\s+(.+?)(?:\s+as\s+csv)?\.?$/i);
  if (exportMatch) {
    const tableName = cleanName(exportMatch[1], 64);
    return tableName ? { kind: "export-table", tableName } : { kind: "data-error", message: DATA_EXAMPLE };
  }
  if (/^(?:please\s+)?(?:create|make)\s+(?:a\s+)?(?:local\s+)?table\b/i.test(text)) {
    return { kind: "data-error", message: `Tell me the columns too. For example: ${DATA_EXAMPLE}.` };
  }
  if (/^(?:please\s+)?(?:add|append|save)\s+(?:a\s+)?(?:new\s+)?row\b/i.test(text)) {
    return { kind: "data-error", message: 'Name the table and use column=value pairs, such as: Add to Leads: Name="Ada", Status="New".' };
  }
  return null;
}

export function findBotTable(tables: LocalBotTable[], query: string) {
  const normalized = query.trim().toLowerCase();
  const exact = tables.find((table) => table.name.toLowerCase() === normalized);
  if (exact) return { table: exact, ambiguous: false };
  const matches = tables.filter((table) => table.name.toLowerCase().includes(normalized));
  return { table: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1 };
}

export function coerceBotTableValues(
  table: LocalBotTable,
  values: Record<string, string | number | boolean | null>,
) {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [requestedName, rawValue] of Object.entries(values)) {
    const column = table.columns.find((candidate) => candidate.name.toLowerCase() === requestedName.toLowerCase());
    if (!column) throw new Error(`**${requestedName}** is not a column in **${table.name}**.`);
    if (rawValue === null) {
      result[column.name] = null;
      continue;
    }
    if (column.type === "number") {
      const number = typeof rawValue === "number" ? rawValue : Number(rawValue);
      if (!Number.isFinite(number)) throw new Error(`**${column.name}** needs a number.`);
      result[column.name] = number;
      continue;
    }
    if (column.type === "boolean") {
      if (typeof rawValue === "boolean") result[column.name] = rawValue;
      else if (/^(?:true|yes)$/i.test(String(rawValue))) result[column.name] = true;
      else if (/^(?:false|no)$/i.test(String(rawValue))) result[column.name] = false;
      else throw new Error(`**${column.name}** needs true or false.`);
      continue;
    }
    result[column.name] = String(rawValue);
  }
  return result;
}
