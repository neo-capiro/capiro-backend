import { EvidenceBadge } from '../../components/dossier/EvidenceBadge.js';
import type { FundingProvision } from './bill-360.types.js';

/** Provisions tab — funding-provision cards with provenance badges. */
export function BillProvisionsTab({ provisions }: { provisions: FundingProvision[] }) {
  if (!provisions.length) {
    return <div className="dsr-empty">No funding provisions identified for this bill.</div>;
  }
  return (
    <div className="dsr-prov-list">
      {provisions.map((p, i) => (
        <div className="dsr-prov-card" key={p.sec ?? i}>
          <div className="dsr-prov-head">
            {p.sec ? <span className="dsr-prov-sec">{p.sec}</span> : null}
            <span className="dsr-prov-title">{p.title}</span>
            <EvidenceBadge origin={p.origin} />
          </div>
          {p.summary ? <p className="dsr-prov-summary">{p.summary}</p> : null}
          {p.source ? <div className="dsr-prov-source">{p.source}</div> : null}
        </div>
      ))}
    </div>
  );
}
