import type { AnchorHTMLAttributes, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const MAX_LINK_CHARS = 2_048;
const REMARK_PLUGINS = [remarkGfm];

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
        components={{ a: InertLink }}
        disallowedElements={["img"]}
        remarkPlugins={REMARK_PLUGINS}
        skipHtml
        urlTransform={safeBotMarkdownUrl}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
