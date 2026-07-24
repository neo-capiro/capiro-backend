import { Pill, evBadge, type PillSev } from '../../components/dossier/EvidenceBadge.js';
import { FreshnessPill, SourceLink } from '../../components/dossier/SourceLink.js';
import { fmtDate } from '../../components/dossier/dossier-format.js';
import type { DossierProvenance } from './bill-360.types.js';

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

/** Evidence tab — Sources & provenance rows + the "How to read evidence" legend. */
export function BillEvidenceTab({ provenance }: { provenance: DossierProvenance }) {
  return (
    <>
      <div className="dsr-card" style={{ padding: '16px 18px', marginBottom: 14 }}>
        <div className="dsr-ev-head">
          <span className="dsr-section-label" style={{ marginBottom: 0 }}>
            Sources & provenance
          </span>
          {provenance.lastSyncedAt ? (
            <span className="dsr-ev-synced">Last synced {fmtDate(provenance.lastSyncedAt)}</span>
          ) : null}
        </div>
        {provenance.sources.map((s, i) => {
          const b = evBadge(s.origin);
          return (
            <div className="dsr-source-row" key={i}>
              <Pill sev={b.sev}>{b.label}</Pill>
              <span className="dsr-source-label">
                <SourceLink label={s.label} url={s.url} />
              </span>
              <span className="dsr-source-as">{fmtDate(s.as)}</span>
              <FreshnessPill fresh={s.fresh} />
            </div>
          );
        })}
      </div>
      <div className="dsr-card" style={{ background: 'var(--bg-surface-2)' }}>
        <div className="dsr-section-label">How to read evidence</div>
        <div className="dsr-legend">
          {LEGEND.map((l) => (
            <div className="dsr-legend-row" key={l.label}>
              <Pill sev={l.sev}>{l.label}</Pill>
              <span className="dsr-legend-desc">{l.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
