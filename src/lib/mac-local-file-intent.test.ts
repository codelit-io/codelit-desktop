import { describe, expect, it } from "vitest";

import {
  localConversationReply,
  parseLocalFileIntent,
  selectedFolderMatchesPurpose,
} from "../../apps/mac/src/local-file-intent";

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
});
