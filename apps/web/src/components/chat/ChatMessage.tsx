import { Children, useMemo, useState, type ReactNode } from 'react';
import { Alert, Drawer, Tag, Tooltip, Typography } from 'antd';
import { ExportOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import type { Components } from 'react-markdown';
import type {
  ChatMessageAttachment,
  GroundingCaveat,
  MeriCitation,
  MeriVerification,
} from './chat-store.js';
import { attachmentKindIcon, truncateFilenameMiddle } from './ChatInput.js';
import meriBubbleImage from '../../assets/chat/meri-bubble.png';

interface ChatMessageProps {
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  citations?: MeriCitation[];
  verification?: MeriVerification;
  groundingCaveat?: GroundingCaveat;
  attachments?: ChatMessageAttachment[];
}

/** Human label for an auditor check id (D1..D14) — kept terse for the caveat. */
const CAVEAT_CHECK_LABEL: Record<string, string> = {
  D2: 'an unverified quote',
  D4: 'a reversed budget direction',
  D4b: 'a blended authorization/appropriation',
  D6: 'a reversed vote/outcome',
  D7: 'a procurement line labeled a program element',
  D11: 'an unconfirmed representation/district mapping',
};

export function ChatMessage({
  role,
  content,
  isStreaming,
  citations,
  verification,
  groundingCaveat,
  attachments,
}: ChatMessageProps) {
  const isUser = role === 'user';
  const [activeCitation, setActiveCitation] = useState<MeriCitation | null>(null);
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    void navigator.clipboard?.writeText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const citationMap = useMemo(() => {
    const map = new Map<number, MeriCitation>();
    for (const c of citations ?? []) map.set(c.n, c);
    return map;
  }, [citations]);

  // Markdown rendering is done with react-markdown + remark-gfm (real GFM tables,
  // task lists, strikethrough) and rehype-sanitize (AI text can't inject script).
  // [N] citation markers are turned into clickable chips inside every text node so
  // the click-to-open-source behavior is preserved across all block types.
  const components = useMemo<Components>(
    () => buildMarkdownComponents(citationMap, setActiveCitation),
    [citationMap],
  );

  return (
    <div className={`chat-msg chat-msg--${role}`}>
      {!isUser && (
        <div className="chat-msg-avatar" aria-hidden="true">
          <img src={meriBubbleImage} alt="" className="chat-msg-avatar-image" />
        </div>
      )}
      <div className="chat-msg-bubble">
        {attachments && attachments.length > 0 && (
          <div className="chat-msg-attachments" aria-label="Attached files">
            {attachments.map((att, i) => (
              <span key={`${att.id}-${i}`} className="chat-msg-attachment" title={att.filename}>
                <span className="chat-msg-attachment-icon" aria-hidden="true">
                  {attachmentKindIcon(att.kind)}
                </span>
                <span className="chat-msg-attachment-name">
                  {truncateFilenameMiddle(att.filename, 24)}
                </span>
                {att.status === 'truncated' && (
                  <span className="chat-msg-attachment-flag">truncated</span>
                )}
              </span>
            ))}
          </div>
        )}
        {isUser ? (
          <span className="chat-msg-text">{content}</span>
        ) : (
          <div className="chat-msg-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSanitize]}
              components={components}
            >
              {content}
            </ReactMarkdown>
          </div>
        )}
        {!isUser && content !== '' && !isStreaming && (
          <button
            type="button"
            className="chat-msg-copy"
            aria-label="Copy message"
            onClick={handleCopy}
          >
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        )}
        {!isUser && verification && verification.totalCount > 0 && (
          <div className="chat-msg-verification" style={{ marginTop: 8 }}>
            {verification.confidence && (
              <div style={{ marginBottom: 6 }}>
                <Tag
                  color={
                    verification.confidence.level === 'high'
                      ? 'green'
                      : verification.confidence.level === 'medium'
                        ? 'gold'
                        : verification.confidence.level === 'low'
                          ? 'red'
                          : 'default'
                  }
                >
                  {verification.confidence.label}
                </Tag>
              </div>
            )}
            {verification.lowConfidence ? (
              <Alert
                type="warning"
                showIcon
                message={`Low confidence — ${verification.unsupportedCount} of ${verification.totalCount} claims aren't backed by the cited sources.`}
              />
            ) : verification.unsupportedCount > 0 ? (
              <Alert
                type="info"
                showIcon
                message={`${verification.unsupportedCount} of ${verification.totalCount} claims couldn't be tied to a source.`}
              />
            ) : (
              <Typography.Text type="success" style={{ fontSize: 12 }}>
                ✓ {verification.totalCount} claims checked against sources
              </Typography.Text>
            )}
            {verification.claims.some((c) => !c.supported) && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {verification.claims
                  .filter((c) => !c.supported)
                  .map((claim, i) => (
                    <li key={i} style={{ fontSize: 12, marginBottom: 2 }}>
                      <Tooltip title="Not supported by the retrieved sources">
                        <span
                          style={{
                            textDecoration: 'underline',
                            textDecorationStyle: 'wavy',
                            textDecorationColor: 'var(--notable, #a26913)',
                          }}
                        >
                          {claim.claim}
                        </span>
                      </Tooltip>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        )}
        {!isUser && groundingCaveat && groundingCaveat.findings.length > 0 && (
          <div className="chat-msg-grounding-caveat" style={{ marginTop: 8 }}>
            <Alert
              type={groundingCaveat.topSeverity === 'critical' ? 'error' : 'warning'}
              showIcon
              message="Meri flagged a possible grounding issue in this reply"
              description={
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {groundingCaveat.findings.map((f, i) => (
                    <li key={`${f.check}-${i}`} style={{ fontSize: 12, marginBottom: 2 }}>
                      <Tooltip title={f.detail}>
                        <span>
                          {CAVEAT_CHECK_LABEL[f.check] ?? `a grounding issue (${f.check})`} —{' '}
                          <span style={{ color: 'var(--ant-color-text-secondary, #888)' }}>
                            verify before relying on it
                          </span>
                        </span>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              }
            />
          </div>
        )}
        {isStreaming && <span className="chat-msg-cursor" aria-hidden="true" />}
      </div>

      <Drawer
        className="chat-citation-drawer"
        title="Source"
        placement="right"
        width={Math.min(420, typeof window !== 'undefined' ? window.innerWidth - 24 : 420)}
        open={Boolean(activeCitation)}
        onClose={() => setActiveCitation(null)}
        destroyOnClose
      >
        {activeCitation && (
          <div className="chat-citation-detail">
            <Tag color="blue">{citationTypeLabel(activeCitation.type)}</Tag>
            <Typography.Title level={5} style={{ marginTop: 12 }}>
              {activeCitation.title}
            </Typography.Title>
            {activeCitation.snippet && (
              <Typography.Paragraph type="secondary">{activeCitation.snippet}</Typography.Paragraph>
            )}
            {activeCitation.url && (
              <Typography.Link href={activeCitation.url} target="_blank" rel="noopener noreferrer">
                Open source <ExportOutlined />
              </Typography.Link>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}

function citationTypeLabel(type: string): string {
  return type
    .split('_')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Walk rendered markdown children and replace `[N]` markers (where N maps to a
 * real citation) with clickable chips. Non-string children pass through
 * unchanged so nested formatting (bold, links) is preserved.
 */
function injectCitations(
  children: ReactNode,
  citationMap: Map<number, MeriCitation>,
  onOpen: (c: MeriCitation) => void,
): ReactNode {
  if (citationMap.size === 0) return children;
  return Children.map(children, (child) => {
    if (typeof child === 'string') {
      return splitCitations(child, citationMap, onOpen);
    }
    return child;
  });
}

function splitCitations(
  text: string,
  citationMap: Map<number, MeriCitation>,
  onOpen: (c: MeriCitation) => void,
): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /\[(\d{1,3})\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    const citation = citationMap.get(n);
    if (!citation) continue;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <button
        key={`cite-${key++}`}
        type="button"
        className="chat-citation"
        data-cite={n}
        title={`View source ${n}`}
        onClick={() => onOpen(citation)}
      >
        [{n}]
      </button>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : [text];
}

/** Recursively inject citations into a node's children for block elements. */
function kids(
  children: ReactNode,
  citationMap: Map<number, MeriCitation>,
  onOpen: (c: MeriCitation) => void,
): ReactNode {
  return injectCitations(children, citationMap, onOpen);
}

function buildMarkdownComponents(
  citationMap: Map<number, MeriCitation>,
  onOpen: (c: MeriCitation) => void,
): Components {
  return {
    p: ({ children }) => <p className="chat-md-p">{kids(children, citationMap, onOpen)}</p>,
    li: ({ children }) => <li>{kids(children, citationMap, onOpen)}</li>,
    h1: ({ children }) => (
      <div className="chat-md-h chat-md-h1">{kids(children, citationMap, onOpen)}</div>
    ),
    h2: ({ children }) => (
      <div className="chat-md-h chat-md-h2">{kids(children, citationMap, onOpen)}</div>
    ),
    h3: ({ children }) => (
      <div className="chat-md-h chat-md-h3">{kids(children, citationMap, onOpen)}</div>
    ),
    h4: ({ children }) => (
      <div className="chat-md-h chat-md-h4">{kids(children, citationMap, onOpen)}</div>
    ),
    h5: ({ children }) => (
      <div className="chat-md-h chat-md-h4">{kids(children, citationMap, onOpen)}</div>
    ),
    h6: ({ children }) => (
      <div className="chat-md-h chat-md-h4">{kids(children, citationMap, onOpen)}</div>
    ),
    ul: ({ children }) => <ul className="chat-md-list">{children}</ul>,
    ol: ({ children }) => <ol className="chat-md-list">{children}</ol>,
    hr: () => <hr className="chat-md-hr" />,
    blockquote: ({ children }) => (
      <blockquote className="chat-md-quote">{kids(children, citationMap, onOpen)}</blockquote>
    ),
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
    code: ({ children, className }) => {
      // Block code carries a language- className; inline code does not.
      const isBlock = typeof className === 'string' && className.includes('language-');
      if (isBlock) return <code className={className}>{children}</code>;
      return <code className="chat-md-code">{children}</code>;
    },
    pre: ({ children }) => <pre className="chat-md-pre">{children}</pre>,
    table: ({ children }) => (
      <div className="chat-md-table-wrap">
        <table className="chat-md-table">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead>{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => <tr>{children}</tr>,
    th: ({ children }) => <th>{kids(children, citationMap, onOpen)}</th>,
    td: ({ children }) => <td>{kids(children, citationMap, onOpen)}</td>,
    strong: ({ children }) => <strong>{kids(children, citationMap, onOpen)}</strong>,
    em: ({ children }) => <em>{kids(children, citationMap, onOpen)}</em>,
  };
}
