import { FundingPositionTable } from '../../components/dossier/FundingPositionTable.js';
import type { FundingBlock } from './bill-360.types.js';

const IMPACT_NOTE =
  'Match basis shows whether a line was linked by an explicit Program Element code (auto-accepted) or inferred from title / semantics (analyst-reviewed). Authorization and appropriation figures are never coalesced.';

/** Impact tab — the standalone Program-Element table (same collection as Funding). */
export function BillImpactTab({
  funding,
  onOpenPe,
}: {
  funding: FundingBlock;
  onOpenPe: (pe: string) => void;
}) {
  const rows = funding.programElementImpacts;
  if (!rows.length) {
    return (
      <div className="dsr-empty">
        No Program Element or procurement-line impacts linked to this bill.
      </div>
    );
  }
  return (
    <>
      <FundingPositionTable
        title="Program Element & procurement-line impacts"
        count={rows.length}
        rows={rows}
        onOpenPe={onOpenPe}
      />
      <div className="dsr-impact-note">{IMPACT_NOTE}</div>
    </>
  );
}
