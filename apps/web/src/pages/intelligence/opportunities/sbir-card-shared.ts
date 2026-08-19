/**
 * UI-free types, labels and description rules for the SBIR/STTR topic card.
 *
 * Extracted from SbirOpportunityCard.tsx (Phase 2 vNext port, extraction
 * pattern): the vNext presentation renders the same facts under the same
 * absence rules, and importing the antd card file from `src/vnext/**` would
 * ship legacy UI to os.capiro.ai. The card file re-exports everything here, so
 * its public API is unchanged.
 *
 * The honesty rules these carry are documented on the card component. The two
 * enforced here:
 *
 *   - `describeSbirCycle` keeps "the source states no cycle" (a fact about the
 *     SOURCE) and "Capiro does not hold this cycle" (a fact about CAPIRO'S
 *     SYNC) as two different sentences, never merged into "Unknown".
 *   - `sbirProgramLabel` returns null rather than a guess when the cycle is
 *     absent: SBIR and STTR differ in whether a research partner is required,
 *     and labelling a topic "SBIR" because the rail is mostly SBIR would be
 *     asserting the absence of that requirement.
 */

/** The stored topic facts the card renders. Mirrors `tango_sbir_topic`. */
export interface SbirTopicFacts {
  /** The public number a human cites, e.g. `A26-001`. Distinct from the provider's row id. */
  topicNumber: string | null;
  title: string | null;
  /** The provider's single `agency` field. Never split into agency/component. */
  agency: string | null;
  year: number | null;
  /** The parent cycle as STATED. Null means the source named none. */
  solicitationNumber: string | null;
  releaseDate: string | null;
  openDate: string | null;
  closeDate: string | null;
  /** The provider's own lifecycle word, as stated. Never rewritten. */
  solicitationStatus: string | null;
  topicUrl: string | null;
  /** May point at DSIP. Rendered as a link, never parsed for an identifier. */
  officialSolicitationUrl: string | null;
}

/**
 * The parent cycle, when Capiro holds it. Mirrors `tango_sbir_solicitation`.
 *
 * Null on the card's props means the cycle is NOT held — which is a different
 * statement from the topic naming none.
 */
export interface SbirCycleFacts {
  solicitationNumber: string;
  cycleName: string | null;
  /** `'SBIR' | 'STTR'` as the provider spells it. The ONLY place that distinction lives. */
  program: string | null;
  year: number | null;
  startDate: string | null;
  endDate: string | null;
  solicitationStatus: string | null;
  solDownloadUrl: string | null;
}

/** Mirrors SbirAction in apps/api's sbir-relevance.ts. */
export type SbirAction =
  | 'assess_fit'
  | 'confirm_small_business_and_partner_requirements'
  | 'contact_program_office'
  | 'prepare_white_paper';

/**
 * The label for each action.
 *
 * Note what none of them says: SUBMIT. A topic is an invitation to propose
 * against a cycle, and the response goes through DSIP rather than through
 * Capiro. A control labelled "Submit" would promise a surface this program does
 * not have.
 */
export const SBIR_ACTION_LABELS: Readonly<Record<SbirAction, string>> = Object.freeze({
  assess_fit: 'Assess fit',
  confirm_small_business_and_partner_requirements: 'Confirm eligibility requirements',
  contact_program_office: 'Contact the program office',
  prepare_white_paper: 'Prepare a white paper',
});

/**
 * How the card describes the parent cycle. Exported so the test asserts the
 * same function the card renders, rather than a re-implementation of the rule.
 */
export function describeSbirCycle(
  facts: Pick<SbirTopicFacts, 'solicitationNumber'>,
  cycle: SbirCycleFacts | null,
): string {
  if (facts.solicitationNumber == null || facts.solicitationNumber === '') {
    // A fact about the SOURCE.
    return 'The source states no solicitation cycle for this topic';
  }
  if (cycle == null) {
    // A fact about CAPIRO'S SYNC. Deliberately not merged with the case above.
    return `${facts.solicitationNumber} — Capiro does not hold this cycle`;
  }
  const name = cycle.cycleName?.trim();
  return name ? `${cycle.solicitationNumber} · ${name}` : cycle.solicitationNumber;
}

/**
 * The program label, or null when it cannot be known.
 *
 * Returns null rather than a guess when the cycle is absent, because SBIR and
 * STTR differ in a way that matters to a reader: STTR requires a research
 * partner.
 */
export function sbirProgramLabel(cycle: SbirCycleFacts | null): string | null {
  const program = cycle?.program?.trim();
  return program ? program : null;
}
