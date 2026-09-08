export const CONVERSATION_FIND_LIMIT = 500;

export type ConversationMatch = { range: Range; message: HTMLElement; key: string };

export function conversationTextMatches(text: string, query: string, limit = CONVERSATION_FIND_LIMIT + 1) {
  const term = query.trim();
  const matches: { start: number; end: number }[] = [];
  if (!term || limit <= 0) return matches;
  // A literal Unicode regex keeps offsets correct when case folding changes length.
  const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  for (const match of text.matchAll(pattern)) {
    matches.push({ start: match.index, end: match.index + match[0].length });
    if (matches.length >= limit) break;
  }
  return matches;
}

export function nextConversationMatch(index: number, count: number, direction: number) {
  if (!count) return -1;
  return (Math.min(Math.max(index, 0), count - 1) + direction + count) % count;
}

export function revealConversationMatch(container: HTMLElement, range: Range, fallback?: HTMLElement | null) {
  const rect = range.getBoundingClientRect();
  if (!rect.height) {
    fallback?.scrollIntoView({ block: "center" });
    return;
  }
  container.scrollTop += rect.top - container.getBoundingClientRect().top
    - container.clientHeight / 2 + rect.height / 2;
  const code = range.startContainer.parentElement?.closest("pre");
  if (code && code.scrollWidth > code.clientWidth) {
    code.scrollLeft += rect.left - code.getBoundingClientRect().left - code.clientWidth / 2;
  }
}

export function conversationRanges(root: HTMLElement, query: string, limit = CONVERSATION_FIND_LIMIT + 1) {
  if (!query.trim()) return [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number; end: number }[] = [];
  let text = "";
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest(".bot-markdown-actions, .bot-code-actions")) continue;
    const start = text.length;
    text += node.data;
    nodes.push({ node, start, end: text.length });
  }
  return conversationTextMatches(text, query, limit).map((match) => {
    const first = nodes.find((part) => part.end > match.start)!;
    const last = nodes.find((part) => part.end >= match.end)!;
    const range = root.ownerDocument.createRange();
    range.setStart(first.node, match.start - first.start);
    range.setEnd(last.node, match.end - last.start);
    return { range, offset: match.start };
  });
}

export function findConversationRanges(messages: HTMLElement[], query: string) {
  const matches: ConversationMatch[] = [];
  for (const [position, message] of messages.entries()) {
    for (const { range, offset } of conversationRanges(message, query, CONVERSATION_FIND_LIMIT + 1 - matches.length)) {
      matches.push({ range, message, key: `${position}:${offset}` });
    }
    if (matches.length > CONVERSATION_FIND_LIMIT) break;
  }
  return { matches: matches.slice(0, CONVERSATION_FIND_LIMIT), hasMore: matches.length > CONVERSATION_FIND_LIMIT };
}
