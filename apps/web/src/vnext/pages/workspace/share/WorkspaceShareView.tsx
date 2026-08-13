/**
 * Public Share View — unauthenticated, shell-less document view at /share/:token.
 *
 * This is a SEPARATE entry: no app shell, no tenant context, no Agent state,
 * no internal comments, no context packets, no model/provider info. It renders
 * a frozen read-only paper plus a guest comment box on a plain background.
 *
 * Security note: expired, revoked and unknown tokens render the EXACT SAME
 * unavailable state. The UI never reveals which condition applied.
 */

import { useEffect, useState, useCallback, FormEvent } from 'react';

import { api } from '../api/client.js';
import type { PublicShareDocument } from '../types/agent.js';
import '../styles/workspace.css';

const MAX_COMMENT_CHARS = 2000;

export interface WorkspaceShareViewProps {
  token: string;
}

type LoadState = 'loading' | 'ready' | 'unavailable';

function formatExpiry(iso: string | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

function renderBody(body: string) {
  // Render the document body as paragraphs, splitting on blank lines. Text is
  // inserted as React text nodes so it is escaped by default — no
  // dangerouslySetInnerHTML. The server is responsible for sanitization; this
  // view only displays what it received.
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return [];
  return paragraphs.map((p, i) => <p key={i}>{p}</p>);
}

export function WorkspaceShareView({ token }: WorkspaceShareViewProps) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [doc, setDoc] = useState<PublicShareDocument | null>(null);

  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [commentOk, setCommentOk] = useState(false);

  // Fetch the public document. ANY failure — expired, revoked, unknown token,
  // network error — collapses to the same `unavailable` state. We deliberately
  // do not inspect the status code or error body here.
  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    api
      .getPublicShare(token)
      .then((d) => {
        if (cancelled) return;
        setDoc(d);
        setLoadState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setDoc(null);
        setLoadState('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSubmitComment = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const text = comment.trim();
      if (!text || submitting) return;
      setSubmitting(true);
      setCommentError(null);
      setCommentOk(false);
      try {
        await api.addGuestComment(token, text);
        setComment('');
        setCommentOk(true);
      } catch (err: unknown) {
        const status =
          (err as { statusCode?: number } | null)?.statusCode ?? 0;
        if (status === 429) {
          setCommentError('Too many comments. Please try again in 5 minutes.');
        } else {
          // Non-rate-limit failures are also collapsed to a generic message;
          // we never reveal whether the token is still valid from this path.
          setCommentError('Could not submit your comment. Please try again.');
        }
      } finally {
        setSubmitting(false);
      }
    },
    [comment, submitting, token],
  );

  // ── Loading ──────────────────────────────────────────────────────────────
  if (loadState === 'loading') {
    return (
      <div className="ws-vnext-share" role="status" aria-busy="true">
        <div className="ws-vnext-share__paper" style={{ paddingTop: 80 }}>
          <div className="ws-vnext-skeleton-row" style={{ width: '60%' }} />
          <div className="ws-vnext-skeleton-row" style={{ width: '100%' }} />
          <div className="ws-vnext-skeleton-row" style={{ width: '90%' }} />
          <div className="ws-vnext-skeleton-row" style={{ width: '75%' }} />
          <div className="ws-vnext-skeleton-row" style={{ width: '95%' }} />
        </div>
      </div>
    );
  }

  // ── Unavailable (expired / revoked / unknown — identical UI) ─────────────
  if (loadState === 'unavailable' || !doc) {
    return (
      <div className="ws-vnext-share">
        <div className="ws-vnext-share__unavailable">
          <div className="ws-vnext-share__unavailable-title">
            This document is no longer available
          </div>
          <div className="ws-vnext-share__unavailable-desc">
            The share link may have expired or been revoked by its owner. Please
            contact the person who shared it with you if you believe this is a
            mistake.
          </div>
          <div className="ws-vnext-share__sanitization-note">
            Public shares are read-only and content is sanitized before
            display.
          </div>
        </div>
      </div>
    );
  }

  // ── Ready ───────────────────────────────────────────────────────────────
  const expiry = formatExpiry(doc.expiresAt);
  const remaining = MAX_COMMENT_CHARS - comment.length;

  return (
    <div className="ws-vnext-share">
      {/* Minimal header — logo, read-only label, expiry. Nothing else. */}
      <header className="ws-vnext-share__header">
        <span
          className="ws-vnext-share__label"
          style={{ fontWeight: 700, letterSpacing: '0.04em', color: 'var(--ws-ink)' }}
        >
          Capiro
        </span>
        <span className="ws-vnext-share__label">SHARED DOCUMENT · READ ONLY</span>
        {expiry && <span className="ws-vnext-share__expiry">Expires {expiry}</span>}
      </header>

      {/* Frozen paper — same styling as the editor canvas. */}
      <main className="ws-vnext-share__paper">
        <article className="ws-vnext-paper">
          {doc.documentType ? (
            <div className="ws-vnext-paper__eyebrow">{doc.documentType}</div>
          ) : null}
          <h1>{doc.docTitle}</h1>
          <hr className="ws-vnext-paper__rule" />

          {doc.sections && doc.sections.length > 0
            ? doc.sections.map((s, i) => (
                <section key={i}>
                  <h2>{s.title}</h2>
                  {renderBody(s.body)}
                </section>
              ))
            : renderBody(doc.body)}
        </article>
      </main>

      {/* Guest comment box — plain text, max 2000 chars. */}
      <section className="ws-vnext-share__guest-comment">
        <form className="ws-vnext-share__comment-box" onSubmit={handleSubmitComment}>
          <textarea
            value={comment}
            onChange={(e) => {
              const v = e.target.value.slice(0, MAX_COMMENT_CHARS);
              setComment(v);
              if (commentOk) setCommentOk(false);
              if (commentError) setCommentError(null);
            }}
            maxLength={MAX_COMMENT_CHARS}
            placeholder="Leave a comment for the document owner…"
            aria-label="Guest comment"
            disabled={submitting}
          />
          <div className="ws-vnext-share__comment-meta">
            <span className="ws-vnext-share__char-count">
              {comment.length}/{MAX_COMMENT_CHARS}
              {remaining <= 0 ? ' — limit reached' : ''}
            </span>
            <button
              type="submit"
              disabled={submitting || comment.trim().length === 0}
              style={{
                fontFamily: 'var(--capiro-type-family-sans)',
                fontSize: 13,
                fontWeight: 600,
                padding: '6px 14px',
                borderRadius: 6,
                border: '1px solid var(--ws-control-ring)',
                background: 'var(--ws-ink)',
                color: 'var(--ws-paper)',
                cursor: submitting || comment.trim().length === 0 ? 'not-allowed' : 'pointer',
                opacity: submitting || comment.trim().length === 0 ? 0.5 : 1,
              }}
            >
              {submitting ? 'Sending…' : 'Send comment'}
            </button>
          </div>

          {commentError ? (
            <div
              className="ws-vnext-share__char-count"
              style={{ color: 'var(--ws-muted)', marginTop: 8 }}
              role="alert"
            >
              {commentError}
            </div>
          ) : null}
          {commentOk ? (
            <div
              className="ws-vnext-share__char-count"
              style={{ color: 'var(--ws-muted)', marginTop: 8 }}
              role="status"
            >
              Comment sent. Thank you.
            </div>
          ) : null}
        </form>
      </section>

      <footer className="ws-vnext-share__sanitization-note">
        Public shares are read-only and content is sanitized before display.
        Comments are reviewed by the document owner before being published.
      </footer>
    </div>
  );
}

export default WorkspaceShareView;
