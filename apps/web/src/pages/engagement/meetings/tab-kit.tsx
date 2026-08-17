/**
 * Shared building blocks for the meeting-panel tabs (Prep / Notes / Debrief),
 * ported from the prototype: the Meri "generating" spinner, the freshly-drafted
 * banner, and the post-generation action bar (Regenerate · Edit · Export PDF ·
 * Approve). Presentational; the tabs wire the real mutations in.
 */
import type { ChangeEvent, CSSProperties } from 'react';
import { Check, Download, Pencil, RefreshCw } from 'lucide-react';
import { MeriGlyph } from './meetings-ui.js';

/**
 * Top-of-tab stage pill — reskin phase (vNext Engagement drawer, navy design).
 * The design reference renders a tone-driven pill immediately under the tab
 * strip on all three tabs (prep/notes/debrief), reflecting that tab's current
 * stage. Before this, PrepTab and DebriefTab rendered no such pill at all, and
 * NotesTab had a partial version ("Summarized") placed mid-content instead of
 * at the top — this component is the single shared implementation all three
 * now use, so the tone table and shape can't drift between tabs.
 *
 * Uses the `.eng-pill` classes from engagement-tones.css (spec: navy/gray/
 * warn/err, 6px dot) — these are generic pills, not vNext-exclusive, so this
 * lives in the shared tab-kit rather than being forked per app. NOTE: as
 * built today, engagement-tones.css's rules are all scoped under
 * `.capiro-vnext-root` (see that file's own header: "vNext-only"), which only
 * exists on os.capiro.ai — so on app.capiro.ai this pill currently renders as
 * unstyled text + a bare dot (no color/shape) until that scope is relaxed.
 * Flagged in the phase report rather than silently restructured here, since
 * engagement-tones.css belongs to an earlier reskin phase and changing its
 * scoping strategy is a separate decision.
 */
export function StagePill({
  label,
  tone,
  style,
}: {
  label: string;
  tone: 'navy' | 'gray' | 'warn' | 'err';
  /** Override spacing for callers that already control gaps themselves (e.g.
   *  a flex column with its own `gap`) — defaults to a 16px bottom margin,
   *  which is right for the tabs' plain-`<div>` (non-gap) layouts. */
  style?: CSSProperties;
}) {
  return (
    <span className={`eng-pill eng-pill--${tone}`} style={{ marginBottom: 16, ...style }}>
      <span className="eng-pill__dot" />
      {label}
    </span>
  );
}

/**
 * Closing rule-reinforcement sentence — small print pinned to the bottom of a
 * populated tab body, restating the one rule specific to that artifact (e.g.
 * "Approval never implies sharing"). Shared shell so the three tabs' copy
 * differs but the placement/styling doesn't drift.
 */
export function RuleReinforcement({ children }: { children: string }) {
  return (
    <p
      style={{
        margin: '20px 0 0',
        paddingTop: 14,
        borderTop: '1px solid var(--border-1)',
        fontSize: 11.5,
        lineHeight: 1.5,
        color: 'var(--ink-4)',
      }}
    >
      {children}
    </p>
  );
}

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
  /** Phase 2 §3.j — a SEPARATE signal from `approved`: this exact approved
   *  version has also been shared. Never shown for an unapproved artifact
   *  (sharing requires approval), so it only ever augments the approved pill. */
  shared,
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
  shared?: boolean;
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
          <>
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
              title="Approved — completion and approval are separate: this artifact existed before it was approved."
            >
              <Check size={14} strokeWidth={3} />
              {approvedLabel}
            </span>
            {shared && (
              <span
                className="pill info"
                title="Also shared to the client and your firm's Meeting Library."
              >
                Shared
              </span>
            )}
          </>
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
