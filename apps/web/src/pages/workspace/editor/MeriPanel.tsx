/**
 * Right rail — Meri | Comments (ported from the prototype `MeriPanel`,
 * asset_14).
 *
 * Meri tab: contextual header message, "Ask Meri to edit this draft…" input
 * (wired to onAsk — a toast stub for now), quick-action chips (stubs), and the
 * "Context Meri uses" list (from cfg.linkedData) with Edit → the Context
 * Builder for this draft.
 *
 * Comments tab (Phase 6): the full CommentsRail — highlight-to-comment compose,
 * threaded replies, resolve (clears the highlight), and "Let Meri draft an edit".
 * The editor controls the tab via `activeTab`/`onTabChange` so a canvas
 * selection can auto-switch the rail to Comments.
 */
import { useState } from 'react';
import { Icon } from '../kit.js';
import type { WsComment } from '../types.js';
import { CommentsRail, type ComposingComment } from './CommentsRail.js';
import type { CommentAnchor } from './anchors.js';

const QUICK_ACTIONS = ['Tighten the ask', 'Expand acronyms', 'Stronger nexus'];

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
  onAsk,
  onQuickAction,
  onEditContext,
}: {
  isMainDoc: boolean;
  /** Labels of the context references Meri uses (cfg.linkedData). */
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
  onAsk: (text: string) => void;
  onQuickAction: (action: string) => void;
  onEditContext: () => void;
}) {
  const tab = activeTab;
  const setTab = onTabChange;
  const [input, setInput] = useState('');

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

  const submit = () => {
    const v = input.trim();
    if (!v) return;
    onAsk(v);
    setInput('');
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
          <div
            style={{
              padding: 16,
              borderBottom: '1px solid var(--border-1)',
              background: 'linear-gradient(180deg, var(--accent-soft), var(--bg-surface))',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
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
                  {isMainDoc ? 'Drafting assistant' : 'Ready to draft this document'}
                </div>
              </div>
            </div>
            <div
              className="card"
              style={{
                padding: '9px 11px',
                boxShadow: 'none',
                fontSize: 12,
                color: 'var(--ink-2)',
                lineHeight: 1.45,
                marginBottom: 10,
              }}
            >
              <b style={{ color: 'var(--accent)' }}>Meri:</b>{' '}
              {isMainDoc
                ? 'This draft has 9 undefined acronyms and the certification still needs sign-off. Want me to expand the acronyms?'
                : 'This document is blank. Tell me what to include and I’ll draft it using your context.'}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
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
                  if (e.key === 'Enter') submit();
                }}
                placeholder="Ask Meri to edit this draft…"
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
                onClick={submit}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  background: 'var(--accent)',
                  color: '#fff',
                  display: 'grid',
                  placeItems: 'center',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                <Icon name="ArrowUp" size={14} />
              </button>
            </div>
            {isMainDoc && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 9 }}>
                {QUICK_ACTIONS.map((q) => (
                  <button
                    key={q}
                    className="btn sm"
                    style={{
                      fontSize: 11,
                      padding: '3px 9px',
                      borderColor: 'var(--border-1)',
                      color: 'var(--ink-2)',
                    }}
                    onClick={() => onQuickAction(q)}
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div
            style={{
              padding: 16,
              overflow: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 13,
            }}
          >
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 7,
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-2)' }}>
                  Context Meri uses · {contextItems.length}
                </span>
                <a
                  onClick={onEditContext}
                  style={{
                    fontSize: 11,
                    color: 'var(--accent)',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Edit
                </a>
              </div>
              {contextItems.length === 0 ? (
                <div style={{ fontSize: 11.5, color: 'var(--ink-3)', lineHeight: 1.5 }}>
                  No context linked yet. Add sources in Build context so Meri drafts from your data.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {contextItems.map((c, i) => (
                    <div
                      key={c + i}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 9,
                        padding: '7px 10px',
                        border: '1px solid var(--border-1)',
                        borderRadius: 7,
                        background: 'var(--bg-surface-2)',
                      }}
                    >
                      <Icon
                        name="Database"
                        size={13}
                        style={{ color: 'var(--accent)', flex: 'none' }}
                      />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            fontSize: 11.5,
                            fontWeight: 500,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {c}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
