/**
 * Public Workspace share.
 *
 * This component is mounted by `main.tsx` before Clerk and the authenticated
 * application. Keep imports deliberately narrow: no app shell, tenant context,
 * Agent state, internal navigation or authenticated API client.
 */
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from 'react';
import type { PublicShareDocument } from '../types/agent.js';
import '../styles/workspace.css';
import '../styles/workspace-audit.css';

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
    docTitle:
      typeof row.docTitle === 'string' ? row.docTitle : 'Shared document',
    body: sections.map((section) => section.body).join('\n\n'),
    documentType:
      typeof row.documentType === 'string' ? row.documentType : undefined,
    expiresAt:
      typeof row.expiresAt === 'string' ? row.expiresAt : undefined,
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
    headers:
      body === undefined ? undefined : { 'Content-Type': 'application/json' },
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
      await publicRequest<unknown>(
        'GET',
        `/public/workspace-share/${encodeURIComponent(token)}`,
      ),
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
  return value.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
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
        const status =
          (error as { statusCode?: number } | null)?.statusCode ?? 0;
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

  if (loadState === 'loading') {
    return (
      <div className="ws-vnext-share" role="status" aria-busy="true">
        <div className="ws-vnext-share__paper" style={{ paddingTop: 80 }}>
          <div className="ws-vnext-skeleton-row" style={{ width: '60%' }} />
          <div className="ws-vnext-skeleton-row" style={{ width: '100%' }} />
          <div className="ws-vnext-skeleton-row" style={{ width: '90%' }} />
          <div className="ws-vnext-skeleton-row" style={{ width: '75%' }} />
        </div>
      </div>
    );
  }

  // Invalid, expired and revoked links intentionally share one response.
  if (loadState === 'unavailable' || !document) {
    return (
      <div className="ws-vnext-share">
        <div className="ws-vnext-share__unavailable">
          <div className="ws-vnext-share__unavailable-title">
            This document is no longer available
          </div>
          <div className="ws-vnext-share__unavailable-desc">
            The share link may have expired or been revoked by its owner.
            Contact the person who shared it if you believe this is a mistake.
          </div>
          <div className="ws-vnext-share__sanitization-note">
            Public shares are read-only and content is sanitized before display.
          </div>
        </div>
      </div>
    );
  }

  const expiry = formatExpiry(document.expiresAt);

  return (
    <div className="ws-vnext-share">
      <header className="ws-vnext-share__header">
        <span
          className="ws-vnext-share__label"
          style={{
            fontWeight: 700,
            letterSpacing: '0.04em',
            color: 'var(--ws-ink)',
          }}
        >
          Capiro
        </span>
        <span className="ws-vnext-share__label">
          SHARED DOCUMENT · READ ONLY
        </span>
        {expiry ? (
          <span className="ws-vnext-share__expiry">Expires {expiry}</span>
        ) : null}
      </header>

      <main className="ws-vnext-share__paper">
        <article className="ws-vnext-paper">
          {document.documentType ? (
            <div className="ws-vnext-paper__eyebrow">
              {document.documentType}
            </div>
          ) : null}
          <h1>{document.docTitle}</h1>
          <hr className="ws-vnext-paper__rule" />
          {document.sections?.length
            ? document.sections.map((section, index) => (
                <section key={`${section.title}-${index}`}>
                  <h2>{section.title}</h2>
                  {paragraphs(section.body)}
                </section>
              ))
            : paragraphs(document.body)}
        </article>
      </main>

      <section className="ws-vnext-share__guest-comment">
        <form
          className="ws-vnext-share__comment-box"
          onSubmit={submitComment}
        >
          <textarea
            value={comment}
            onChange={(event) => {
              setComment(event.target.value.slice(0, MAX_COMMENT_CHARS));
              setCommentError(null);
              setCommentSent(false);
            }}
            maxLength={MAX_COMMENT_CHARS}
            placeholder="Leave a comment for the document owner…"
            aria-label="Guest comment"
            disabled={submitting}
          />
          <div className="ws-vnext-share__comment-meta">
            <span className="ws-vnext-share__char-count">
              {comment.length}/{MAX_COMMENT_CHARS}
              {comment.length >= MAX_COMMENT_CHARS
                ? ' — limit reached'
                : ''}
            </span>
            <button
              type="submit"
              disabled={submitting || comment.trim().length === 0}
              className="ws-vnext-btn ws-vnext-btn--primary ws-vnext-btn--sm"
            >
              {submitting ? 'Sending…' : 'Send comment'}
            </button>
          </div>
          {commentError ? (
            <div role="alert" className="ws-vnext-share__comment-error">
              {commentError}
            </div>
          ) : null}
          {commentSent ? (
            <div role="status" className="ws-vnext-share__comment-success">
              Comment sent. The document team can now review it.
            </div>
          ) : null}
        </form>
      </section>

      <footer className="ws-vnext-share__sanitization-note">
        Plain text only · 2,000 characters · ten comments per five minutes.
        Public content is sanitized before display.
      </footer>
    </div>
  );
}

export default WorkspaceShareView;
