import { fmtDate } from '../../../components/dossier/dossier-format.js';
import { kpiSubText, kpiUnavailable, kpiValueText, orderedKpis } from '../../../pages/bills/bill-360-kpis.js';
import type { BillContext, BillDossierResponse } from '../../../pages/bills/bill-360.types.js';
import { DossierHero, type DossierHeroScope, type DossierKpi, type PillSev } from './dossier-primitives.js';

/**
 * Bill-specific adapter over the vNext {@link DossierHero} — the re-skin of
 * pages/bills/BillDossierHero.tsx. It maps one `BillDossierResponse` onto the
 * prototype's hero: bill number + canonical status pill + meta chips
 * (chamber · type · sponsor), the serif title, and — only in a client context —
 * the scope chip, stance, and priority, then the last-synced line.
 *
 * It also owns {@link decorateKpis}, which re-applies the prototype's per-cell KPI
 * value color and monospace to the API's `BillKpi[]`. The contract carries the
 * cell's semantic id, its value type and (when absent) the reason it is absent;
 * presentation stays client-side, so the color and mono flags are derived here
 * from the same dossier fields the prototype reads — the only difference from the
 * legacy adapter is the token layer (`--capiro-*`).
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
    // Policy portfolios (R6) get the accent glyph; a client stays secondary ink,
    // matching the prototype's scopeMeta().
    color:
      d.context.contextType === 'policy_portfolio'
        ? 'var(--capiro-color-text-accent)'
        : 'var(--capiro-color-text-secondary)',
  };
}

/**
 * Re-apply the prototype's per-cell KPI presentation, keyed on each cell's
 * SEMANTIC id (LW-QA-021 — decorating by array index silently mis-colored the
 * strip whenever the API reordered or inserted a cell):
 *
 *  current_status       — status severity color, proportional
 *  latest_vote          — newest vote's result severity (muted when none), mono
 *  funding_position     — primary ink, mono (muted when unavailable)
 *  delta_from_request   — delta sign color (muted when unavailable), mono
 *  last_official_action — primary ink, proportional
 *  next_milestone       — primary ink, proportional
 *
 * "Unavailable" is read off `value == null`, not off a '—' string comparison.
 */
export function decorateKpis(d: BillDossierResponse): DossierKpi[] {
  const vote = d.votes[0] ?? null;
  const MUTED = 'var(--capiro-color-text-muted)';
  return orderedKpis(d.kpis).map((k) => {
    // kpiValueText narrows a `date` value to a calendar date; kpiSubText carries
    // the caption, or the grounded reason when the cell has no figure.
    const cell: DossierKpi = { label: k.label, value: kpiValueText(k), sub: kpiSubText(k) };
    if (kpiUnavailable(k)) {
      return { ...cell, mono: k.valueType === 'money' || k.valueType === 'signed_money', color: MUTED };
    }
    switch (k.id) {
      case 'current_status':
        return { ...cell, sev: d.bill.statusSev as PillSev };
      case 'latest_vote':
        return { ...cell, mono: true, ...(vote ? { sev: vote.resultSev as PillSev } : {}) };
      case 'funding_position':
        return { ...cell, mono: true };
      case 'delta_from_request':
        return { ...cell, mono: true, color: deltaKpiColor(cell.value) };
      default:
        return cell;
    }
  });
}

/**
 * Δ-cell color from the rendered value. `fmtSignedMillions` emits '+…', '−…'
 * (U+2212) or the literal 'flat', so the sign is read off the string rather than
 * recomputed — the API already decided what the cell says. An unavailable delta
 * never reaches here; it is muted by `kpiUnavailable` above.
 */
function deltaKpiColor(value: string): string {
  if (value.startsWith('+')) return 'var(--capiro-color-success)';
  if (value.startsWith('−') || value.startsWith('-')) return 'var(--capiro-color-danger)';
  return 'var(--capiro-color-text-secondary)';
}

export function BillDossierHeroVNext({ dossier }: { dossier: BillDossierResponse }) {
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
