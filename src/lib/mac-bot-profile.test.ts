import { describe, expect, it } from "vitest";
import {
  defaultBotAvatar,
  normalizeBotAvatar,
} from "../../apps/mac/src/components/BotAvatar";
import { normalizeBotName } from "../../apps/mac/src/bot-profile";

describe("Mac bot profiles", () => {
  it("gives legacy bots a stable local preset", () => {
    expect(defaultBotAvatar("bot-release")).toEqual(defaultBotAvatar("bot-release"));
    expect(normalizeBotAvatar(undefined, "bot-release")).toEqual(defaultBotAvatar("bot-release"));
  });

  it("accepts only allowlisted presets and bounded PNG data URLs", () => {
    expect(normalizeBotAvatar({ kind: "preset", preset: "orbit" }, "bot-a"))
      .toEqual({ kind: "preset", preset: "orbit" });
    expect(normalizeBotAvatar({ kind: "preset", preset: "remote-url" }, "bot-a"))
      .toEqual(defaultBotAvatar("bot-a"));
    expect(normalizeBotAvatar({ kind: "image", dataUrl: "https://example.com/avatar.png" }, "bot-a"))
      .toEqual(defaultBotAvatar("bot-a"));
    expect(normalizeBotAvatar({ kind: "image", dataUrl: "data:image/png;base64,iVBORw0KGgo=" }, "bot-a"))
      .toEqual({ kind: "image", dataUrl: "data:image/png;base64,iVBORw0KGgo=" });
  });

  it("normalizes display names before persistence", () => {
    expect(normalizeBotName("  Release\u0000 Guardian  ")).toBe("Release Guardian");
    expect(normalizeBotName("x".repeat(80))).toHaveLength(64);
  });
});
