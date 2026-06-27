/**
 * Editor toolbar (sub-header) — ported from the prototype `EditorToolbar`
 * (asset_07). Title + autosave indicator, Custom-letterhead pill, Anonymize
 * toggle, Checks (live score), Version history, collaborator stack, Share,
 * Save draft, Preview & Save.
 *
 * Phase 6b: the Checks popover and Version-history popover are wired (the parent
 * toggles them; this just dispatches onChecks/onHistory and shows the live
 * checks score). View-only mode (someone else holds the edit lock) disables the
 * mutating actions (Anonymize / Save draft) while leaving read actions
 * (Checks / Version history / Share / Preview) available.
 */
import type { WsLetterhead } from '../types.js';
import { AvaStack, Icon } from '../kit.js';

export type SaveStatus = 'saved' | 'saving';

const scoreColor = (passed: number, total: number): string => {
  if (total === 0) return 'var(--ink-3)';
  if (passed === total) return 'var(--success)';
  if (passed >= Math.ceil(total * 0.7)) return 'var(--notable)';
  return 'var(--critical)';
};

export function EditorToolbar({
  title,
  saveStatus,
  anonymize,
  letterhead,
  checksScore,
  checksOpen,
  historyOpen,
  viewOnly,
  onAnonymize,
  onChecks,
  onHistory,
  onShare,
  onSaveDraft,
  onPreview,
}: {
  title: string;
  saveStatus: SaveStatus;
  anonymize: boolean;
  letterhead?: WsLetterhead;
  /** Live pre-submission check score (null while loading). */
  checksScore?: { passed: number; total: number } | null;
  checksOpen?: boolean;
  historyOpen?: boolean;
  /** Someone else holds the edit lock — disable mutating actions. */
  viewOnly?: boolean;
  onAnonymize: () => void;
  onChecks: () => void;
  onHistory: () => void;
  onShare: () => void;
  onSaveDraft: () => void;
  onPreview: () => void;
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
          background: checksOpen ? 'var(--bg-sunken)' : 'transparent',
        }}
        onClick={onChecks}
      >
        <Icon name="ListChecks" size={14} />
        Checks{' '}
        <span
          style={{
            color: checksScore ? scoreColor(checksScore.passed, checksScore.total) : 'var(--ink-3)',
            fontWeight: 600,
          }}
          className="num"
        >
          {checksScore ? `${checksScore.passed}/${checksScore.total}` : '…'}
        </span>
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
      {/* TODO(phase 7): live collaborators — static avatar stack for now. */}
      <AvaStack list={['NM', 'MR', 'EO']} size={26} />
      <button className="btn sm" onClick={onShare}>
        <Icon name="UserPlus" size={13} />
        Share
      </button>
      <span style={{ width: 1, height: 22, background: 'var(--border-1)', margin: '0 2px' }} />
      <button
        className="btn sm btn-ghost"
        style={{ color: 'var(--ink-2)', opacity: viewOnly ? 0.5 : 1 }}
        onClick={onSaveDraft}
        disabled={viewOnly}
      >
        <Icon name="Save" size={13} />
        Save draft
      </button>
      <button className="btn btn-accent" onClick={onPreview} style={{ fontWeight: 600 }}>
        <Icon name="FileCheck" size={14} />
        Preview &amp; Save
      </button>
    </div>
  );
}
