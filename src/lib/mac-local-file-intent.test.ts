import { describe, expect, it } from "vitest";

import {
  documentSelectionReducer,
  localConversationReply,
  parseLocalFileIntent,
  selectedFolderMatchesPurpose,
} from "../../apps/mac/src/local-file-intent";

describe("Composer document selection lifecycle", () => {
  const scope = { botId: "a", root: "/approved/a" };
  const selected = { ...scope, path: "Supplier's A.txt" };
  const pick = { type: "picked" as const, scope, path: selected.path };

  it("selects only for the current bot and approved root", () => {
    expect(documentSelectionReducer(null, pick, scope)).toEqual(selected);
    expect(documentSelectionReducer(null, pick, { ...scope, botId: "b" })).toBeNull();
    expect(documentSelectionReducer(null, pick, { ...scope, root: "/approved/b" })).toBeNull();
    expect(documentSelectionReducer(null, pick, { ...scope, root: null })).toBeNull();
  });

  it("invalidates on bot switch, folder change or revoked access and does not resurrect", () => {
    for (const next of [{ ...scope, botId: "b" }, { ...scope, root: "/other" }, { ...scope, root: null }]) {
      const cleared = documentSelectionReducer(selected, { type: "scope" }, next);
      expect(cleared).toBeNull();
      expect(documentSelectionReducer(cleared, { type: "scope" }, scope)).toBeNull();
    }
  });

  it("preserves a selection on picker cancellation and read failure/cancellation", () => {
    expect(documentSelectionReducer(selected, { ...pick, path: null }, scope)).toEqual(selected);
    expect(documentSelectionReducer(selected, { type: "finished", selection: selected, success: false }, scope)).toEqual(selected);
  });

  it("consumes only the successful request selection and supports explicit removal", () => {
    expect(documentSelectionReducer(selected, { type: "finished", selection: selected, success: true }, scope)).toBeNull();
    expect(documentSelectionReducer(selected, { type: "remove" }, scope)).toBeNull();
    const newer = { ...selected, path: "Other.txt" };
    expect(documentSelectionReducer(newer, { type: "finished", selection: selected, success: true }, scope)).toEqual(newer);
  });
});

describe("Mac local file and conversation intents", () => {
  it("answers a plain greeting without selecting project files", () => {
    expect(parseLocalFileIntent("hi")).toBeNull();
    expect(localConversationReply("hi", "Release Bot")).toBe(
      "Hi! I'm Release Bot. What should we work on?",
    );
    expect(localConversationReply("Hi, what can you help me with?", "Release Bot")).toBe(
      "Hi! I'm Release Bot. What should we work on?",
    );
  });

  it("does not intercept a greeting that includes real work", () => {
    expect(localConversationReply("Hi, check my desktop files", "Release Bot")).toBeNull();
    expect(parseLocalFileIntent("Hi, check my desktop files")).toEqual({
      kind: "list-folder",
      purpose: "desktop",
    });
  });

  it("lets the model inspect real connector availability instead of returning canned account copy", () => {
    expect(localConversationReply("can you connect to my gmail", "Release Bot")).toBeNull();
    expect(localConversationReply("help me plan a launch", "Release Bot")).toBeNull();
  });

  it("keeps project and Desktop folder purposes separate", () => {
    expect(parseLocalFileIntent("What's this codebase about?")).toEqual({
      kind: "describe-project",
    });
    expect(selectedFolderMatchesPurpose("/Users/mo/Desktop", "desktop")).toBe(true);
    expect(selectedFolderMatchesPurpose("/Users/mo/project", "project")).toBe(true);
  });

  it("recognizes the explicit connected-project file read without changing its path", () => {
    expect(parseLocalFileIntent("Read acceptance.txt from the connected project and quote its two lines."))
      .toEqual({ kind: "read-project-file", path: "acceptance.txt" });
    expect(parseLocalFileIntent('Quote "Docs/Acceptance.TXT" in my selected repository.'))
      .toEqual({ kind: "read-project-file", path: "Docs/Acceptance.TXT" });
    expect(parseLocalFileIntent("Read https://acceptance.txt from the connected project"))
      .toBeNull();
  });
});
