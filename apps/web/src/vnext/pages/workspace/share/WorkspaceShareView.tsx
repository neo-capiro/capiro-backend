/**
 * Public Workspace share (design-handoff §11).
 *
 * Mounted by `main.tsx` before Clerk and the authenticated application. Keep
 * imports deliberately narrow: no app shell, tenant context, Agent state,
 * internal navigation or authenticated API client.
 *
 * The same 404 is returned for expired, revoked and unknown tokens — a
 * security property. Never differentiate the dead-link responses.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { PublicShareDocument } from '../types/agent.js';
import { WorkspaceIcon } from '../components/WorkspaceIcon.js';
import '../styles/workspace.css';
import '../styles/workspace-parity.css';

const MAX_COMMENT_CHARS = 2_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizePublicDocument(value: unknown): PublicShareDocument {
  const row = record(value);
  const sections = Array.isArray(row.sections)
    ? row.sections.map((rawSection) => {
        const section = record(rawSection);
        return {
          title: typeof section.title === 'string' ? section.title : '',
          body:
            typeof section.content === 'string'
              ? section.content
              : typeof section.body === 'string'
                ? section.body
                : '',
        };
      })
    : [];

  return {
    docTitle: typeof row.docTitle === 'string' ? row.docTitle : 'Shared document',
    body: sections.map((section) => section.body).join('\n\n'),
    documentType: typeof row.documentType === 'string' ? row.documentType : undefined,
    expiresAt: typeof row.expiresAt === 'string' ? row.expiresAt : undefined,
    sections,
    theme:
      row.theme && typeof row.theme === 'object'
        ? (row.theme as PublicShareDocument['theme'])
        : undefined,
  };
}

async function publicRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/workspace-api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw Object.assign(new Error('Public Workspace request failed'), {
      statusCode: response.status,
    });
  }
  return response.json() as Promise<T>;
}

const publicWorkspaceApi = {
  getShare: async (token: string) =>
    normalizePublicDocument(
      await publicRequest<unknown>('GET', `/public/workspace-share/${encodeURIComponent(token)}`),
    ),
  addComment: (token: string, text: string) =>
    publicRequest<unknown>(
      'POST',
      `/public/workspace-share/${encodeURIComponent(token)}/comments`,
      { text },
    ),
};

export interface WorkspaceShareViewProps {
  token: string;
}

type LoadState = 'loading' | 'ready' | 'unavailable';

function formatExpiry(iso: string | undefined): string {
  if (!iso) return '';
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return '';
  return value.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function paragraphs(body: string) {
  return body
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => <p key={index}>{part}</p>);
}

export function WorkspaceShareView({ token }: WorkspaceShareViewProps) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [document, setDocument] = useState<PublicShareDocument | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [commentSent, setCommentSent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    publicWorkspaceApi
      .getShare(token)
      .then((result) => {
        if (cancelled) return;
        setDocument(result);
        setLoadState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setDocument(null);
        setLoadState('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submitComment = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const text = comment.trim();
      if (!text || submitting) return;
      setSubmitting(true);
      setCommentError(null);
      setCommentSent(false);
      try {
        await publicWorkspaceApi.addComment(token, text);
        setComment('');
        setCommentSent(true);
      } catch (error) {
        const status = (error as { statusCode?: number } | null)?.statusCode ?? 0;
        setCommentError(
          status === 429
            ? 'Too many comments. Please try again in 5 minutes.'
            : 'Could not submit your comment. Please try again.',
        );
      } finally {
        setSubmitting(false);
      }
    },
    [comment, submitting, token],
  );

  const paperColor =
    (document?.theme as { settings?: { paperColor?: string } } | undefined)?.settings
      ?.paperColor ?? '#FEFDFA';

  if (loadState === 'loading') {
    return (
      <div className="ws-share" role="status" aria-busy="true">
        <div className="ws-share__sheet" style={{ paddingTop: 80 }}>
          <div className="ws-share-skeleton" style={{ width: '60%' }} />
          <div className="ws-share-skeleton" style={{ width: '100%' }} />
          <div className="ws-share-skeleton" style={{ width: '90%' }} />
        </div>
      </div>
    );
  }

  // Invalid, expired and revoked links intentionally share one response.
  if (loadState === 'unavailable' || !document) {
    return (
      <div className="ws-share">
        <div className="ws-share__header">
          <span className="ws-share__brand">Capiro</span>
          <span className="ws-share__divider" />
          <span className="ws-share__label">Shared document · read only</span>
        </div>
        <div className="ws-share__dead">
          <span className="ws-share__dead-icon">
            <WorkspaceIcon name="SlashCircle01" size={20} color="#667085" />
          </span>
          <h2>This link is no longer available</h2>
          <p>
            The link may have expired or been revoked. Ask your Capiro contact for a new one —
            the same 404 is returned for expired, revoked and unknown tokens.
          </p>
        </div>
      </div>
    );
  }

  const expiry = formatExpiry(document.expiresAt);

  return (
    <div className="ws-share">
      <header className="ws-share__header">
        <span className="ws-share__brand">Capiro</span>
        <span className="ws-share__divider" />
        <span className="ws-share__label">Shared document · read only</span>
        <span className="ws-share__spacer" />
        {expiry ? <span className="ws-share__expiry">Expires {expiry}</span> : null}
      </header>

      <main className="ws-share__body">
        <article className="ws-share__sheet" style={{ background: paperColor }}>
          <span className="ws-share__spine" />
          {document.documentType ? (
            <span className="ws-share__eyebrow">{document.documentType}</span>
          ) : null}
          <h1>{document.docTitle}</h1>
          {document.sections?.length
            ? document.sections.map((section, index) => (
                <section key={`${section.title}-${index}`}>
                  <h2>{section.title}</h2>
                  {paragraphs(section.body)}
                </section>
              ))
            : paragraphs(document.body)}
          <footer className="ws-share__footer">
            <span>Confidential · shared copy</span>
          </footer>
        </article>

        <section className="ws-share__comment">
          <span className="ws-share__comment-title">Leave a comment</span>
          <span className="ws-share__comment-rule">
            Comments go to the Capiro team on this document. Plain text only, 2,000 characters,
            up to ten comments every five minutes.
          </span>
          <form onSubmit={submitComment}>
            <textarea
              value={comment}
              onChange={(event) => {
                setComment(event.target.value.slice(0, MAX_COMMENT_CHARS));
                setCommentError(null);
                setCommentSent(false);
              }}
              maxLength={MAX_COMMENT_CHARS}
              placeholder="Add a note for the team…"
              aria-label="Guest comment"
              disabled={submitting}
            />
            <div className="ws-share__comment-meta">
              <span className="ws-share__comment-count">
                {comment.length} / {MAX_COMMENT_CHARS} characters · HTML is stripped
              </span>
              <button
                type="submit"
                className="ws-share__comment-send"
                disabled={submitting || comment.trim().length === 0}
              >
                {submitting ? 'Sending…' : 'Send comment'}
              </button>
            </div>
            {commentError ? (
              <div role="alert" className="ws-share__comment-error">
                {commentError}
              </div>
            ) : null}
            {commentSent ? (
              <div role="status" className="ws-share__comment-success">
                Comment sent. The document team can now review it.
              </div>
            ) : null}
          </form>
        </section>

        <div className="ws-share__privacy">
          <WorkspaceIcon name="Shield01" size={15} color="#475467" />
          <span>
            This view is a frozen copy. It carries no tenant identifiers, internal context
            packets, memory files, internal comments, private source text or model prompts.
          </span>
        </div>
      </main>
    </div>
  );
}

export default WorkspaceShareView;
