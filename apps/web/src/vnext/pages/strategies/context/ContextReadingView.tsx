import { createElement, useEffect, useRef, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

/** The original body and its line coordinates survive formatting unchanged. */
export function readableContextBody(content: string) {
  const normalized = content.replace(/\r\n/g, '\n');
  const frontmatter = normalized.match(/^---[^\S\n]*\n[\s\S]*?\n---[^\S\n]*(?:\n|$)/)?.[0] ?? '';
  return { body: normalized.slice(frontmatter.length), offset: frontmatter.split('\n').length - 1 };
}

export function ContextReadingView({ content, highlight }: { content: string; highlight: { start: number; end: number } | null }) {
  const { body, offset } = readableContextBody(content);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector('.is-hit')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [highlight?.start, highlight?.end]);
  const blocks = Object.fromEntries((['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'tr', 'blockquote', 'pre'] as const).map((tag) => [tag,
    ({ node, children }: ExtraProps & { children?: ReactNode }) => {
      const start = node?.position?.start.line;
      const end = node?.position?.end.line;
      const selected = highlight && start != null && end != null && start + offset <= highlight.end && end + offset >= highlight.start;
      return createElement(tag, { 'data-source-line': start == null ? undefined : start + offset, className: selected ? 'is-hit' : undefined }, children);
    },
  ]));
  const components: Components = {
    ...blocks,
    a: ({ href, children }) => <a href={href} target={href?.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer">{children}</a>,
    img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : '[Image]'}</span>,
  };
  return <div className="st-ctxdoc__reading" ref={root} aria-label="Document reading view">
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} skipHtml components={components}>{body}</ReactMarkdown>
  </div>;
}
