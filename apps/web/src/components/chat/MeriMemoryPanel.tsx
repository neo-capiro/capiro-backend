import { useEffect, useState } from 'react';
import { BulbOutlined, DownOutlined } from '@ant-design/icons';

/**
 * A learned memory as the server reports it. Every governance field here is
 * server-owned: `canMutate` is the Phase 0 authorization decision
 * (evaluateMemoryMutation) and `state` distinguishes an active memory from one
 * still awaiting firm review. The browser never infers either.
 */
export interface MeriLearnedMemory {
  id: string;
  key: string;
  value: string;
  scope: string;
  clientId?: string | null;
  clientName?: string | null;
  /** explicit_save | candidate_review | auto_learned_legacy | imported | … */
  source?: string | null;
  state?: 'active' | 'pending_review' | string | null;
  confidence?: number | null;
  learnedAt?: string | null;
  confirmedAt?: string | null;
  expiresAt?: string | null;
  /** Phase 0 decision: may THIS user edit/forget this row? */
  canMutate?: boolean;
}

const SOURCE_LABELS: Record<string, string> = {
  explicit_save: 'You saved this',
  candidate_review: 'Meri suggested remembering',
  auto_learned_legacy: 'Learned automatically (legacy)',
  imported: 'Imported',
  user_correction: 'Correction awaiting review',
  workspace_artifact: 'Promoted from a document',
};

function scopeLabel(memory: MeriLearnedMemory): string {
  if (memory.scope === 'user_private') return 'Personal';
  if (memory.scope === 'client') {
    return memory.clientName ? `Client · ${memory.clientName}` : 'Client';
  }
  if (memory.scope === 'firm') return 'Firm';
  return memory.scope || 'Unscoped';
}

function dateLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Confidence is only meaningful for a model-scored save. An explicit human save
 * is unscored, and rendering a percentage against it would invent precision.
 */
function confidenceLabel(memory: MeriLearnedMemory): string | null {
  if (typeof memory.confidence !== 'number') return null;
  if (memory.source === 'explicit_save') return null;
  const pct = Math.round(Math.max(0, Math.min(1, memory.confidence)) * 100);
  return `${pct}% confidence`;
}

function expiryLabel(memory: MeriLearnedMemory): { text: string; expired: boolean } | null {
  const label = dateLabel(memory.expiresAt);
  if (!label || !memory.expiresAt) return null;
  const expired = new Date(memory.expiresAt).getTime() <= Date.now();
  return { text: expired ? `Expired ${label}` : `Expires ${label}`, expired };
}

export function MeriMemoryPanel({
  memories,
  forgotten,
  expanded,
  onExpandedChange,
  onSave,
  onForget,
  onUndo,
  onSuggestCorrection,
}: {
  memories: MeriLearnedMemory[];
  forgotten: MeriLearnedMemory[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onSave: (id: string, value: string) => void;
  onForget: (id: string) => void;
  onUndo: (id: string) => void;
  /** Present when a correction can be proposed for memory the user cannot edit. */
  onSuggestCorrection?: (id: string, value: string) => void | Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [suggestingId, setSuggestingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (editingId && !memories.some((memory) => memory.id === editingId)) setEditingId(null);
    if (suggestingId && !memories.some((memory) => memory.id === suggestingId)) {
      setSuggestingId(null);
    }
  }, [editingId, suggestingId, memories]);

  const startEdit = (memory: MeriLearnedMemory) => {
    setSuggestingId(null);
    setEditingId(memory.id);
    setDraft(memory.value);
  };
  const startSuggest = (memory: MeriLearnedMemory) => {
    setEditingId(null);
    setSuggestingId(memory.id);
    setDraft(memory.value);
  };
  const commit = () => {
    if (!editingId) return;
    const value = draft.trim();
    if (value) onSave(editingId, value);
    setEditingId(null);
  };
  const submitSuggestion = () => {
    if (!suggestingId) return;
    const value = draft.trim();
    if (value) void onSuggestCorrection?.(suggestingId, value);
    setSuggestingId(null);
  };

  if (memories.length === 0 && forgotten.length === 0) return null;

  const pendingCount = memories.filter((memory) => memory.state === 'pending_review').length;
  const activeCount = memories.length - pendingCount;

  return (
    <section className="meri-memory" aria-label="What Meri remembers">
      <button
        type="button"
        className={`meri-memory-header${expanded ? '' : ' is-collapsed'}`}
        onClick={() => onExpandedChange(!expanded)}
        aria-expanded={expanded}
      >
        <BulbOutlined aria-hidden="true" />
        {/* Never "Meri learned N things": a pending candidate has NOT been learned,
            and conflating the two is what let auto-learned guesses read as
            established firm knowledge. */}
        <span>
          {pendingCount > 0 && activeCount === 0
            ? 'Pending memory review'
            : pendingCount > 0
              ? 'Memory · review needed'
              : 'What Meri remembers'}
        </span>
        <span className="meri-memory-count">{memories.length}</span>
        <DownOutlined className="meri-memory-chevron" aria-hidden="true" />
      </button>
      {expanded && (
        <div className="meri-memory-list">
          {memories.map((memory) => {
            const pending = memory.state === 'pending_review';
            const expiry = expiryLabel(memory);
            const confidence = confidenceLabel(memory);
            const learned = dateLabel(memory.learnedAt);
            const confirmed = dateLabel(memory.confirmedAt);
            const sourceText =
              SOURCE_LABELS[memory.source ?? ''] ?? (memory.source ? memory.source : null);
            // The server decides. Absent (older payload) is treated as NOT mutable,
            // so the UI fails closed rather than offering an edit the API rejects.
            const mayMutate = memory.canMutate === true;
            const isEditing = editingId === memory.id;
            const isSuggesting = suggestingId === memory.id;
            return (
              <div className="meri-memory-item" key={memory.id}>
                <span className="meri-memory-spark" aria-hidden="true">
                  ✦
                </span>
                <div className="meri-memory-body">
                  {isEditing || isSuggesting ? (
                    <>
                      <input
                        autoFocus
                        className="meri-memory-edit"
                        value={draft}
                        aria-label={isSuggesting ? 'Suggest a corrected value' : 'Edit memory'}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            if (isSuggesting) submitSuggestion();
                            else commit();
                          }
                          if (event.key === 'Escape') {
                            setEditingId(null);
                            setSuggestingId(null);
                          }
                        }}
                      />
                      <div className="meri-memory-actions">
                        <button
                          type="button"
                          onClick={() => (isSuggesting ? submitSuggestion() : commit())}
                        >
                          {isSuggesting ? 'Send for review' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(null);
                            setSuggestingId(null);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                      {isSuggesting && (
                        <p className="meri-memory-note">
                          This goes to an administrator as a suggested correction. Nothing changes
                          until they approve it.
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="meri-memory-text" title={memory.value}>
                        {memory.value}
                      </span>
                      <div className="meri-memory-meta">
                        <span className="meri-memory-chip">{scopeLabel(memory)}</span>
                        {pending ? (
                          <span className="meri-memory-chip meri-memory-chip--pending">
                            Pending review
                          </span>
                        ) : (
                          <span className="meri-memory-chip meri-memory-chip--active">Active</span>
                        )}
                        {sourceText && <span className="meri-memory-chip">{sourceText}</span>}
                        {confidence && <span className="meri-memory-chip">{confidence}</span>}
                        {confirmed ? (
                          <span className="meri-memory-chip">Confirmed {confirmed}</span>
                        ) : (
                          learned && <span className="meri-memory-chip">Learned {learned}</span>
                        )}
                        {expiry && (
                          <span
                            className={`meri-memory-chip${expiry.expired ? ' meri-memory-chip--expired' : ''}`}
                          >
                            {expiry.text}
                          </span>
                        )}
                      </div>
                      <div className="meri-memory-actions">
                        {mayMutate ? (
                          <>
                            <button type="button" onClick={() => startEdit(memory)}>
                              Edit
                            </button>
                            <button type="button" onClick={() => onForget(memory.id)}>
                              Forget
                            </button>
                          </>
                        ) : onSuggestCorrection ? (
                          <button type="button" onClick={() => startSuggest(memory)}>
                            Suggest correction
                          </button>
                        ) : (
                          <span className="meri-memory-note">
                            Shared memory — an administrator maintains this.
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {memories.length === 0 && <p className="meri-memory-empty">No active memories.</p>}
        </div>
      )}
      {forgotten.map((memory) => (
        <div className="meri-memory-undo" role="status" key={memory.id}>
          <span>
            Forgot “{memory.value.length > 48 ? `${memory.value.slice(0, 45)}…` : memory.value}”
          </span>
          <button type="button" onClick={() => onUndo(memory.id)}>
            Undo
          </button>
        </div>
      ))}
    </section>
  );
}
