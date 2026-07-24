import { DossierHero, type DossierHeroScope } from '../../components/dossier/DossierHero.js';
import type { DossierKpi } from '../../components/dossier/DossierKpiStrip.js';
import type { PillSev } from '../../components/dossier/EvidenceBadge.js';
import { fmtDate } from '../../components/dossier/dossier-format.js';
import type { BillContext, BillDossierResponse } from './bill-360.types.js';

/**
 * Bill-specific adapter over the generic {@link DossierHero} (plan §2.2). It maps
 * one `BillDossierResponse` onto the prototype's hero: bill number + canonical
 * status pill + meta chips (chamber · type · sponsor), the serif title, and — only
 * in a client context — the scope chip, stance, and priority, then the
 * last-synced line.
 *
 * It also owns {@link decorateKpis}, which re-applies the prototype's per-cell KPI
 * value color and monospace to the API's flat `BillKpi[]`. The R1 contract returns
 * label/value/sub only (presentation stays client-side), so the color and mono
 * flags are derived here from the same dossier fields the prototype reads.
 */

const STANCE: Record<NonNullable<BillContext['position']>, { label: string; sev: PillSev }> = {
  support: { label: 'Support', sev: 'success' },
  oppose: { label: 'Oppose', sev: 'critical' },
  monitor: { label: 'Monitor', sev: 'neutral' },
};

const PRIORITY: Record<NonNullable<BillContext['priority']>, string> = {
  high: 'High',
  med: 'Medium',
  low: 'Low',
};

/** Meta chips: chamber · "<TYPE> bill" · "Sponsor: …", skipping absent parts. */
export function billMetaChips(bill: BillDossierResponse['bill']): string[] {
  return [
    bill.chamber,
    bill.type ? `${bill.type.toUpperCase()} bill` : null,
    bill.sponsor ? `Sponsor: ${bill.sponsor}` : null,
  ].filter((x): x is string => Boolean(x));
}

function heroScope(d: BillDossierResponse): DossierHeroScope | null {
  if (!d.context) return null;
  return {
    typeLabel: d.context.contextType === 'policy_portfolio' ? 'Policy portfolio' : 'Client',
    label: d.context.name,
    // Policy portfolios (R6) get the accent glyph; a client stays ink-2, matching
    // the prototype's scopeMeta().
    color: d.context.contextType === 'policy_portfolio' ? 'var(--accent)' : 'var(--ink-2)',
  };
}

/**
 * Re-apply the prototype's per-cell KPI presentation. The strip is a fixed
 * 6-cell sequence (plan §2.2), so cells are decorated by position:
 *
 *  0 Current status       — status severity color, proportional
 *  1 Latest recorded vote — newest vote's result severity (ink-3 when none), mono
 *  2 Funding position     — ink-1, mono (a "—" cell stays ink-3)
 *  3 Δ from request       — delta sign color (ink-3 when unavailable), mono
 *  4 Last official action — ink-1, proportional
 *  5 Next milestone       — ink-1, proportional
 */
export function decorateKpis(d: BillDossierResponse): DossierKpi[] {
  const vote = d.votes[0] ?? null;
  const unavailable = (k: { value: string }) => k.value === '—';
  return d.kpis
    // The API's KPI value/sub are opaque strings; several ARE dates (status date,
    // last-action date). fmtDate narrows an ISO instant and passes anything else
    // through, so the strip reads as short dates like the prototype.
    .map((k) => ({ ...k, value: fmtDate(k.value), sub: k.sub ? fmtDate(k.sub) : k.sub }))
    .map((k, i) => {
      switch (i) {
        case 0:
          return { ...k, sev: d.bill.statusSev as PillSev };
        case 1:
          return {
            ...k,
            mono: true,
            ...(vote ? { sev: vote.resultSev as PillSev } : { color: 'var(--ink-3)' }),
          };
        case 2:
          return { ...k, mono: true, ...(unavailable(k) ? { color: 'var(--ink-3)' } : {}) };
        case 3:
          return { ...k, mono: true, color: deltaKpiColor(k.value) };
        default:
          return { ...k };
      }
    });
}

/**
 * Δ-cell color from the rendered value. `fmtDelta` emits '+…', '−…' (U+2212),
 * 'flat', or '—', so the sign is read off the string rather than recomputed —
 * the API already decided what the cell says.
 */
function deltaKpiColor(value: string): string {
  if (value.startsWith('+')) return 'var(--positive)';
  if (value.startsWith('−') || value.startsWith('-')) return 'var(--critical)';
  if (value === '—') return 'var(--ink-3)';
  return 'var(--ink-2)';
}

export function BillDossierHero({ dossier }: { dossier: BillDossierResponse }) {
  const { bill, tracking } = dossier;
  return (
    <DossierHero
      num={bill.num}
      statusLabel={bill.statusLabel}
      statusSev={bill.statusSev as PillSev}
      metaChips={billMetaChips(bill)}
      title={bill.title}
      scope={heroScope(dossier)}
      stance={tracking?.position ? STANCE[tracking.position] : null}
      priorityLabel={tracking?.priority ? PRIORITY[tracking.priority] : null}
      lastSynced={fmtDate(dossier.provenance.lastSyncedAt) || null}
    />
  );
}
