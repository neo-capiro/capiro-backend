interface GroundingCitation {
  n: number;
  type?: string;
  id?: string;
  title?: string;
  url?: string | null;
  snippet?: string | null;
  tool?: string;
}

interface GroundingVerification {
  totalCount: number;
  unsupportedCount: number;
}

interface GroundingCaveat {
  topSeverity?: string | null;
  findings: unknown[];
}

export interface MeriGroundingStatementInput {
  citations: GroundingCitation[];
  verification: GroundingVerification | null;
  groundingCaveat: GroundingCaveat | null;
}

/**
 * Product-safe, server-authored statement of an assistant turn's evidence state.
 * It deliberately summarizes only persisted/streamed facts; it never infers
 * grounding from prose or a selected client.
 */
export function buildMeriGroundingStatement({
  citations,
  verification,
  groundingCaveat,
}: MeriGroundingStatementInput): string {
  if (groundingCaveat?.findings.length) {
    const count = groundingCaveat.findings.length;
    return `Grounding review flagged ${count} issue${count === 1 ? '' : 's'}. Verify the cited evidence before relying on this answer.`;
  }

  const sourceCount = citations.length;
  if (sourceCount === 0) return 'No retrieved sources were attached to this answer.';

  const sources = `Grounded in ${sourceCount} retrieved source${sourceCount === 1 ? '' : 's'}`;
  if (!verification?.totalCount) return `${sources}.`;

  if (verification.unsupportedCount > 0) {
    return `${sources}; ${verification.unsupportedCount} of ${verification.totalCount} claims could not be tied to a retrieved source.`;
  }
  return `${sources}; ${verification.totalCount} claims were checked against retrieved sources.`;
}
