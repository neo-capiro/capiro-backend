/**
 * Editor toolbar (sub-header) — ported from the prototype `EditorToolbar`
 * (asset_07). Title + autosave indicator, Custom-letterhead pill, Anonymize
 * toggle, Version history, collaborator stack, Share, Preview & Save.
 *
 * Phase 6b: the Version-history popover is wired (the parent toggles it; this
 * just dispatches onHistory). View-only mode (someone else holds the edit lock)
 * disables the mutating actions (Anonymize) while leaving read actions (Version
 * history / Share / Preview) available.
 */
import type { WsLetterhead } from '../types.js';
import { AvaStack, Icon } from '../kit.js';

export type SaveStatus = 'saved' | 'saving';

export function EditorToolbar({
  title,
  saveStatus,
  anonymize,
  letterhead,
  historyOpen,
  viewOnly,
  collaborators,
  onAnonymize,
  onHistory,
  onShare,
  onPreview,
  onRegenerateAll,
  regenerating,
}: {
  title: string;
  saveStatus: SaveStatus;
  anonymize: boolean;
  letterhead?: WsLetterhead;
  historyOpen?: boolean;
  /** Someone else holds the edit lock — disable mutating actions. */
  viewOnly?: boolean;
  /** Real collaborator initials (E-17) — empty/undefined hides the stack. */
  collaborators?: string[];
  onAnonymize: () => void;
  onHistory: () => void;
  onShare: () => void;
  onPreview: () => void;
  /** Regenerate the entire document with Meri (main doc only). */
  onRegenerateAll?: () => void;
  regenerating?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '10px 30px',
        borderBottom: '1px solid var(--border-1)',
        background: 'var(--bg-surface)',
        flex: 'none',
      }}
    >
      <div style={{ minWidth: 0, maxWidth: 360, flex: '0 1 auto' }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: 14,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </div>
        <div
          className="num"
          style={{
            fontSize: 11,
            color: 'var(--ink-3)',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          {saveStatus === 'saving' ? (
            <>
              <Icon name="RefreshCw" size={10} style={{ opacity: 0.5 }} />
              Saving…
            </>
          ) : (
            <>
              <Icon name="Check" size={10} style={{ color: 'var(--success)' }} />
              Saved · just now
            </>
          )}
        </div>
      </div>
      {letterhead?.custom && (
        <span className="pill info" style={{ marginLeft: 4 }}>
          Custom letterhead
        </span>
      )}
      <div style={{ flex: 1 }} />
      <button
        className="btn sm btn-ghost"
        onClick={onAnonymize}
        disabled={viewOnly}
        title="Remove direct client & product names Meri identifies"
        style={{
          color: anonymize ? 'var(--accent)' : 'var(--ink-2)',
          background: anonymize ? 'var(--accent-soft)' : 'transparent',
          opacity: viewOnly ? 0.5 : 1,
        }}
      >
        <Icon name={anonymize ? 'EyeOff' : 'Eye'} size={14} />
        {anonymize ? 'Anonymized' : 'Anonymize'}
      </button>
      <button
        className="btn sm btn-ghost"
        style={{
          color: 'var(--ink-2)',
          background: historyOpen ? 'var(--bg-sunken)' : 'transparent',
        }}
        onClick={onHistory}
      >
        <Icon name="History" size={14} />
        Version history
      </button>
      {onRegenerateAll && (
        <button
          className="btn sm btn-ghost"
          style={{ color: 'var(--ink-2)', opacity: viewOnly ? 0.5 : 1 }}
          onClick={onRegenerateAll}
          disabled={viewOnly || regenerating}
          title="Have Meri re-draft every section of this document"
        >
          <Icon name="Sparkles" size={14} />
          {regenerating ? 'Regenerating…' : 'Regenerate all'}
        </button>
      )}
      {/* E-17: real collaborators only — no seed avatars until someone's invited. */}
      {collaborators && collaborators.length > 0 && <AvaStack list={collaborators} size={26} />}
      <button className="btn sm" onClick={onShare}>
        <Icon name="UserPlus" size={13} />
        Share
      </button>
      {/* E-20: manual "Save draft" removed — autosave (+ version checkpoints) covers it. */}
      <button className="btn btn-accent" onClick={onPreview} style={{ fontWeight: 600 }}>
        <Icon name="FileCheck" size={14} />
        Preview &amp; Save
      </button>
    </div>
  );
}
