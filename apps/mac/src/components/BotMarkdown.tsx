import { useEffect, useRef, useState, type AnchorHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const MAX_LINK_CHARS = 2_048;
const REMARK_PLUGINS = [remarkGfm];

export function copyBotText(text: string) {
  if (!globalThis.navigator?.clipboard?.writeText) {
    return Promise.reject(new Error("Clipboard unavailable"));
  }
  // Keep the write inside the click gesture, as required by WebKit.
  return navigator.clipboard.writeText(text);
}

function CopyButton({ getText, label }: { getText: () => string; label: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const copy = () => {
    if (timer.current) clearTimeout(timer.current);
    void copyBotText(getText()).then(() => {
      if (!mounted.current) return;
      setStatus("copied");
      timer.current = setTimeout(() => setStatus("idle"), 2_000);
    }).catch(() => {
      if (mounted.current) setStatus("error");
    });
  };
  return (
    <>
      <button type="button" className="bot-copy-button" onClick={copy} aria-label={status === "copied" ? `${label} copied` : `Copy ${label}`}>
        {status === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        <span>{status === "copied" ? "Copied" : `Copy ${label}`}</span>
      </button>
      {status === "error" && <span className="bot-copy-feedback" role="status">Couldn’t copy. Select the text and use Copy.</span>}
    </>
  );
}

function CopyableCode({ children, className }: HTMLAttributes<HTMLPreElement>) {
  const code = useRef<HTMLPreElement>(null);
  return (
    <div className="bot-code-block">
      <div className="bot-code-actions"><CopyButton getText={() => code.current?.textContent || ""} label="code" /></div>
      <pre className={className} ref={code}>{children}</pre>
    </div>
  );
}

const COPYABLE_COMPONENTS = { a: InertLink, pre: CopyableCode };
const STREAMING_COMPONENTS = { a: InertLink };

export interface BotMarkdownProps {
  children: string;
  className?: string;
  streaming?: boolean;
}

export function safeBotMarkdownUrl(value: string | undefined) {
  const candidate = value?.trim() || "";
  if (!candidate || candidate.length > MAX_LINK_CHARS) return "";
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    if (parsed.username || parsed.password) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function InertLink({
  children,
  href,
}: AnchorHTMLAttributes<HTMLAnchorElement> & { children?: ReactNode }) {
  const safeUrl = safeBotMarkdownUrl(href);
  if (!safeUrl) return <span className="bot-markdown-link-disabled">{children}</span>;
  return (
    <span
      aria-disabled="true"
      className="bot-markdown-link"
      role="link"
      title={`Link: ${safeUrl}`}
    >
      {children}
    </span>
  );
}

export default function BotMarkdown({
  children,
  className,
  streaming = false,
}: BotMarkdownProps) {
  const classes = ["bot-markdown", className, streaming ? "streaming" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} data-streaming={streaming || undefined}>
      <ReactMarkdown
        components={streaming ? STREAMING_COMPONENTS : COPYABLE_COMPONENTS}
        disallowedElements={["img"]}
        remarkPlugins={REMARK_PLUGINS}
        skipHtml
        urlTransform={safeBotMarkdownUrl}
      >
        {children}
      </ReactMarkdown>
      {!streaming && children.trim() && (
        <div className="bot-markdown-actions"><CopyButton getText={() => children} label="answer" /></div>
      )}
    </div>
  );
}
