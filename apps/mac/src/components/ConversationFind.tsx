import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { findConversationRanges, nextConversationMatch, revealConversationMatch, type ConversationMatch } from "./conversation-find";

export default function ConversationFind({
  conversationRef,
  focusRequest,
  onClose,
}: {
  conversationRef: RefObject<HTMLDivElement | null>;
  focusRequest: number;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ConversationMatch[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [messageCount, setMessageCount] = useState(0);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastScrolled = useRef("");
  const selected = matches.length ? Math.min(Math.max(index, 0), matches.length - 1) : -1;
  const move = (direction: number) => setIndex(nextConversationMatch(selected, matches.length, direction));

  useEffect(() => {
    const opener = document.activeElement;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (opener instanceof HTMLElement && opener.isConnected && !opener.closest("[inert]")) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [onClose]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation) return;
    let frame = 0;
    const refresh = () => {
      const messages = Array.from(conversation.querySelectorAll<HTMLElement>(
        ".bot-message.user > p, .bot-message.assistant > .bot-markdown, .bot-live-answer",
      ));
      setMessageCount(messages.length);
      const found = findConversationRanges(messages, query);
      setMatches(found.matches);
      setHasMore(found.hasMore);
    };
    refresh();
    const observer = new MutationObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(refresh);
    });
    observer.observe(conversation, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [conversationRef, query]);

  useEffect(() => {
    const active = matches[selected];
    const message = active?.message.closest<HTMLElement>(".bot-message, .bot-live-response");
    message?.setAttribute("data-find-active", "true");
    if (typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined") {
      const all = new Highlight();
      for (const match of matches) all.add(match.range);
      CSS.highlights.set("bots-find-match", all);
      CSS.highlights.set("bots-find-current", new Highlight(...(active ? [active.range] : [])));
    }
    const scrollKey = active ? `${query}:${active.key}` : "";
    if (active && lastScrolled.current !== scrollKey) {
      const container = conversationRef.current;
      if (container) revealConversationMatch(container, active.range, message);
    }
    lastScrolled.current = scrollKey;
    return () => {
      message?.removeAttribute("data-find-active");
      if (typeof CSS !== "undefined" && CSS.highlights) {
        CSS.highlights.delete("bots-find-match");
        CSS.highlights.delete("bots-find-current");
      }
    };
  }, [conversationRef, matches, query, selected]);

  const count = !messageCount ? "No messages yet"
    : !query.trim() ? "Type to search"
      : matches.length ? `${selected + 1} of ${matches.length}${hasMore ? "+" : ""}` : "No matches";
  const hint = hasMore ? "Showing the first 500 matches. Refine your search to see fewer results." : undefined;
  return (
    <section className="bots-conversation-find" role="search" aria-label="Find in conversation">
      <div className="bots-conversation-find-field">
        <Search size={15} aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="Find in conversation"
          aria-describedby="bots-conversation-find-count"
          placeholder="Find in conversation"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              move(event.shiftKey ? -1 : 1);
            }
          }}
        />
        {query && <button className="bots-icon-button" aria-label="Clear search" title="Clear search" onClick={() => { setQuery(""); setIndex(0); inputRef.current?.focus(); }}><X size={13} /></button>}
      </div>
      <span className="bots-conversation-find-count" id="bots-conversation-find-count" role="status" aria-live="polite" aria-atomic="true" title={hint} aria-label={hint ? `${count}. ${hint}` : undefined}>{count}</span>
      <div className="bots-conversation-find-actions">
        <button className="bots-icon-button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!matches.length} onClick={() => move(-1)}><ChevronUp size={16} /></button>
        <button className="bots-icon-button" aria-label="Next match" title="Next match (Enter)" disabled={!matches.length} onClick={() => move(1)}><ChevronDown size={16} /></button>
        <button className="bots-icon-button" aria-label="Close search" title="Close search (Esc)" onClick={onClose}><X size={16} /></button>
      </div>
    </section>
  );
}
