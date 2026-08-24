import { describe, expect, it } from "vitest";
import type { LocalBotTable } from "../../apps/mac/src/contracts";
import {
  coerceBotTableValues,
  findBotTable,
  parseBotDataIntent,
} from "../../apps/mac/src/bot-data";

const CREATED_AT = "2026-08-19T12:00:00.000Z";

function table(
  id: string,
  name: string,
  columns: LocalBotTable["columns"] = [{ name: "Name", type: "text" }],
): LocalBotTable {
  return {
    id,
    databaseId: "bot-database:bot-codelit",
    botId: "bot-codelit",
    name,
    version: 1,
    columns,
    rowCount: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

describe("Mac bot local data chat grammar", () => {
  it("creates compact typed schemas while keeping text as the default", () => {
    expect(parseBotDataIntent(
      "Create a table called Leads with columns Name, Amount:number, Active boolean, Due:date, Link:url",
    )).toEqual({
      kind: "create-table",
      name: "Leads",
      columns: [
        { name: "Name", type: "text" },
        { name: "Amount", type: "number" },
        { name: "Active", type: "boolean" },
        { name: "Due", type: "date" },
        { name: "Link", type: "url" },
      ],
    });
  });

  it("rejects malformed and duplicate schemas with a usable correction", () => {
    expect(parseBotDataIntent("Create a table called Leads")).toMatchObject({
      kind: "data-error",
      message: expect.stringContaining("Tell me the columns"),
    });
    expect(parseBotDataIntent("Create a table called Leads with columns Name, name")).toMatchObject({
      kind: "data-error",
      message: expect.stringContaining("unique columns"),
    });
    expect(parseBotDataIntent(
      `Create a table called Large with columns ${Array.from({ length: 17 }, (_, index) => `Field ${index + 1}`).join(", ")}`,
    )).toMatchObject({ kind: "data-error" });
  });

  it("parses quoted commas, booleans, numbers, null, and JSON rows", () => {
    expect(parseBotDataIntent(
      'Add to Leads: Name="Ada, Lovelace", Amount=42.5, Active=yes, Note=null',
    )).toEqual({
      kind: "add-row",
      tableName: "Leads",
      values: {
        Name: "Ada, Lovelace",
        Amount: 42.5,
        Active: true,
        Note: null,
      },
    });
    expect(parseBotDataIntent(
      'Add row to Leads: {"Name":"Grace","Amount":18,"Active":false}',
    )).toEqual({
      kind: "add-row",
      tableName: "Leads",
      values: { Name: "Grace", Amount: 18, Active: false },
    });
  });

  it("supports discovery, opening, and CSV export without matching normal chat", () => {
    expect(parseBotDataIntent("Show my local tables")).toEqual({ kind: "list-tables" });
    expect(parseBotDataIntent("Open table Leads")).toEqual({ kind: "show-table", tableName: "Leads" });
    expect(parseBotDataIntent("Export table Leads as CSV")).toEqual({ kind: "export-table", tableName: "Leads" });
    expect(parseBotDataIntent("Help me organize the leads from this page")).toBeNull();
    expect(parseBotDataIntent("Please show me how local databases work")).toBeNull();
  });

  it("resolves an exact or uniquely partial table name and identifies ambiguity", () => {
    const tables = [table("table-leads", "Leads"), table("table-qualified", "Qualified leads")];
    expect(findBotTable(tables, "Leads")).toEqual({ table: tables[0], ambiguous: false });
    expect(findBotTable(tables, "qualified")).toEqual({ table: tables[1], ambiguous: false });
    expect(findBotTable(tables, "lead")).toEqual({ table: null, ambiguous: true });
    expect(findBotTable(tables, "missing")).toEqual({ table: null, ambiguous: false });
  });

  it("coerces typed values while rejecting unknown or invalid fields", () => {
    const leads = table("table-leads", "Leads", [
      { name: "Name", type: "text" },
      { name: "Amount", type: "number" },
      { name: "Active", type: "boolean" },
    ]);
    expect(coerceBotTableValues(leads, {
      name: "Ada",
      amount: "12.5",
      active: "yes",
    })).toEqual({ Name: "Ada", Amount: 12.5, Active: true });
    expect(() => coerceBotTableValues(leads, { Amount: "many" })).toThrow("needs a number");
    expect(() => coerceBotTableValues(leads, { Missing: "value" })).toThrow("is not a column");
  });
});
