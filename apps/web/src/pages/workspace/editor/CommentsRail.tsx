/**
 * Comments rail (Phase 6) — ported from the prototype `CommentsRail` (asset_12),
 * wired to the engine comment hooks (useComments / useCreateComment /
 * useUpdateComment / useSuggestCommentEdit) and the identity resolver
 * (useTenantMembers → author name/initials by Clerk user id).
 *
 * Features parity with the prototype:
 *  - highlight-to-comment: a selection in the canvas pushes a *composing* draft
 *    comment here (carried in via `composing`/`onComposeSave`/`onComposeCancel`),
 *    with the quoted text + a section+offset anchor (see anchors.ts).
 *  - comment cards: anchor badge ("§ section · chars a–b"), author/role/when,
 *    threaded replies, Resolve (clears the .ws-hl highlight + marks resolved),
 *    and "Let Meri draft an edit" → a SuggestionCard (Approve applies the rewrite
 *    to the section body + resolves; Reject dismisses).
 *  - resolved comments collapse under a toggle.
 *
 * Anchors persist as { section, quote, start, end } on the engine comment's
 * `anchor` Json. `start/end` are character offsets WITHIN the section's plain
 * text, so the highlight can be recomputed on every render even though the live
 * DOM `.ws-hl` span is transient (re-anchor in anchors.ts).
 */
import { useEffect, useRef, useState } from 'react';
import { App as AntApp } from 'antd';
import { Ava, Icon } from '../kit.js';
import type { WsComment } from '../types.js';
import {
  useCreateComment,
  useSuggestCommentEdit,
  useTenantMembers,
  useUpdateComment,
  initials as initialsOf,
} from '../api.js';
import type { CommentAnchor } from './anchors.js';
import { clearHighlightFor } from './anchors.js';

/** The in-flight, not-yet-persisted comment created by a canvas selection. */
export interface ComposingComment {
  section: string;
  quote: string;
  start: number;
  end: number;
}

/** Shared approve/reject card for any Meri-proposed change (prototype parity). */
export function SuggestionCard({
  before,
  after,
  onApprove,
  onReject,
}: {
  before?: string;
  after: string;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div
      className="card"
      style={{
        padding: 11,
        boxShadow: 'none',
        background: 'var(--bg-surface-2)',
        marginTop: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 10.5,
          fontWeight: 700,
          color: 'var(--accent)',
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          marginBottom: 7,
        }}
      >
        <Icon name="Sparkles" size={12} />
        Meri suggests
      </div>
      {before && (
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--ink-3)',
            textDecoration: 'line-through',
            marginBottom: 4,
            lineHeight: 1.4,
          }}
        >
          {before}
        </div>
      )}
      <div style={{ fontSize: 12, color: 'var(--ink-1)', lineHeight: 1.45, marginBottom: 9 }}>
        {after}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn sm btn-accent" onClick={onApprove}>
          <Icon name="Check" size={12} />
          Approve
        </button>
        <button className="btn sm btn-ghost" style={{ color: 'var(--ink-2)' }} onClick={onReject}>
          <Icon name="X" size={12} />
          Reject
        </button>
      </div>
    </div>
  );
}

/** Resolved view-model the cards render (engine WsComment → display shape). */
interface CommentVM {
  id: string;
  authorId: string;
  author: string;
  initials: string;
  role: string;
  when: string;
  text: string;
  quote: string | null;
  anchor: CommentAnchor | null;
  resolved: boolean;
  replies: Array<{ author: string; initials: string; text: string; when: string }>;
}

function whenLabel(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function CommentsRail({
  documentId,
  comments,
  composing,
  selfClerkId,
  selfName,
  onComposeSave,
  onComposeCancel,
  onApplyEdit,
}: {
  documentId: string;
  comments: WsComment[];
  /** In-flight selection-driven comment (null when not composing). */
  composing: ComposingComment | null;
  /** The current user's Clerk id (matches a comment.authorId) for "you". */
  selfClerkId: string | null;
  selfName: string;
  /** Persist the composing comment's text (engine create). */
  onComposeSave: (text: string) => void;
  onComposeCancel: () => void;
  /**
   * Apply an approved Meri rewrite to the document. Receives the comment's
   * anchor + the rewritten text; the editor splices it into the section body.
   */
  onApplyEdit: (anchor: CommentAnchor, after: string) => void;
}) {
  const { message } = AntApp.useApp();
  const { data: members } = useTenantMembers();
  const createComment = useCreateComment(documentId);
  const updateComment = useUpdateComment(documentId);
  const suggest = useSuggestCommentEdit(documentId);

  const [replies, setReplies] = useState<Record<string, string>>({});
  const [showResolved, setShowResolved] = useState(false);
  // Per-comment local UI state for the Meri-draft flow.
  const [drafting, setDrafting] = useState<Record<string, boolean>>({});
  const [suggestions, setSuggestions] = useState<Record<string, string>>({});
  const composeRef = useRef<HTMLTextAreaElement>(null);

  const nameFor = (clerkId: string): { name: string; initials: string } => {
    if (selfClerkId && clerkId === selfClerkId) {
      return { name: selfName || 'You', initials: initialsOf(selfName || 'You') };
    }
    const m = members?.find((x) => x.clerkUserId === clerkId);
    if (m) return { name: m.name, initials: m.initials };
    return { name: 'Teammate', initials: '··' };
  };

  const toVM = (c: WsComment): CommentVM => {
    const who = nameFor(c.authorId);
    return {
      id: c.id,
      authorId: c.authorId,
      author: who.name,
      initials: who.initials,
      role: c.role,
      when: whenLabel(c.createdAt),
      text: c.body,
      quote: c.quote,
      anchor: (c.anchor as CommentAnchor | null) ?? null,
      resolved: c.resolved,
      replies: (c.replies ?? []).map((r) => {
        const w = nameFor(r.authorId);
        return { author: w.name, initials: w.initials, text: r.body, when: whenLabel(r.createdAt) };
      }),
    };
  };

  const all = comments.map(toVM);
  const open = all.filter((c) => !c.resolved);
  const resolved = all.filter((c) => c.resolved);

  // Focus the compose box when a selection opens a new composing comment.
  useEffect(() => {
    if (composing && composeRef.current) composeRef.current.focus();
  }, [composing]);

  const addReply = (id: string) => {
    const v = (replies[id] || '').trim();
    if (!v) return;
    createComment.mutate(
      { body: v, parentId: id },
      {
        onSuccess: () => setReplies((r) => ({ ...r, [id]: '' })),
        onError: () => message.error('Could not post reply'),
      },
    );
  };

  // Resolve: clear the live .ws-hl highlight for this anchor, then mark resolved.
  const resolveComment = (c: CommentVM) => {
    if (c.anchor) clearHighlightFor(c.anchor);
    updateComment.mutate(
      { commentId: c.id, body: { resolved: true } },
      {
        onSuccess: () => message.success('Comment resolved'),
        onError: () => message.error('Could not resolve comment'),
      },
    );
  };

  const draftEdit = (c: CommentVM) => {
    setDrafting((d) => ({ ...d, [c.id]: true }));
    suggest.mutate(c.id, {
      onSuccess: (r) => {
        if (!r.after || !r.after.trim()) {
          setDrafting((d) => ({ ...d, [c.id]: false }));
          message.info('Meri did not return an edit. Try again.');
          return;
        }
        setSuggestions((s) => ({ ...s, [c.id]: r.after }));
      },
      onError: (e: unknown) => {
        setDrafting((d) => ({ ...d, [c.id]: false }));
        const msg =
          (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          'Meri could not draft an edit';
        message.error(msg);
      },
    });
  };

  const approveEdit = (c: CommentVM) => {
    const after = suggestions[c.id];
    if (after && c.anchor) onApplyEdit(c.anchor, after);
    setDrafting((d) => ({ ...d, [c.id]: false }));
    setSuggestions((s) => {
      const n = { ...s };
      delete n[c.id];
      return n;
    });
    resolveComment(c);
  };

  const rejectEdit = (id: string) => {
    setDrafting((d) => ({ ...d, [id]: false }));
    setSuggestions((s) => {
      const n = { ...s };
      delete n[id];
      return n;
    });
  };

  const AnchorBadge = ({ c }: { c: CommentVM }) => {
    if (!c.anchor?.section) return null;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
        <Icon name="MapPin" size={10} style={{ color: 'var(--ink-4)', flex: 'none' }} />
        <span style={{ fontSize: 10, color: 'var(--ink-4)', fontFamily: 'var(--font-mono)' }}>
          § {c.anchor.section}
        </span>
        {c.anchor.start != null && (
          <span style={{ fontSize: 10, color: 'var(--ink-4)', fontFamily: 'var(--font-mono)' }}>
            · chars {c.anchor.start}–{c.anchor.end}
          </span>
        )}
      </div>
    );
  };

  const CommentCard = ({ c, dimmed }: { c: CommentVM; dimmed: boolean }) => {
    const quote = c.quote || c.anchor?.quote || null;
    const isDrafting = !!drafting[c.id];
    const suggested = suggestions[c.id];
    return (
      <div
        className="card"
        style={{
          padding: 12,
          boxShadow: 'none',
          border: '1px solid var(--border-1)',
          opacity: dimmed ? 0.62 : 1,
        }}
      >
        <AnchorBadge c={c} />
        {quote && (
          <div
            style={{
              borderLeft: '3px solid var(--notable)',
              background: 'rgba(212,160,23,.1)',
              padding: '5px 9px',
              borderRadius: '0 5px 5px 0',
              fontSize: 11,
              color: 'var(--ink-2)',
              marginBottom: 9,
              lineHeight: 1.4,
              fontStyle: 'italic',
            }}
          >
            &quot;{quote.length > 90 ? quote.slice(0, 90) + '…' : quote}&quot;
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
          <Ava x={c.initials} size={22} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>{c.author}</div>
            <div style={{ fontSize: 10, color: 'var(--ink-3)' }}>
              {c.role} · {c.when}
            </div>
          </div>
          {dimmed && (
            <span className="pill muted" style={{ fontSize: 10 }}>
              Resolved
            </span>
          )}
        </div>

        <div style={{ fontSize: 12.5, color: 'var(--ink-1)', lineHeight: 1.45, marginBottom: 9 }}>
          {c.text}
        </div>

        {c.replies.length > 0 && (
          <div
            style={{
              borderLeft: '1px solid var(--border-1)',
              paddingLeft: 9,
              margin: '0 0 9px 4px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {c.replies.map((rp, j) => (
              <div key={j}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 2 }}>
                  <Ava x={rp.initials} size={17} />
                  <span style={{ fontSize: 11.5, fontWeight: 600 }}>{rp.author}</span>
                  <span style={{ fontSize: 10, color: 'var(--ink-3)' }}>{rp.when}</span>
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--ink-1)',
                    lineHeight: 1.4,
                    paddingLeft: 24,
                  }}
                >
                  {rp.text}
                </div>
              </div>
            ))}
          </div>
        )}

        {!dimmed && quote && !isDrafting && (
          <button
            className="btn sm btn-ghost"
            style={{ color: 'var(--accent)', marginBottom: 4 }}
            onClick={() => draftEdit(c)}
          >
            <Icon name="Sparkles" size={12} />
            Let Meri draft an edit
          </button>
        )}
        {!dimmed &&
          isDrafting &&
          (suggested ? (
            <SuggestionCard
              before={quote ?? undefined}
              after={suggested}
              onApprove={() => approveEdit(c)}
              onReject={() => rejectEdit(c.id)}
            />
          ) : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                marginTop: 6,
                fontSize: 11.5,
                color: 'var(--accent)',
              }}
            >
              <Icon name="Loader" size={12} />
              Meri is drafting an edit…
            </div>
          ))}

        {!dimmed && (
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <input
              value={replies[c.id] || ''}
              onChange={(e) => setReplies((r) => ({ ...r, [c.id]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addReply(c.id);
              }}
              placeholder="Reply…"
              className="field"
              style={{
                flex: 1,
                padding: '6px 10px',
                fontSize: 12,
                fontFamily: 'var(--font-sans)',
                background: 'var(--bg-surface)',
              }}
            />
            <button
              className="btn sm btn-ghost"
              style={{ color: 'var(--ink-2)' }}
              onClick={() => resolveComment(c)}
              title="Resolve"
            >
              <Icon name="Check" size={13} />
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--border-1)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flex: 'none',
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>Comments</span>
        <span className="pill muted">{open.length} open</span>
        {resolved.length > 0 && (
          <button
            onClick={() => setShowResolved((s) => !s)}
            style={{
              border: 'none',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 600,
              padding: '2px 7px',
              borderRadius: 5,
              background: showResolved ? 'var(--accent-soft)' : 'transparent',
              color: showResolved ? 'var(--accent)' : 'var(--ink-3)',
              fontFamily: 'var(--font-sans)',
            }}
          >
            {resolved.length} resolved
          </button>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>any role</span>
      </div>

      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 11,
        }}
      >
        {/* Composing card driven by a live canvas selection. */}
        {composing && (
          <div
            className="card"
            style={{ padding: 12, boxShadow: 'none', border: '1px solid var(--accent)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
              <Icon name="MapPin" size={10} style={{ color: 'var(--ink-4)', flex: 'none' }} />
              <span style={{ fontSize: 10, color: 'var(--ink-4)', fontFamily: 'var(--font-mono)' }}>
                § {composing.section} · chars {composing.start}–{composing.end}
              </span>
            </div>
            <div
              style={{
                borderLeft: '3px solid var(--notable)',
                background: 'rgba(212,160,23,.1)',
                padding: '5px 9px',
                borderRadius: '0 5px 5px 0',
                fontSize: 11,
                color: 'var(--ink-2)',
                marginBottom: 9,
                lineHeight: 1.4,
                fontStyle: 'italic',
              }}
            >
              &quot;
              {composing.quote.length > 90 ? composing.quote.slice(0, 90) + '…' : composing.quote}
              &quot;
            </div>
            <textarea
              ref={composeRef}
              defaultValue=""
              placeholder="Comment on the highlighted text…"
              rows={2}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onComposeSave((e.target as HTMLTextAreaElement).value);
                }
              }}
              className="field"
              style={{
                width: '100%',
                padding: '7px 10px',
                fontSize: 12.5,
                fontFamily: 'var(--font-sans)',
                background: 'var(--bg-surface)',
                resize: 'vertical',
              }}
            />
            <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
              <button
                className="btn sm btn-accent"
                onClick={(e) => {
                  const ta = (e.currentTarget.closest('.card') as HTMLElement)?.querySelector(
                    'textarea',
                  );
                  onComposeSave((ta as HTMLTextAreaElement)?.value ?? '');
                }}
              >
                Comment
              </button>
              <button
                className="btn sm btn-ghost"
                style={{ color: 'var(--ink-2)' }}
                onClick={onComposeCancel}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {open.length === 0 && !composing && !showResolved && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--ink-3)',
              textAlign: 'center',
              padding: '20px 0',
              lineHeight: 1.5,
            }}
          >
            No open comments.
            <br />
            Highlight text in the document to start one.
          </div>
        )}
        {open.map((c) => (
          <CommentCard key={c.id} c={c} dimmed={false} />
        ))}

        {showResolved && resolved.length > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <span style={{ flex: 1, height: 1, background: 'var(--border-1)' }} />
              <span
                style={{
                  fontSize: 10.5,
                  color: 'var(--ink-3)',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                {resolved.length} resolved
              </span>
              <span style={{ flex: 1, height: 1, background: 'var(--border-1)' }} />
            </div>
            {resolved.map((c) => (
              <CommentCard key={c.id} c={c} dimmed={true} />
            ))}
          </>
        )}
      </div>

      <div
        style={{
          padding: 12,
          borderTop: '1px solid var(--border-1)',
          fontSize: 11,
          color: 'var(--ink-3)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          justifyContent: 'center',
          flex: 'none',
        }}
      >
        <Icon name="MousePointerClick" size={12} />
        Highlight text in the document to comment
      </div>
    </div>
  );
}
