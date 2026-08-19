import type { FundingProvision } from '../../../pages/bills/bill-360.types.js';
import { CapiroEmptyState } from '../../components/feedback/index.js';
import { EvidenceBadge } from './dossier-primitives.js';

/**
 * Provisions tab — vNext re-skin of pages/bills/BillProvisionsTab.tsx:
 * funding-provision cards with provenance badges.
 */
export function BillProvisionsTab({ provisions }: { provisions: FundingProvision[] }) {
  if (!provisions.length) {
    return (
      <div className="b360-empty">
        <CapiroEmptyState title="No funding provisions identified for this bill." />
      </div>
    );
  }
  return (
    <div className="b360-prov-list">
      {provisions.map((p, i) => (
        <div className="b360-prov-card" key={p.sec ?? i}>
          <div className="b360-prov-head">
            {p.sec ? <span className="b360-prov-sec">{p.sec}</span> : null}
            <span className="b360-prov-title">{p.title}</span>
            <EvidenceBadge origin={p.origin} />
          </div>
          {p.summary ? <p className="b360-prov-summary">{p.summary}</p> : null}
          {p.source ? <div className="b360-prov-source">{p.source}</div> : null}
        </div>
      ))}
    </div>
  );
}
