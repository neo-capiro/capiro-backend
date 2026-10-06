import type { FundingBlock } from '../../../pages/bills/bill-360.types.js';
import { CapiroEmptyState } from '../../components/feedback/index.js';
import { FundingPositionTable } from './dossier-primitives.js';
import { BillImpactDraft } from './BillImpactDraft.js';

const IMPACT_NOTE =
  'Match basis shows whether a line was linked by an explicit Program Element code (auto-accepted) or inferred from title / semantics (analyst-reviewed). Authorization and appropriation figures are never coalesced.';

/**
 * Impact tab — vNext re-skin of pages/bills/BillImpactTab.tsx: the standalone
 * Program-Element table (same collection as Funding).
 */
export function BillImpactTab({
  funding,
  onOpenPe,
  billId,
  clientId,
}: {
  funding: FundingBlock;
  onOpenPe: (pe: string) => void;
  billId?: string;
  clientId?: string | null;
}) {
  const rows = funding.programElementImpacts;
  if (!rows.length) {
    return (
      <>
        {billId && <BillImpactDraft billId={billId} clientId={clientId} />}
        <div className="b360-empty">
          <CapiroEmptyState title="No Program Element or procurement-line impacts linked to this bill." />
          {!billId && (
            <p>
              A client-specific impact assessment is not available here. Review the bill’s published
              text and your client’s priorities before drawing an impact conclusion.
            </p>
          )}
        </div>
      </>
    );
  }
  return (
    <>
      {billId && <BillImpactDraft billId={billId} clientId={clientId} />}
      <p>
        These are documented funding links. They do not establish a client-specific impact
        assessment.
      </p>
      <FundingPositionTable
        title="Program Element & procurement-line impacts"
        count={rows.length}
        rows={rows}
        onOpenPe={onOpenPe}
      />
      <div className="b360-impact-note">{IMPACT_NOTE}</div>
    </>
  );
}
