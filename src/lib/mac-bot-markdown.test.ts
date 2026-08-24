import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import BotMarkdown, {
  type BotMarkdownProps,
  safeBotMarkdownUrl,
} from "../../apps/mac/src/components/BotMarkdown";

const RenderableBotMarkdown = BotMarkdown as ComponentType<
  Omit<BotMarkdownProps, "children"> & { children?: string }
>;

function render(markdown: string, streaming = false) {
  return renderToStaticMarkup(createElement(RenderableBotMarkdown, { streaming }, markdown));
}

describe("Mac bot Markdown", () => {
  it("renders the bounded response formats used by technical answers", () => {
    const html = render([
      "# Migration plan",
      "",
      "- Keep reads scoped",
      "- Rotate credentials",
      "",
      "| Layer | Control |",
      "| --- | --- |",
      "| MCP | Read only |",
      "",
      "Use `BEGIN READ ONLY` before running:",
      "",
      "```sql",
      "select current_user;",
      "```",
      "",
      "See [the runbook](https://example.com/security).",
    ].join("\n"), true);

    expect(html).toContain("<h1>Migration plan</h1>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<table>");
    expect(html).toContain("<code>BEGIN READ ONLY</code>");
    expect(html).toContain('<code class="language-sql">');
    expect(html).toContain('role="link"');
    expect(html).toContain('title="Link: https://example.com/security"');
    expect(html).not.toContain("href=");
    expect(html).toContain('class="bot-markdown streaming"');
    expect(html).toContain('data-streaming="true"');
  });

  it("ignores raw HTML and images and leaves unsafe links inert", () => {
    const html = render([
      '<script>alert("no")</script>',
      '<img src="https://tracker.example/pixel" onerror="alert(1)">',
      "![tracker](https://tracker.example/pixel)",
      "[script](javascript:alert(1))",
      "[file](file:///Users/someone/private.txt)",
      "[data](data:text/html,unsafe)",
    ].join("\n\n"));

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("file:");
    expect(html).not.toContain("data:text");
    expect(html).not.toContain("href=");
  });

  it("renders an unfinished fenced block safely while tokens are still arriving", () => {
    const html = render("```ts\nconst ready = true;", true);

    expect(html).toContain("<pre><code class=\"language-ts\">");
    expect(html).toContain("const ready = true;");
    expect(html).toContain('data-streaming="true"');
  });

  it("accepts only bounded credential-free HTTP links", () => {
    expect(safeBotMarkdownUrl("https://example.com/docs")).toBe("https://example.com/docs");
    expect(safeBotMarkdownUrl("http://localhost:3000/docs")).toBe("http://localhost:3000/docs");
    expect(safeBotMarkdownUrl("https://user:secret@example.com/docs")).toBe("");
    expect(safeBotMarkdownUrl("/relative/path")).toBe("");
    expect(safeBotMarkdownUrl(`https://example.com/${"x".repeat(2_100)}`)).toBe("");
  });
});
