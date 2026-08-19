/**
 * UI-free types and formatting rules for the DLA bid-board card.
 *
 * Extracted from DibbsOpportunityCard.tsx (Phase 2 vNext port, extraction
 * pattern): the vNext presentation renders the same facts under the same
 * absence rules, and importing the antd card file from `src/vnext/**` would
 * ship legacy UI to os.capiro.ai. The card file re-exports everything here, so
 * its public API is unchanged.
 *
 * The rules these helpers carry are documented on the card component; the two
 * that matter here:
 *
 *   - An RFP states no quantity BY DOCUMENT TYPE ("Not stated on a request for
 *     proposal"); only the RFQ case is a source gap ("Not stated by the
 *     source"). One sentence for both would tell a reader that a specific RFP
 *     failed to state something it was never going to state.
 *   - A quantity whose unit of issue is missing is treated as unstated, not
 *     guessed: 500 of an unknown unit is not 500.
 */

/** The stored DIBBS solicitation facts the card renders. Mirrors `tango_dibbs_solicitation`. */
export interface DibbsSolicitationFacts {
  /** `'rfq' | 'rfp'`. An award is not a value here — awards have their own row component. */
  documentType: 'rfq' | 'rfp';
  solicitation: string;
  /** The provider's own display spelling, when it gave one. Never parsed. */
  solicitationFormatted: string | null;
  nsn: string | null;
  partNumber: string | null;
  nomenclature: string | null;
  /** RFQ only, exact decimal as a string. Never a float — see the mapper. */
  quantity: string | null;
  /** RFQ only. The unit `quantity` is counted in. */
  unitOfIssue: string | null;
  /** RFQ only. */
  setAside: string | null;
  /** RFP only. */
  buyerCode: string | null;
  closesDate: string | null;
  /** The provider's own judgement. `null` says nothing and is rendered as nothing. */
  isOpen: boolean | null;
  documentUrl: string | null;
  /** RFP only. */
  techDocsUrl: string | null;
}

/** What `describeDibbsAwardIntelligence` returned for a prior award on this item. */
export interface DibbsAwardContext {
  awardNumber: string;
  awardeeLegalBusinessName: string | null;
  isOwnAward: boolean;
  /** True when the numeric price is absent, whatever the display text says. */
  priceIsUnknown: boolean;
  /** The provider's own rendering, kept verbatim. May exist while the numeric price does not. */
  totalContractPriceText: string | null;
  awardDate: string | null;
}

/**
 * Quantity and unit as one phrase, or the reason there isn't one.
 *
 * Exported so the test asserts the same function the card renders, rather than
 * a re-implementation of the rule that could drift from it.
 */
export function formatDibbsQuantity(facts: DibbsSolicitationFacts): string {
  if (facts.documentType === 'rfp') return 'Not stated on a request for proposal';
  if (facts.quantity == null || facts.quantity === '') return 'Not stated by the source';
  // A quantity without its unit should be impossible; treated as unstated, not guessed.
  if (facts.unitOfIssue == null || facts.unitOfIssue === '') return 'Not stated by the source';
  return `${facts.quantity} ${facts.unitOfIssue}`;
}

/** The line-item identity, or an explicit statement that the provider gave none. */
export function formatDibbsPartIdentity(facts: DibbsSolicitationFacts): string {
  const parts: string[] = [];
  if (facts.nsn) parts.push(`NSN ${facts.nsn}`);
  if (facts.partNumber) parts.push(`Part ${facts.partNumber}`);
  if (parts.length === 0) return 'No NSN or part number stated';
  return parts.join(' · ');
}
