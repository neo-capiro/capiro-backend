import { fmtDate } from '../../../components/dossier/dossier-format.js';
import type { DossierProvenance } from '../../../pages/bills/bill-360.types.js';
import { FreshnessPill, Pill, SourceLink, evBadge, type PillSev } from './dossier-primitives.js';
import { BillSourceHealth } from '../../../pages/bills/BillSourceHealth.js';

/**
 * Evidence tab — vNext re-skin of pages/bills/BillEvidenceTab.tsx: Sources &
 * provenance rows + the "How to read evidence" legend.
 */

const LEGEND: Array<{ label: string; sev: PillSev; desc: string }> = [
  {
    label: 'Official',
    sev: 'neutral',
    desc: 'Verbatim from an official source — clerk, committee report, or public law.',
  },
  {
    label: 'Capiro analysis',
    sev: 'accent',
    desc: 'Derived by Capiro from official data, carries a confidence.',
  },
  {
    label: 'Analyst outlook',
    sev: 'notable',
    desc: 'Human forecast — never overrides official status; can expire.',
  },
];

export function BillEvidenceTab({ provenance }: { provenance: DossierProvenance }) {
  return (
    <>
      <BillSourceHealth provenance={provenance} />
      <div className="b360-card b360-card--sources">
        <div className="b360-ev-head">
          <span className="b360-section-label b360-section-label--flush">Sources & provenance</span>
          {provenance.lastSyncedAt ? (
            <span className="b360-ev-synced">Last synced {fmtDate(provenance.lastSyncedAt)}</span>
          ) : null}
        </div>
        {provenance.sources.map((s, i) => {
          const b = evBadge(s.origin);
          return (
            <div className="b360-source-row" key={i}>
              <Pill sev={b.sev}>{b.label}</Pill>
              <span className="b360-source-label">
                <SourceLink label={s.label} url={s.url} />
              </span>
              <span className="b360-source-as">{fmtDate(s.as)}</span>
              <FreshnessPill fresh={s.fresh} />
            </div>
          );
        })}
      </div>
      <div className="b360-card b360-card--legend">
        <div className="b360-section-label">How to read evidence</div>
        <div className="b360-legend">
          {LEGEND.map((l) => (
            <div className="b360-legend-row" key={l.label}>
              <Pill sev={l.sev}>{l.label}</Pill>
              <span className="b360-legend-desc">{l.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
