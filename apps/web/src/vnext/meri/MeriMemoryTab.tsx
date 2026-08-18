import { useEffect, useState } from 'react';
import type { MeriLearnedMemory } from '../../components/chat/MeriMemoryPanel.js';
import { MeriIcon } from './meri-icons.js';

/**
 * MeriMemoryTab — the v4 Memory panel (screen L), re-skinned from the
 * already-real components/chat/MeriMemoryPanel.tsx onto vnext tokens.
 *
 * Every field and mutation here is the same one the legacy drawer already
 * uses — scope, state, confidence, dates, canMutate, save/forget/undo/
 * suggest-correction — fetched automatically by useMeriChatController
 * regardless of which surface mounts it. This is a visual port, not new
 * integration.
 *
 * Scope note: the underlying fetch is `/api/clio/memory/recent?limit=5` (the
 * same one the legacy drawer's compact widget uses), not the fuller
 * `/api/clio/memory?limit=100` list a dedicated management tab could show —
 * because forget/save/undo look the memory up by id in this same 5-item
 * state, and pointing this tab at the bigger list would let it show rows
 * those mutations can't act on. A "recent 5" memory tab, kept in sync with
 * mutations, beats a "recent 100" tab where editing a row past the fifth
 * silently does nothing.
 */

const MONO = "var(--meri-font-mono, 'IBM Plex Mono', monospace)";

const SOURCE_LABELS: Record<string, string> = {
  explicit_save: 'You saved this',
  candidate_review: 'Meri suggested remembering',
  auto_learned_legacy: 'Learned automatically (legacy)',
  imported: 'Imported',
  user_correction: 'Correction awaiting review',
  workspace_artifact: 'Promoted from a document',
};

function scopeChip(memory: MeriLearnedMemory): { label: string; bg: string; fg: string } {
  if (memory.scope === 'user_private') return { label: 'PERSONAL', bg: '#F2F4F7', fg: '#344054' };
  if (memory.scope === 'client') {
    return {
      label: memory.clientName ? `CLIENT · ${memory.clientName.toUpperCase()}` : 'CLIENT',
      bg: '#F2F4F7',
      fg: '#344054',
    };
  }
  if (memory.scope === 'firm') return { label: 'FIRM', bg: '#F2F4F7', fg: '#344054' };
  return { label: (memory.scope || 'UNSCOPED').toUpperCase(), bg: '#F2F4F7', fg: '#344054' };
}

function dateLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

function confidenceLabel(memory: MeriLearnedMemory): string | null {
  if (typeof memory.confidence !== 'number') return null;
  if (memory.source === 'explicit_save') return null;
  const pct = Math.round(Math.max(0, Math.min(1, memory.confidence)) * 100);
  return `${pct}% CONFIDENCE`;
}

interface MeriMemoryTabProps {
  memories: MeriLearnedMemory[];
  forgotten: MeriLearnedMemory[];
  onSave: (id: string, value: string) => void | Promise<void>;
  onForget: (id: string) => void;
  onUndo: (id: string) => void;
  onSuggestCorrection: (id: string, value: string) => void | Promise<void>;
}

export function MeriMemoryTab({ memories, forgotten, onSave, onForget, onUndo, onSuggestCorrection }: MeriMemoryTabProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [suggestingId, setSuggestingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (editingId && !memories.some((memory) => memory.id === editingId)) setEditingId(null);
    if (suggestingId && !memories.some((memory) => memory.id === suggestingId)) setSuggestingId(null);
  }, [editingId, suggestingId, memories]);

  const pendingCount = memories.filter((memory) => memory.state === 'pending_review').length;

  // No outer padding here — the caller nests this inside a
  // .vnext-meri__rail-section, which already provides the rail's standard
  // 18px 20px 16px gutter. Padding here too would double it, the same way
  // the M1 Saved-Prompts/Workspaces class mismatch silently doubled/dropped
  // spacing.
  return (
    <div className="vnext-meri__rail-section-content">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            height: 24,
            padding: '0 9px',
            borderRadius: 6,
            background: '#F2F4F7',
            fontFamily: MONO,
            fontSize: 9,
            fontWeight: 500,
            letterSpacing: '.07em',
            color: '#344054',
          }}
        >
          {memories.length} MEMOR{memories.length === 1 ? 'Y' : 'IES'}
        </span>
        {pendingCount > 0 ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 24,
              padding: '0 9px',
              borderRadius: 6,
              background: '#FFFAEB',
              boxShadow: 'inset 0 0 0 1px #FEDF89',
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: 9999, background: '#F79009' }} />
            <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '.07em', color: '#B54708' }}>
              {pendingCount} PENDING REVIEW
            </span>
          </span>
        ) : null}
      </div>
      <div style={{ marginTop: 11, fontSize: 13, lineHeight: '20px', color: '#475467' }}>
        What Meri remembers, and who can see it. Nothing here was learned without an approval.
      </div>

      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 9 }}>
        {memories.map((memory) => {
          const pending = memory.state === 'pending_review';
          const chip = scopeChip(memory);
          const confidence = confidenceLabel(memory);
          const learned = dateLabel(memory.learnedAt);
          const confirmed = dateLabel(memory.confirmedAt);
          const sourceText = SOURCE_LABELS[memory.source ?? ''] ?? memory.source ?? null;
          const mayMutate = memory.canMutate === true;
          const isEditing = editingId === memory.id;
          const isSuggesting = suggestingId === memory.id;

          return (
            <div
              key={memory.id}
              style={{
                padding: '13px 14px',
                borderRadius: 10,
                background: '#ffffff',
                boxShadow: `0 0 0 1px ${pending ? '#FEDF89' : '#EAECF0'}, 0px 1px 2px rgba(16,24,40,.05)`,
              }}
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 7 }}>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    height: 20,
                    padding: '0 7px',
                    borderRadius: 5,
                    background: chip.bg,
                    fontFamily: MONO,
                    fontSize: 8.5,
                    fontWeight: 500,
                    letterSpacing: '.07em',
                    color: chip.fg,
                  }}
                >
                  {chip.label}
                </span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 20,
                    padding: '0 7px',
                    borderRadius: 5,
                    background: pending ? '#FFFAEB' : '#ECFDF3',
                  }}
                >
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: 9999,
                      background: pending ? '#F79009' : '#12B76A',
                    }}
                  />
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 8.5,
                      fontWeight: 500,
                      letterSpacing: '.07em',
                      color: pending ? '#B54708' : '#027A48',
                    }}
                  >
                    {pending ? 'PENDING REVIEW' : 'ACTIVE'}
                  </span>
                </span>
                <span style={{ flex: 1 }} />
                {confidence ? (
                  <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 500, letterSpacing: '.07em', color: '#98A2B3' }}>
                    {confidence}
                  </span>
                ) : null}
              </div>

              {isEditing || isSuggesting ? (
                <div
                  style={{
                    marginTop: 11,
                    padding: '11px 12px',
                    borderRadius: 9,
                    background: '#F9FAFB',
                    boxShadow: 'inset 0 0 0 1px #EAECF0',
                  }}
                >
                  <textarea
                    autoFocus
                    value={draft}
                    aria-label={isSuggesting ? 'Suggest a corrected value' : 'Edit memory'}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        setEditingId(null);
                        setSuggestingId(null);
                      }
                    }}
                    style={{
                      width: '100%',
                      minHeight: 54,
                      padding: '9px 10px',
                      border: 0,
                      outline: 'none',
                      borderRadius: 7,
                      background: '#ffffff',
                      boxShadow: 'inset 0 0 0 1px #D0D5DD',
                      fontSize: 12.5,
                      lineHeight: '19px',
                      color: '#101828',
                      fontFamily: 'inherit',
                    }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9 }}>
                    <span
                      style={{
                        flex: 1,
                        fontFamily: MONO,
                        fontSize: 8.5,
                        fontWeight: 500,
                        letterSpacing: '.07em',
                        color: '#98A2B3',
                      }}
                    >
                      {isSuggesting
                        ? 'GOES TO AN ADMINISTRATOR FOR REVIEW · NOTHING CHANGES UNTIL APPROVED'
                        : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(null);
                        setSuggestingId(null);
                      }}
                      style={{
                        height: 28,
                        padding: '0 10px',
                        borderRadius: 7,
                        border: 0,
                        background: '#ffffff',
                        boxShadow: 'inset 0 0 0 1px #D0D5DD',
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: '#344054',
                        cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const value = draft.trim();
                        if (!value) return;
                        if (isSuggesting) void onSuggestCorrection(memory.id, value);
                        else void onSave(memory.id, value);
                        setEditingId(null);
                        setSuggestingId(null);
                      }}
                      style={{
                        height: 28,
                        padding: '0 11px',
                        borderRadius: 7,
                        border: 0,
                        backgroundImage: 'var(--m-metal-bg)',
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: '#ffffff',
                        cursor: 'pointer',
                      }}
                    >
                      {isSuggesting ? 'Send for review' : 'Save'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ marginTop: 9, fontSize: 13, lineHeight: '20px', color: '#101828' }}>
                    {memory.value}
                  </div>
                  {sourceText ? (
                    <div style={{ marginTop: 9, fontSize: 12, lineHeight: '18px', color: '#667085' }}>
                      {sourceText}
                    </div>
                  ) : null}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', marginTop: 8 }}>
                    {confirmed ? (
                      <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 500, letterSpacing: '.07em', color: '#98A2B3' }}>
                        CONFIRMED {confirmed.toUpperCase()}
                      </span>
                    ) : learned ? (
                      <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 500, letterSpacing: '.07em', color: '#98A2B3' }}>
                        LEARNED {learned.toUpperCase()}
                      </span>
                    ) : null}
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      gap: 7,
                      marginTop: 12,
                      paddingTop: 11,
                      borderTop: '1px solid #F2F4F7',
                    }}
                  >
                    {mayMutate ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setSuggestingId(null);
                            setEditingId(memory.id);
                            setDraft(memory.value);
                          }}
                          style={{
                            height: 28,
                            padding: '0 10px',
                            borderRadius: 7,
                            border: 0,
                            background: '#ffffff',
                            boxShadow: 'inset 0 0 0 1px #D0D5DD',
                            fontSize: 12.5,
                            fontWeight: 600,
                            color: '#344054',
                            cursor: 'pointer',
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => onForget(memory.id)}
                          style={{
                            height: 28,
                            padding: '0 10px',
                            borderRadius: 7,
                            border: 0,
                            background: '#ffffff',
                            boxShadow: 'inset 0 0 0 1px #FECDCA',
                            fontSize: 12.5,
                            fontWeight: 600,
                            color: '#B42318',
                            cursor: 'pointer',
                          }}
                        >
                          Forget
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(null);
                            setSuggestingId(memory.id);
                            setDraft(memory.value);
                          }}
                          style={{
                            height: 28,
                            padding: '0 10px',
                            borderRadius: 7,
                            border: 0,
                            background: '#ffffff',
                            boxShadow: 'inset 0 0 0 1px #D0D5DD',
                            fontSize: 12.5,
                            fontWeight: 600,
                            color: '#344054',
                            cursor: 'pointer',
                          }}
                        >
                          Suggest a correction
                        </button>
                        <span style={{ fontSize: 11.5, lineHeight: '16px', color: '#667085' }}>
                          An administrator must approve firm-scope changes.
                        </span>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
        {memories.length === 0 ? (
          <div
            style={{
              padding: '20px 14px',
              borderRadius: 10,
              background: '#F9FAFB',
              boxShadow: 'inset 0 0 0 1px #EAECF0',
              fontSize: 13,
              lineHeight: '19px',
              color: '#475467',
            }}
          >
            No memories yet. Meri proposes what it learns for your approval — nothing is remembered
            silently.
          </div>
        ) : null}
      </div>

      {forgotten.length > 0 ? (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {forgotten.map((memory) => (
            <div
              key={memory.id}
              role="status"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 8,
                background: '#F9FAFB',
                boxShadow: 'inset 0 0 0 1px #EAECF0',
              }}
            >
              <MeriIcon name="Trash01" size={13} color="#667085" />
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: '18px', color: '#475467' }}>
                Forgot &ldquo;{memory.value.length > 48 ? `${memory.value.slice(0, 45)}…` : memory.value}&rdquo;
              </span>
              <button
                type="button"
                onClick={() => onUndo(memory.id)}
                style={{
                  flex: '0 0 auto',
                  height: 26,
                  padding: '0 10px',
                  borderRadius: 6,
                  border: 0,
                  background: '#ffffff',
                  boxShadow: 'inset 0 0 0 1px #D0D5DD',
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#344054',
                  cursor: 'pointer',
                }}
              >
                Undo
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
