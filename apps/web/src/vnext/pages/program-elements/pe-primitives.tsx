/**
 * Program Elements vNext — workspace primitives.
 *
 * Phase 4 polish pass. Phase 3 removed antd from the workspace but rebuilt the
 * OLD visual design class-for-class, so /program-elements still looked nothing
 * like the rest of os.capiro.ai. Everything here is now a THIN adapter over
 * `vnext/components/**` — CapiroBadge for evidence marks, CapiroSelect for the
 * filters, CapiroSkeleton for loading — so the workspace reads like Dashboard,
 * Strategies, Settings and Directory do.
 *
 * The PROPS of each export are unchanged from the Phase 3 versions: the views'
 * behavior contracts (which filter holds which value, what a state means) are
 * untouched; only the rendered chrome moved onto the primitive layer.
 */
import { evMarkClass, type EvState } from '../../../pages/program-element/v2/pe-v2-model.js';
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import { CapiroSelect } from '../../components/fields/index.js';
import { CapiroSkeleton } from '../../components/feedback/index.js';

/**
 * Evidence state → badge tone. Status is never colour-only: every badge also
 * carries the patterned `.pe-ws-evdot` marker (the glyph the Phase 3 labels
 * baked into their text) plus the state word itself.
 */
const EV_TONE: Record<EvState, CapiroBadgeTone> = {
  VERIFIED: 'success',
  PARTIAL: 'neutral',
  PENDING: 'info',
  CONFLICT: 'warning',
  'REVIEW REQUIRED': 'danger',
  ABSENT: 'neutral',
};

/**
 * Evidence mark — CapiroBadge + a state-shaped marker.
 *
 * `quiet` keeps the healthy states from shouting in a dense grid: the badge
 * drops its tinted fill and prints as marker + mono label, exactly the
 * quiet-vs-loud distinction the Phase 3 version drew by hand.
 */
export function EvMark({
  state,
  label,
  large,
  quiet,
}: {
  state: EvState;
  label: string;
  large?: boolean;
  /** quiet = marker + mono text (healthy); loud states keep the tinted badge */
  quiet?: boolean;
}) {
  const loud = state === 'CONFLICT' || state === 'REVIEW REQUIRED';
  return (
    <CapiroBadge
      tone={loud || !quiet ? EV_TONE[state] : 'neutral'}
      className={`pe-ws-ev${quiet && !loud ? ' pe-ws-ev--quiet' : ''}`}
      dot={<span className={`pe-ws-evdot ${evMarkClass(state)}${large ? ' lg' : ''}`} aria-hidden />}
    >
      {label}
    </CapiroBadge>
  );
}

/** Segmented control: FEED|TABLE, STANDARD|COMPACT, BOTH|AUTH|APPR … */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel?: string;
}) {
  return (
    <span className="pe-ws-seg" role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={opt.value === value ? 'active' : ''}
          aria-pressed={opt.value === value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </span>
  );
}

/**
 * Filter control — CapiroSelect over the module's `string[]` option lists.
 *
 * Same props as the Phase 3 hand-rolled popover (label / value / options /
 * onChange / formatValue) and the same values flow through onChange, so every
 * filter predicate in the views is untouched. The presentation is now the
 * platform field: visible label, native select, token chrome — the same
 * treatment Settings → Intelligence Mappings and the Mark-up monitor use.
 */
export function FilterControl({
  label,
  value,
  options,
  onChange,
  formatValue,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (next: string) => void;
  formatValue?: (v: string) => string;
}) {
  const fmt = formatValue ?? ((v: string) => v);
  return (
    <CapiroSelect
      className="pe-ws-filter"
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      options={options.map((option) => ({ value: option, label: fmt(option) }))}
    />
  );
}

/**
 * Loading block — CapiroSkeleton lines at the workspace call sites. Fixed line
 * heights, never a flex-grown pane: the vNext shell scrolls the page, so a
 * loading block that sizes itself off its parent inflates to content height
 * (Phase 3 lesson #1).
 */
export function PeSkeletonBlock({ rows }: { rows: number }) {
  return (
    <div className="pe-ws-skel" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <CapiroSkeleton key={i} height={14} width={i === rows - 1 ? '61%' : '100%'} />
      ))}
    </div>
  );
}
