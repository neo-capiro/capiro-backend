/**
 * Shared building blocks for the meeting-panel tabs (Prep / Notes / Debrief),
 * ported from the prototype: the Meri "generating" spinner, the freshly-drafted
 * banner, and the post-generation action bar (Regenerate · Edit · Export PDF ·
 * Approve). Presentational; the tabs wire the real mutations in.
 */
import type { ChangeEvent } from 'react';
import { Check, Download, Pencil, RefreshCw } from 'lucide-react';
import { MeriGlyph } from './meetings-ui.js';

export function GeneratingState({ label, sub }: { label: string; sub?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 13,
        padding: '44px 24px',
        textAlign: 'center',
      }}
    >
      <div style={{ position: 'relative', width: 42, height: 42 }}>
        <span
          style={{
            position: 'absolute',
            inset: 0,
            border: '2.5px solid var(--accent-soft)',
            borderTopColor: 'var(--accent)',
            borderRadius: '50%',
            animation: 'meri-spin 0.8s linear infinite',
          }}
        />
        <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          <MeriGlyph size={20} />
        </span>
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-1)' }}>{label}</div>
      {sub && (
        <div style={{ fontSize: 12, color: 'var(--ink-3)', maxWidth: 300, lineHeight: 1.5 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

export function GeneratedBanner({ text, onRegen }: { text?: string; onRegen?: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '9px 12px',
        borderRadius: 8,
        background: 'var(--accent-soft)',
        marginBottom: 18,
      }}
    >
      <MeriGlyph size={18} />
      <span style={{ flex: 1, fontSize: 12, color: 'var(--accent-ink)' }}>
        {text ?? 'Drafted by Meri — review and edit before sharing.'}
      </span>
      {onRegen && (
        <button
          type="button"
          onClick={onRegen}
          className="btn sm"
          style={{ gap: 5, padding: '3px 9px' }}
        >
          <RefreshCw size={12} />
          Regenerate
        </button>
      )}
    </div>
  );
}

export function ArtifactActionBar({
  refine = false,
  refineValue,
  onRefineChange,
  refinePlaceholder,
  onRegenerate,
  regenerating,
  regenerateDisabled,
  onEdit,
  onExport,
  approved,
  onApprove,
  approving,
  approveLabel = 'Approve',
  approvedLabel = 'Approved',
}: {
  refine?: boolean;
  refineValue?: string;
  onRefineChange?: (v: string) => void;
  refinePlaceholder?: string;
  onRegenerate?: () => void;
  regenerating?: boolean;
  regenerateDisabled?: boolean;
  onEdit?: () => void;
  onExport: () => void;
  approved: boolean;
  onApprove?: () => void;
  approving?: boolean;
  approveLabel?: string;
  approvedLabel?: string;
}) {
  return (
    <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border-1)' }}>
      {refine && (
        <textarea
          rows={2}
          value={refineValue ?? ''}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onRefineChange?.(e.target.value)}
          placeholder={
            refinePlaceholder ??
            'Add context to refine this, then Regenerate. Meri uses only this plus your synced emails and meetings.'
          }
          style={{
            width: '100%',
            padding: '8px 11px',
            fontSize: 12,
            fontFamily: 'var(--font-sans)',
            border: '1px solid var(--border-1)',
            borderRadius: 7,
            resize: 'vertical',
            lineHeight: 1.5,
            color: 'var(--ink-1)',
            background: 'var(--bg-surface)',
            outline: 'none',
            boxSizing: 'border-box',
            marginBottom: 12,
          }}
        />
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {onRegenerate && (
          <button
            type="button"
            className="btn sm"
            style={{ gap: 6 }}
            disabled={regenerating || regenerateDisabled}
            onClick={onRegenerate}
          >
            <RefreshCw size={13} />
            {regenerating ? 'Regenerating…' : 'Regenerate'}
          </button>
        )}
        {onEdit && (
          <button type="button" className="btn sm" style={{ gap: 6 }} onClick={onEdit}>
            <Pencil size={13} />
            Edit
          </button>
        )}
        <button type="button" className="btn sm" style={{ gap: 6 }} onClick={onExport}>
          <Download size={13} />
          Export PDF
        </button>
        <div style={{ flex: 1 }} />
        {approved ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12.5,
              fontWeight: 600,
              color: 'var(--success)',
              background: 'var(--success-soft)',
              borderRadius: 7,
              padding: '6px 12px',
            }}
          >
            <Check size={14} strokeWidth={3} />
            {approvedLabel}
          </span>
        ) : (
          onApprove && (
            <button
              type="button"
              className="btn sm btn-accent"
              style={{ gap: 6 }}
              disabled={approving}
              onClick={onApprove}
            >
              <Check size={13} strokeWidth={2.5} />
              {approving ? 'Saving…' : approveLabel}
            </button>
          )
        )}
      </div>
    </div>
  );
}
