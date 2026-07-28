/**
 * Editor toolbar (sub-header) — title, truthful autosave state, recovery,
 * anonymization, version history, sharing, and preview.
 */
import type { WsLetterhead } from '../types.js';
import { AvaStack, Icon } from '../kit.js';

export type SaveStatus = 'saved' | 'saving' | 'error';

export function EditorToolbar({
  title,
  saveStatus,
  lastSavedAt,
  failedTargets = [],
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
  onRetrySave,
  onCopyUnsaved,
}: {
  title: string;
  saveStatus: SaveStatus;
  lastSavedAt?: number | null;
  failedTargets?: string[];
  anonymize: boolean;
  letterhead?: WsLetterhead;
  historyOpen?: boolean;
  viewOnly?: boolean;
  collaborators?: string[];
  onAnonymize: () => void;
  onHistory: () => void;
  onShare: () => void;
  onPreview: () => void | Promise<void>;
  onRegenerateAll?: () => void;
  regenerating?: boolean;
  /** Resolved value is intentionally discarded; the toolbar only triggers the retry. */
  onRetrySave?: () => void | Promise<unknown>;
  onCopyUnsaved?: () => void | Promise<unknown>;
}) {
  const savedLabel = lastSavedAt
    ? `Saved · ${new Date(lastSavedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : 'Saved';
  const saveLabel =
    saveStatus === 'saving' ? 'Saving…' : saveStatus === 'error' ? 'Save failed' : savedLabel;
  const saveTitle =
    saveStatus === 'error' && failedTargets.length
      ? `Save failed: ${failedTargets.join(', ')}`
      : saveLabel;

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
          aria-live="polite"
          title={saveTitle}
          style={{
            fontSize: 11,
            color: saveStatus === 'error' ? 'var(--danger)' : 'var(--ink-3)',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          {saveStatus === 'saving' ? (
            <Icon name="RefreshCw" size={10} style={{ opacity: 0.5 }} />
          ) : saveStatus === 'error' ? (
            <Icon name="AlertTriangle" size={10} />
          ) : (
            <Icon name="Check" size={10} style={{ color: 'var(--success)' }} />
          )}
          {saveLabel}
        </div>
      </div>

      {saveStatus === 'error' && (
        <>
          <button className="btn sm" onClick={() => void onRetrySave?.()} title={saveTitle}>
            <Icon name="RefreshCw" size={12} />
            Retry save
          </button>
          <button
            className="btn sm btn-ghost"
            onClick={() => void onCopyUnsaved?.()}
            title="Copy the current unsaved document as recovery JSON"
          >
            <Icon name="Copy" size={12} />
            Copy unsaved content
          </button>
        </>
      )}

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
          style={{ color: 'var(--ink-2)', opacity: viewOnly || saveStatus === 'error' ? 0.5 : 1 }}
          onClick={onRegenerateAll}
          disabled={viewOnly || regenerating || saveStatus === 'error'}
          title="Have Meri re-draft every section of this document"
        >
          <Icon name="Sparkles" size={14} />
          {regenerating ? 'Regenerating…' : 'Regenerate all'}
        </button>
      )}
      {collaborators && collaborators.length > 0 && <AvaStack list={collaborators} size={26} />}
      <button className="btn sm" onClick={onShare}>
        <Icon name="UserPlus" size={13} />
        Share
      </button>
      <button
        className="btn btn-accent"
        onClick={() => void onPreview()}
        disabled={saveStatus === 'saving' || saveStatus === 'error'}
        style={{ fontWeight: 600 }}
        title={saveStatus === 'error' ? 'Resolve the failed save before previewing' : undefined}
      >
        <Icon name="FileCheck" size={14} />
        Preview &amp; Save
      </button>
    </div>
  );
}
