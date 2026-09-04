import { MeriIcon } from './meri-icons.js';
import { useMeriGovernedMemoryQueues } from './MeriMemoryTab.js';

interface MeriMemoryCalloutProps {
  onOpenMemory: () => void;
}

/**
 * A queue-status callout only. The API does not associate a specific memory
 * candidate with a specific assistant answer, so this never claims that the
 * answer used or created a particular memory.
 */
export function MeriMemoryCallout({ onOpenMemory }: MeriMemoryCalloutProps) {
  const { reviewCount, pendingProposalCount, review, proposals } = useMeriGovernedMemoryQueues();
  if (review.isLoading || proposals.isLoading) return null;
  if (reviewCount === 0 && pendingProposalCount === 0) return null;

  const title =
    reviewCount > 0
      ? reviewCount + ' institutional memory ' + (reviewCount === 1 ? 'change needs' : 'changes need') + ' your review'
      : pendingProposalCount + ' memory ' + (pendingProposalCount === 1 ? 'proposal is' : 'proposals are') + ' awaiting review';

  return (
    <button
      type="button"
      className="vnext-meri__memory-callout"
      onClick={onOpenMemory}
      aria-label="Open institutional memory"
    >
      <span className="vnext-meri__memory-callout-icon">
        <MeriIcon name="Save01" size={17} color="#363F72" />
      </span>
      <span className="vnext-meri__memory-callout-copy">
        <span className="vnext-meri__memory-callout-label">INSTITUTIONAL MEMORY</span>
        <span className="vnext-meri__memory-callout-value">{title}</span>
      </span>
      <MeriIcon name="ChevronRight" size={14} color="#667085" />
    </button>
  );
}
