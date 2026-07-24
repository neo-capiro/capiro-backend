import { EvidenceBadge } from '../../components/dossier/EvidenceBadge.js';
import { fmtDate } from '../../components/dossier/dossier-format.js';
import type { DossierOverview, EvidenceValue, RelatedVehicle } from './bill-360.types.js';

/** Meta line: 'As of … · source · Confidence: … · Valid to …' (only present parts). */
function evMeta(v: EvidenceValue): string {
  const p: string[] = [];
  if (v.asOf) p.push(`As of ${fmtDate(v.asOf)}`);
  if (v.source) p.push(v.source);
  if (v.confidence != null) p.push(`Confidence: ${v.confidence}`);
  if (v.expires) p.push(`Valid to ${fmtDate(v.expires)}`);
  return p.join(' · ');
}

const CARD_DEFS: Array<[string, keyof DossierOverview]> = [
  ['What changed', 'whatChanged'],
  ['Why it matters', 'whyItMatters'],
  ['Official next step', 'officialNextStep'],
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
        <div className="dsr-ov-grid">
          {cards.map((c) => (
            <div className="dsr-card raised" key={c.title}>
              <div className="dsr-ov-head">
                <span className="dsr-ov-title">{c.title}</span>
                <EvidenceBadge origin={c.val.origin} />
              </div>
              <p className="dsr-ov-text">{c.val.text}</p>
              <div className="dsr-ov-meta">{evMeta(c.val)}</div>
            </div>
          ))}
        </div>
      ) : null}
      {related.length ? (
        <div className="dsr-card">
          <div className="dsr-section-label">Related vehicles</div>
          <div className="dsr-related">
            {related.map((r) => (
              <button
                type="button"
                className="dsr-related-row"
                key={r.billId}
                onClick={() => onOpenBill(r.billId)}
              >
                <span className="dsr-related-num">{r.num}</span>
                <span className="dsr-related-title">{r.title ?? ''}</span>
                <span className="dsr-related-role">{r.role}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
