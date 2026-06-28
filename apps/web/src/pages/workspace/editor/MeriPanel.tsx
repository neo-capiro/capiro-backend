/**
 * Right rail — Meri | Comments (ported from the prototype `MeriPanel`,
 * asset_14).
 *
 * Meri tab: a document-scoped chat assistant. You prompt Meri to act across the
 * whole document; it has the setup + Context Builder context plus read-only
 * access to firm/client + congressional data, and proposes edits you preview and
 * Accept/Reject before they apply. Wired to onRunMeri (POST /api/workspace/
 * assistant) and onApplyEdits (applies accepted edits to the section model).
 *
 * Comments tab (Phase 6): the full CommentsRail — highlight-to-comment compose,
 * threaded replies, resolve (clears the highlight), and "Let Meri draft an edit".
 * The editor controls the tab via `activeTab`/`onTabChange` so a canvas
 * selection can auto-switch the rail to Comments.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../kit.js';
import type { WsComment } from '../types.js';
import type { WsAssistantEdit, WsAssistantResult } from '../api.js';
import { CommentsRail, type ComposingComment } from './CommentsRail.js';
import type { CommentAnchor } from './anchors.js';

const QUICK_ACTIONS: Array<{ label: string; prompt: string }> = [
  {
    label: 'Tighten the ask',
    prompt:
      'Tighten the ask across this document — make the request specific, quantified, and action-oriented. Propose section edits.',
  },
  {
    label: 'Expand acronyms',
    prompt:
      'Find undefined acronyms throughout the document and expand each on first use, e.g. "NDAA (National Defense Authorization Act)". Propose section edits.',
  },
  {
    label: 'Strengthen the nexus',
    prompt:
      'Strengthen the connection between the client and the relevant policy/program throughout — make the relevance explicit and evidence-backed. Propose section edits.',
  },
];

interface ChatItem {
  role: 'user' | 'meri';
  text: string;
  edits?: WsAssistantEdit[];
  editsState?: 'pending' | 'applied' | 'dismissed';
}

const opLabel: Record<WsAssistantEdit['op'], string> = {
  replace_section: 'Rewrite',
  insert_section: 'Add section',
  remove_section: 'Remove section',
};

function plainPreview(html: string | undefined, max = 220): string {
  if (!html) return '';
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A proposed-edits card with per-edit Reject + Apply / Dismiss (preview → accept). */
function EditProposal({
  edits,
  state,
  onApply,
  onDismiss,
}: {
  edits: WsAssistantEdit[];
  state: ChatItem['editsState'];
  onApply: (kept: WsAssistantEdit[]) => void;
  onDismiss: () => void;
}) {
  const [rejected, setRejected] = useState<Set<number>>(new Set());
  if (state === 'applied') {
    return (
      <div style={{ fontSize: 11, color: 'var(--accent-ink, #1e3a8a)', marginTop: 6 }}>
        <Icon name="Check" size={11} /> Applied to the document
      </div>
    );
  }
  if (state === 'dismissed') {
    return (
      <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 6 }}>Suggestion dismissed</div>
    );
  }
  const kept = edits.filter((_, i) => !rejected.has(i));
  const toggle = (i: number) =>
    setRejected((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  return (
    <div
      style={{
        marginTop: 8,
        border: '1px solid var(--border-1)',
        borderRadius: 9,
        background: 'var(--bg-surface)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '7px 11px',
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--ink-2)',
          background: 'var(--accent-soft)',
          borderBottom: '1px solid var(--border-1)',
        }}
      >
        Proposed edits · {edits.length}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {edits.map((e, i) => {
          const off = rejected.has(i);
          const target = e.op === 'insert_section' ? e.name : e.section;
          return (
            <div
              key={i}
              style={{
                padding: '8px 11px',
                borderBottom: '1px solid var(--border-1)',
                opacity: off ? 0.45 : 1,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    fontSize: 9.5,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.03em',
                    color: e.op === 'remove_section' ? 'var(--danger, #b91c1c)' : 'var(--accent)',
                  }}
                >
                  {opLabel[e.op]}
                </span>
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 600,
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    textDecoration: off ? 'line-through' : 'none',
                  }}
                >
                  {target ?? '(section)'}
                </span>
                <button
                  className="btn sm btn-ghost"
                  style={{ fontSize: 10.5, padding: '1px 7px', color: 'var(--ink-3)' }}
                  onClick={() => toggle(i)}
                >
                  {off ? 'Restore' : 'Reject'}
                </button>
              </div>
              {e.note && (
                <div style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 3 }}>{e.note}</div>
              )}
              {e.op !== 'remove_section' && e.content && (
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--ink-2)',
                    marginTop: 4,
                    lineHeight: 1.45,
                    maxHeight: 84,
                    overflow: 'hidden',
                  }}
                >
                  {plainPreview(e.content)}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 7, padding: '8px 11px' }}>
        <button
          className="btn sm btn-accent"
          disabled={!kept.length}
          onClick={() => onApply(kept)}
          style={{ fontSize: 11 }}
        >
          <Icon name="Check" size={12} />
          Apply {kept.length} edit{kept.length === 1 ? '' : 's'}
        </button>
        <button className="btn sm" onClick={onDismiss} style={{ fontSize: 11 }}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function MeriPanel({
  isMainDoc,
  contextItems,
  openComments,
  activeTab,
  onTabChange,
  documentId,
  comments,
  composing,
  selfClerkId,
  selfName,
  onComposeSave,
  onComposeCancel,
  onApplyEdit,
  onRunMeri,
  onApplyEdits,
  onEditContext,
  pendingPrompt,
  onPromptConsumed,
}: {
  isMainDoc: boolean;
  /** Labels of the context items Meri uses (the real Context Builder plan). */
  contextItems: string[];
  openComments: number;
  /** Editor-controlled active rail tab (so a selection can switch to Comments). */
  activeTab: 'meri' | 'comments';
  onTabChange: (tab: 'meri' | 'comments') => void;
  /** The active canvas document id (engine comment scope). */
  documentId: string | null;
  comments: WsComment[];
  composing: ComposingComment | null;
  selfClerkId: string | null;
  selfName: string;
  onComposeSave: (text: string) => void;
  onComposeCancel: () => void;
  onApplyEdit: (anchor: CommentAnchor, after: string) => void;
  /** Run one assistant turn; resolves to Meri's reply + proposed edits. */
  onRunMeri: (
    messages: Array<{ role: 'user' | 'assistant'; text: string }>,
  ) => Promise<WsAssistantResult>;
  /** Apply accepted edits to the document (section model + autosave). */
  onApplyEdits: (edits: WsAssistantEdit[]) => void;
  onEditContext: () => void;
  /** A prompt to auto-send (e.g. a checks "Fix" → "Expand acronyms"). */
  pendingPrompt?: string | null;
  /** Called once the pending prompt has been consumed. */
  onPromptConsumed?: () => void;
}) {
  const tab = activeTab;
  const setTab = onTabChange;
  const [input, setInput] = useState('');
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [items, busy]);

  const send = async (text: string) => {
    const v = text.trim();
    if (!v || busy) return;
    setInput('');
    const nextItems: ChatItem[] = [...items, { role: 'user', text: v }];
    setItems(nextItems);
    setBusy(true);
    try {
      const history = nextItems.map((it) => ({
        role: (it.role === 'meri' ? 'assistant' : 'user') as 'user' | 'assistant',
        text: it.text,
      }));
      const res = await onRunMeri(history);
      setItems((prev) => [
        ...prev,
        {
          role: 'meri',
          text: res.reply || 'Done.',
          edits: res.edits?.length ? res.edits : undefined,
          editsState: res.edits?.length ? 'pending' : undefined,
        },
      ]);
    } catch {
      setItems((prev) => [
        ...prev,
        { role: 'meri', text: 'Sorry — something went wrong. Please try again.' },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const setEditsState = (idx: number, editsState: ChatItem['editsState']) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, editsState } : it)));

  // A checks "Fix" (or other caller) can hand Meri a prompt to run immediately.
  // Consume it once; `send` no-ops while busy so a rapid double won't double-fire.
  useEffect(() => {
    if (!pendingPrompt) return;
    void send(pendingPrompt);
    onPromptConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPrompt]);

  const Tab = ({ k, label, badge }: { k: 'meri' | 'comments'; label: string; badge?: number }) => {
    const on = tab === k;
    return (
      <button
        onClick={() => setTab(k)}
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 7,
          padding: '10px 8px',
          border: 'none',
          background: 'transparent',
          borderBottom: on ? '2px solid var(--accent)' : '2px solid transparent',
          color: on ? 'var(--ink-1)' : 'var(--ink-3)',
          fontWeight: 600,
          fontSize: 12.5,
          cursor: 'pointer',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {label}
        {badge != null && (
          <span
            className="num"
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              padding: '1px 6px',
              borderRadius: 10,
              background: on ? 'var(--accent)' : 'var(--bg-sunken)',
              color: on ? '#fff' : 'var(--ink-3)',
            }}
          >
            {badge}
          </span>
        )}
      </button>
    );
  };

  return (
    <div
      style={{
        borderLeft: '1px solid var(--border-1)',
        background: 'var(--bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minHeight: 0,
      }}
    >
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-1)', flex: 'none' }}>
        <Tab k="meri" label="Meri" />
        <Tab k="comments" label="Comments" badge={openComments} />
      </div>

      {tab === 'comments' ? (
        documentId ? (
          <CommentsRail
            documentId={documentId}
            comments={comments}
            composing={composing}
            selfClerkId={selfClerkId}
            selfName={selfName}
            onComposeSave={onComposeSave}
            onComposeCancel={onComposeCancel}
            onApplyEdit={onApplyEdit}
          />
        ) : (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: 24,
              textAlign: 'center',
              color: 'var(--ink-3)',
            }}
          >
            <Icon name="MessageSquare" size={22} style={{ color: 'var(--ink-4)' }} />
            <div style={{ fontSize: 12, lineHeight: 1.5, maxWidth: 220 }}>
              Comments attach to a saved document. Add content first.
            </div>
          </div>
        )
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            flex: 1,
            minHeight: 0,
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '12px 16px',
              borderBottom: '1px solid var(--border-1)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flex: 'none',
              background: 'linear-gradient(180deg, var(--accent-soft), var(--bg-surface))',
            }}
          >
            <span
              style={{
                width: 26,
                height: 26,
                borderRadius: '50%',
                background: 'var(--accent)',
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
                flex: 'none',
              }}
            >
              <Icon name="Sparkles" size={15} />
            </span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Meri</div>
              <div style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>
                Editing this document · {contextItems.length} context source
                {contextItems.length === 1 ? '' : 's'}
              </div>
            </div>
          </div>

          {/* Conversation */}
          <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: 14, minHeight: 0 }}>
            {items.length === 0 && (
              <div
                className="card"
                style={{
                  padding: '10px 12px',
                  boxShadow: 'none',
                  fontSize: 12,
                  color: 'var(--ink-2)',
                  lineHeight: 1.5,
                }}
              >
                <b style={{ color: 'var(--accent)' }}>Meri:</b> I can edit this document with you —
                rewrite or tighten sections, expand acronyms, strengthen the ask. I use your setup
                and linked context, and can pull in firm and congressional data. Ask me anything, or
                try a quick action below.
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {items.map((it, idx) =>
                it.role === 'user' ? (
                  <div key={idx} style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <div
                      style={{
                        maxWidth: '85%',
                        background: 'var(--accent)',
                        color: '#fff',
                        fontSize: 12,
                        lineHeight: 1.5,
                        padding: '8px 11px',
                        borderRadius: '10px 10px 2px 10px',
                      }}
                    >
                      {it.text}
                    </div>
                  </div>
                ) : (
                  <div key={idx}>
                    <div
                      style={{
                        fontSize: 12,
                        lineHeight: 1.55,
                        color: 'var(--ink-1)',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      <b style={{ color: 'var(--accent)' }}>Meri:</b> {it.text}
                    </div>
                    {it.edits && it.edits.length > 0 && (
                      <EditProposal
                        edits={it.edits}
                        state={it.editsState}
                        onApply={(kept) => {
                          onApplyEdits(kept);
                          setEditsState(idx, 'applied');
                        }}
                        onDismiss={() => setEditsState(idx, 'dismissed')}
                      />
                    )}
                  </div>
                ),
              )}
              {busy && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    fontSize: 12,
                    color: 'var(--ink-3)',
                  }}
                >
                  <b style={{ color: 'var(--accent)' }}>Meri</b> is working
                  <span className="ws-typing" aria-label="Meri is working">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Composer */}
          <div style={{ padding: 12, borderTop: '1px solid var(--border-1)', flex: 'none' }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {QUICK_ACTIONS.map((q) => (
                <button
                  key={q.label}
                  className="btn sm"
                  disabled={busy}
                  style={{
                    fontSize: 11,
                    padding: '3px 9px',
                    borderColor: 'var(--border-1)',
                    color: 'var(--ink-2)',
                  }}
                  onClick={() => send(q.prompt)}
                >
                  {q.label}
                </button>
              ))}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '9px 11px',
                background: 'var(--bg-surface)',
                border: '1.5px solid var(--accent)',
                borderRadius: 9,
                boxShadow: '0 0 0 3px var(--accent-glow)',
              }}
            >
              <Icon name="Sparkles" size={15} style={{ color: 'var(--accent)', flex: 'none' }} />
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                disabled={busy}
                placeholder="Ask Meri to edit this document…"
                style={{
                  flex: 1,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  fontSize: 12.5,
                  color: 'var(--ink-1)',
                  fontFamily: 'var(--font-sans)',
                }}
              />
              <button
                onClick={() => void send(input)}
                disabled={busy || !input.trim()}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  background: 'var(--accent)',
                  color: '#fff',
                  display: 'grid',
                  placeItems: 'center',
                  border: 'none',
                  cursor: busy ? 'wait' : 'pointer',
                  opacity: !input.trim() ? 0.5 : 1,
                  flex: 'none',
                }}
              >
                <Icon name="ArrowUp" size={14} />
              </button>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginTop: 8,
              }}
            >
              <span style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>
                Context Meri uses · {contextItems.length}
              </span>
              <a
                onClick={onEditContext}
                style={{
                  fontSize: 10.5,
                  color: 'var(--accent)',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Edit context
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
