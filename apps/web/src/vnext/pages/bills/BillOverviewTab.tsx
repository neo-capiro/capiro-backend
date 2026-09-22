import { fmtDate } from '../../../components/dossier/dossier-format.js';
import type { DossierOverview, EvidenceValue, RelatedVehicle } from '../../../pages/bills/bill-360.types.js';
import { EvidenceBadge } from './dossier-primitives.js';

/**
 * Overview tab — vNext re-skin of pages/bills/BillOverviewTab.tsx: the four
 * evidence cards (What changed / Why it matters / Procedural posture / Analyst
 * outlook, absent cards skipped) and the related-vehicles list.
 */

/** Meta line: 'As of … · source · Confidence: … · Valid to …' (only present parts). */
function evMeta(v: EvidenceValue): string {
  const p: string[] = [];
  if (v.asOf) p.push(`As of ${fmtDate(v.asOf)}`);
  if (v.source) p.push(v.source);
  if (v.confidence != null) p.push(`Confidence: ${v.confidence}`);
  if (v.expires) p.push(`Valid to ${fmtDate(v.expires)}`);
  return p.join(' · ');
}

const CARD_DEFS: Array<[string, keyof DossierOverview]> = [
  ['What changed', 'whatChanged'],
  ['Why it matters', 'whyItMatters'],
  ['Procedural posture', 'officialNextStep'],
  ['Analyst outlook', 'analystOutlook'],
];

export function BillOverviewTab({
  overview,
  related,
  onOpenBill,
}: {
  overview: DossierOverview;
  related: RelatedVehicle[];
  onOpenBill: (billId: string) => void;
}) {
  const cards = CARD_DEFS.map(([title, key]) => ({ title, val: overview[key] })).filter(
    (c): c is { title: string; val: EvidenceValue } => Boolean(c.val),
  );
  return (
    <>
      {cards.length ? (
        <div className="b360-ov-grid">
          {cards.map((c) => (
            <div className="b360-card raised capiro-elevation-widget" key={c.title}>
              <div className="b360-ov-head">
                <span className="b360-ov-title">{c.title}</span>
                <EvidenceBadge origin={c.val.origin} />
              </div>
              <p className="b360-ov-text">{c.val.text}</p>
              <div className="b360-ov-meta">{evMeta(c.val)}</div>
            </div>
          ))}
        </div>
      ) : null}
      {related.length ? (
        <div className="b360-card">
          <div className="b360-section-label">Related vehicles</div>
          <div className="b360-related">
            {related.map((r) => (
              <button
                type="button"
                className="b360-related-row"
                key={r.billId}
                onClick={() => onOpenBill(r.billId)}
              >
                <span className="b360-related-num">{r.num}</span>
                <span className="b360-related-title">{r.title ?? ''}</span>
                <span className="b360-related-role">{r.role}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
