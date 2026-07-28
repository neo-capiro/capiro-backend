/*
 * Strategy editor header — the prototype's compact two-row shell, extracted out
 * of StrategyEditorPage so its geometry is testable in isolation.
 *
 * Every literal below is measured from the locked prototype
 * (`Capiro - Strategy Planner (PPBE) - standalone (2).html`, StrategyView) at a
 * 1440px viewport: outer padding 12/26/14, a 30x30 back button on a 12px gap,
 * one-line title + one-line `Goal · …`, and a second row that ends
 * Watch → Export → History → Ask Meri. Measured header height there is 129px
 * (the phase budget is <=132px).
 *
 * This component is presentational: it FETCHES NOTHING. Watch display state and
 * every action arrive as props so the page keeps sole ownership of queries,
 * mutations and feature gates.
 */
import { Icon, btnGhost, iconBtn } from './strategy-ui.js';

/** Reference-calendar overlays the timeline can draw. Page + timeline share these. */
export type LayerKey = 'ppbe' | 'congress';

/** Chip order is the prototype's; the app supports PPBE + Congress today. */
const LAYER_DEFS: ReadonlyArray<readonly [LayerKey, string, string]> = [
  ['ppbe', 'PPBE', 'var(--info)'],
  ['congress', 'Congress', 'var(--accent)'],
];

/** What the header needs to draw the Watch chip. null ⇒ tenant has no Watch. */
export interface WatchChipState {
  /** The strategy's Watch mission is active. */
  on: boolean;
  /** Proposals awaiting review on this strategy. */
  pending: number;
}

export interface StrategyHeaderProps {
  onBack: () => void;
  clientLabel: string;
  typeLabel: string;
  title: string;
  goal: string | null;
  layers: Record<LayerKey, boolean>;
  onToggleLayer: (key: LayerKey) => void;
  /** Omit/null to hide the chip (tenant is not gated in for Watch). */
  watch?: WatchChipState | null;
  onOpenWatch?: () => void;
  onExport: () => void;
  onHistory: () => void;
  onAskMeri: () => void;
  /** Collapses the panel. Required whenever `meriPanelOpen` can become true. */
  onClosePanel?: () => void;
  /**
   * The editor panel is already open. The CTA does NOT hide — it turns into the
   * panel's collapse control (Phase 7, Lia). The prototype hid it, but the
   * prototype puts the panel BESIDE the header; here the header spans the full
   * width above a persistent panel, so hiding the control strands the user.
   */
  meriPanelOpen: boolean;
  /** features.strategyPlannerMeri. Off ⇒ the manual fallback replaces the CTA. */
  meriEnabled: boolean;
  /** Manual step creation, kept ONLY as the Meri-off fallback. */
  onAddStep?: () => void;
  /** Disables the fallback Add step while its mutation is in flight. */
  addStepPending?: boolean;
}

export function StrategyHeader({
  onBack,
  clientLabel,
  typeLabel,
  title,
  goal,
  layers,
  onToggleLayer,
  watch,
  onOpenWatch,
  onExport,
  onHistory,
  onAskMeri,
  onClosePanel,
  meriPanelOpen,
  meriEnabled,
  onAddStep,
  addStepPending,
}: StrategyHeaderProps) {
  return (
    <div
      data-testid="sp-header"
      style={{
        padding: '12px 26px 14px',
        borderBottom: '1px solid var(--border-1)',
        background: 'var(--bg-surface)',
        flexShrink: 0,
      }}
    >
      {/* Row 1 — back · eyebrow · title · goal */}
      <div
        data-testid="sp-header-row1"
        style={{ display: 'flex', alignItems: 'center', gap: 12 }}
      >
        <button
          onClick={onBack}
          aria-label="Back to strategies"
          style={{ ...iconBtn, border: '1px solid var(--border-2)', width: 30, height: 30, flexShrink: 0 }}
        >
          <Icon name="chevleft" size={16} color="var(--ink-2)" />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            data-testid="sp-header-eyebrow"
            style={{
              fontSize: 'var(--text-2xs)',
              color: 'var(--ink-3)',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              // Phase 7 §7: without this the eyebrow inherits antd's 1.5714
              // body line-height (15.71px at 10px) where the prototype
              // computes `normal` (13.33px). Measured, that 2.38px was the
              // single root cause of the header's whole vertical drift — the
              // title, goal and today flag all sat +2.37/+2.38px low.
              lineHeight: 'normal',
            }}
          >
            {clientLabel} · {typeLabel}
          </div>
          <div
            data-testid="sp-header-title"
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: 'var(--ink-1)',
              letterSpacing: '-0.02em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              lineHeight: 1.2,
            }}
          >
            {title}
          </div>
          {goal && (
            <div
              data-testid="sp-header-goal"
              title={goal}
              style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--ink-3)',
                lineHeight: 1.35,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                marginTop: 2,
              }}
            >
              <span style={{ fontWeight: 700, color: 'var(--ink-2)' }}>Goal · </span>
              {goal}
            </div>
          )}
        </div>
      </div>

      {/* Row 2 — layers · spacer · Watch · Export · History · Ask Meri */}
      <div
        data-testid="sp-header-row2"
        style={{
          marginTop: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          rowGap: 8,
        }}
      >
        <span
          style={{
            fontSize: 'var(--text-2xs)',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--ink-4)',
            marginRight: 2,
          }}
        >
          Layers
        </span>
        {LAYER_DEFS.map(([key, label, color]) => {
          const on = layers[key];
          return (
            <button
              key={key}
              onClick={() => onToggleLayer(key)}
              aria-pressed={on}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 11px',
                borderRadius: 7,
                cursor: 'pointer',
                border: on ? `1px solid ${color}` : '1px solid var(--border-2)',
                background: on ? 'var(--bg-surface-2)' : 'var(--bg-surface)',
                color: on ? 'var(--ink-1)' : 'var(--ink-3)',
                fontSize: 'var(--text-xs)',
                fontWeight: 600,
                // The prototype sets `button { font-family: var(--font-sans) }`
                // globally and the port has no equivalent, so without this the
                // chip falls back to the UA font: measured 69x25 against the
                // prototype's 64x26.
                fontFamily: 'var(--font-sans)',
              }}
            >
              <span
                style={{ width: 8, height: 8, borderRadius: 2, background: on ? color : 'var(--ink-4)' }}
              />
              {label}
            </button>
          );
        })}
        <span style={{ flex: 1 }} />

        {watch && <WatchChip watch={watch} onOpen={onOpenWatch} />}

        {/* Meri-off fallback only: manual step creation stays reachable. */}
        {!meriEnabled && onAddStep && (
          <button
            onClick={onAddStep}
            disabled={addStepPending}
            style={{ ...btnGhost, padding: '8px 12px', fontSize: 'var(--text-sm)', flexShrink: 0 }}
          >
            <Icon name="plus" size={14} color="var(--ink-2)" /> Add step
          </button>
        )}

        <button
          onClick={onExport}
          style={{ ...btnGhost, padding: '8px 12px', fontSize: 'var(--text-sm)', flexShrink: 0 }}
        >
          <Icon name="upload" size={14} color="var(--ink-2)" /> Export
        </button>
        <button
          onClick={onHistory}
          style={{ ...btnGhost, padding: '8px 12px', fontSize: 'var(--text-sm)', flexShrink: 0 }}
        >
          <Icon name="clock" size={14} color="var(--ink-2)" /> History
        </button>
        {/* Phase 7 (Lia): with the panel open this control does NOT disappear —
            it becomes the collapse control for the panel it opened. The header
            is full-width above a persistent panel, so a header slot that
            vanishes on open leaves no way back from the header itself. */}
        {meriEnabled ? (
          <button
            data-testid="sp-header-meri-toggle"
            onClick={meriPanelOpen ? onClosePanel : onAskMeri}
            aria-expanded={meriPanelOpen}
            aria-label={meriPanelOpen ? 'Collapse the Meri panel' : 'Ask Meri'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              whiteSpace: 'nowrap',
              padding: '9px 18px',
              borderRadius: 10,
              fontSize: 'var(--text-base)',
              fontWeight: 700,
              fontFamily: 'var(--font-sans)',
              cursor: 'pointer',
              flexShrink: 0,
              marginLeft: 4,
              // Open = a quiet, outlined control; closed = the prototype's
              // filled accent CTA, unchanged.
              border: meriPanelOpen ? '1px solid var(--border-2)' : 'none',
              background: meriPanelOpen ? 'var(--bg-surface)' : 'var(--accent)',
              color: meriPanelOpen ? 'var(--ink-2)' : '#fff',
              boxShadow: meriPanelOpen ? 'none' : '0 5px 14px var(--accent-glow)',
            }}
          >
            <Icon
              name={meriPanelOpen ? 'panel' : 'spark'}
              size={16}
              color={meriPanelOpen ? 'var(--ink-2)' : '#fff'}
            />{' '}
            {meriPanelOpen ? 'Collapse' : 'Ask Meri'}
          </button>
        ) : (
          // SHL-4 fallback: the panel is the only editing surface with AI off.
          <button
            data-testid="sp-header-meri-toggle"
            onClick={meriPanelOpen ? onClosePanel : onAskMeri}
            aria-expanded={meriPanelOpen}
            aria-label={meriPanelOpen ? 'Collapse the edit panel' : 'Edit panel'}
            style={{ ...btnGhost, padding: '8px 12px', fontSize: 'var(--text-sm)', flexShrink: 0 }}
          >
            <Icon name="panel" size={14} color="var(--ink-2)" />{' '}
            {meriPanelOpen ? 'Collapse' : 'Edit panel'}
          </button>
        )}
      </div>
    </div>
  );
}

/*
 * Interim Watch entry point (Phase 4 replaces the panel it opens, not this
 * chip). Dot + Watching/Watch off + pending count, exactly the prototype's
 * WatchChip geometry. It opens the in-editor panel — it deliberately does NOT
 * navigate to the separate review queue.
 */
function WatchChip({ watch, onOpen }: { watch: WatchChipState; onOpen?: () => void }) {
  const alert = watch.pending > 0;
  const label = watch.on ? 'Watching' : 'Watch off';
  return (
    <button
      data-testid="sp-header-watch"
      onClick={onOpen}
      title="Watch mode — Meri's weekly check"
      aria-label={
        alert
          ? `${label}. ${watch.pending} proposed change${watch.pending === 1 ? '' : 's'} awaiting review.`
          : label
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        flexShrink: 0,
        padding: '5px 10px',
        borderRadius: 8,
        cursor: 'pointer',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-xs)',
        fontWeight: 600,
        border: alert ? '1px solid var(--accent)' : '1px solid var(--border-2)',
        background: alert ? 'var(--accent-soft)' : 'var(--bg-surface)',
        color: alert ? 'var(--accent-ink)' : 'var(--ink-2)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: watch.on ? 'var(--success)' : 'var(--ink-4)',
          boxShadow: watch.on ? '0 0 0 3px var(--success-soft)' : 'none',
        }}
      />
      {label}
      {alert && (
        <span
          style={{
            background: 'var(--accent)',
            color: '#fff',
            borderRadius: 20,
            padding: '1px 7px',
            fontSize: 10,
            fontWeight: 800,
          }}
        >
          {watch.pending}
        </span>
      )}
    </button>
  );
}
