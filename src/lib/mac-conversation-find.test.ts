import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConversationFind from "../../apps/mac/src/components/ConversationFind";
import {
  conversationRanges,
  conversationTextMatches,
  findConversationRanges,
  nextConversationMatch,
  revealConversationMatch,
} from "../../apps/mac/src/components/conversation-find";
import { listenForConversationFind } from "../../apps/mac/src/components/conversation-find-shortcut";

afterEach(() => vi.unstubAllGlobals());

function message(parts: { text: string; control?: boolean }[]) {
  const nodes = parts.map(({ text, control }) => ({
    data: text,
    parentElement: { closest: () => control ? {} : null },
  }));
  const document = {
    createTreeWalker: () => {
      let index = -1;
      return { nextNode: () => nodes[++index], get currentNode() { return nodes[index]; } };
    },
    createRange: () => ({ setStart: vi.fn(), setEnd: vi.fn() }),
  };
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
  return { root: { ownerDocument: document } as unknown as HTMLElement, nodes };
}

describe("conversation Find", () => {
  it("finds repeated literal text case-insensitively without treating input as a regex", () => {
    expect(conversationTextMatches("Use [a+b]. Then [A+B].", "[a+b]"))
      .toEqual([{ start: 4, end: 9 }, { start: 16, end: 21 }]);
    expect(conversationTextMatches("hello", " ")).toEqual([]);
    expect(conversationTextMatches("hello", "missing")).toEqual([]);
  });

  it("keeps range offsets after Unicode text and across formatted fragments", () => {
    const { root, nodes } = message([{ text: "İ 🙂 Find " }, { text: "this" }, { text: " word." }]);
    const matches = conversationRanges(root, "find this word");
    expect(matches).toHaveLength(1);
    expect(matches[0].range.setStart).toHaveBeenCalledWith(nodes[0], 5);
    expect(matches[0].range.setEnd).toHaveBeenCalledWith(nodes[2], 5);
  });

  it("searches code content while excluding Copy buttons and feedback", () => {
    const { root } = message([
      { text: "Copy answer", control: true },
      { text: "Copy code", control: true },
      { text: "const copied = true;" },
      { text: "Copied", control: true },
    ]);
    expect(conversationRanges(root, "copy")).toHaveLength(0);
    expect(conversationRanges(root, "copied")).toHaveLength(1);
  });

  it("recomputes fresh ranges for streamed content and matches ending at node boundaries", () => {
    const { root, nodes } = message([{ text: "Ready" }, { text: " now" }]);
    const initial = conversationRanges(root, "ready");
    expect(initial[0].range.setEnd).toHaveBeenCalledWith(nodes[0], 5);
    nodes[1].data += " and ready";
    const streamed = conversationRanges(root, "ready");
    expect(streamed).toHaveLength(2);
    expect(streamed[1].range.setStart).toHaveBeenCalledWith(nodes[1], 9);
    expect(streamed[1].range.setEnd).toHaveBeenCalledWith(nodes[1], 14);
  });

  it("wraps previous/next and handles empty or shrinking result sets", () => {
    expect(nextConversationMatch(0, 3, -1)).toBe(2);
    expect(nextConversationMatch(2, 3, 1)).toBe(0);
    expect(nextConversationMatch(4, 2, 1)).toBe(0);
    expect(nextConversationMatch(0, 0, 1)).toBe(-1);
    expect(nextConversationMatch(-1, 1, 1)).toBe(0);
  });

  it("bounds a common query across a long conversation and reports truncation accurately", () => {
    const first = message([{ text: "a ".repeat(300) }]);
    const second = message([{ text: "a ".repeat(50_000) }]);
    const truncated = findConversationRanges([first.root, second.root], "a");
    expect(truncated.matches).toHaveLength(500);
    expect(truncated.hasMore).toBe(true);
    expect(truncated.matches[499].message).toBe(second.root);
    expect(conversationTextMatches("a".repeat(100_000), "a")).toHaveLength(501);
    const exact = message([{ text: "a ".repeat(500) }]);
    expect(findConversationRanges([exact.root], "a").hasMore).toBe(false);
    expect(findConversationRanges([exact.root], " ").matches).toEqual([]);
  });

  it("reveals a match vertically and within a horizontally scrolling code block", () => {
    const container = { scrollTop: 100, clientHeight: 200, getBoundingClientRect: () => ({ top: 100 }) };
    const code = { scrollLeft: 0, scrollWidth: 900, clientWidth: 200, getBoundingClientRect: () => ({ left: 100 }) };
    const range = {
      getBoundingClientRect: () => ({ top: 400, left: 500, height: 20 }),
      startContainer: { parentElement: { closest: () => code } },
    };
    revealConversationMatch(container as HTMLElement, range as unknown as Range);
    expect(container.scrollTop).toBe(310);
    expect(code.scrollLeft).toBe(300);
  });

  it("intercepts only Find shortcuts and releases the listener when its view closes", () => {
    const target = new EventTarget();
    const open = vi.fn();
    const dispose = listenForConversationFind(target as Window, open);
    const key = (modifiers: object) => {
      const event = Object.assign(new Event("keydown", { cancelable: true }), { key: "f", ...modifiers });
      target.dispatchEvent(event);
      return event;
    };
    expect(key({ metaKey: true }).defaultPrevented).toBe(true);
    expect(key({ ctrlKey: true, key: "F" }).defaultPrevented).toBe(true);
    expect(key({}).defaultPrevented).toBe(false);
    expect(key({ metaKey: true, isComposing: true }).defaultPrevented).toBe(false);
    expect(key({ ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
    dispose();
    expect(key({ metaKey: true }).defaultPrevented).toBe(false);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("exposes labeled search controls and an empty conversation status", () => {
    const html = renderToStaticMarkup(createElement(ConversationFind, {
      conversationRef: { current: null }, focusRequest: 1, onClose: () => undefined,
    }));
    expect(html).toContain('role="search" aria-label="Find in conversation"');
    expect(html).toContain('aria-describedby="bots-conversation-find-count"');
    expect(html).toContain("No messages yet");
    expect(html).toMatch(/aria-label="Previous match"[^>]*disabled/);
    expect(html).toMatch(/aria-label="Next match"[^>]*disabled/);
    expect(html).toContain('aria-label="Close search"');
  });
});
