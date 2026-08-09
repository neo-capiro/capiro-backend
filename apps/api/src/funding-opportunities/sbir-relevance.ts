import type { MachineRecommendation, RecommendationConfidence } from './opportunity-recommendation.js';

/**
 * Funding Opportunities P43 — SBIR/STTR topic relevance for one client.
 *
 * ── WHAT CAN AND CANNOT FIRE, AND WHY ───────────────────────────────────────
 *
 * P43's spec names five things to match on: reviewed capabilities, PE/program
 * context, agency history, prior SBIR/STTR history when source-backed, and topic
 * keywords. Read against what `tango_sbir_topic` actually stores (P42) and what
 * `ClientProfileFacts`/`AwardHistoryFacts` actually carry, that collapses to
 * TWO live signals and two dormant ones — plus one item that turns out to be
 * two halves of the same comparison:
 *
 *   - `capabilityTopicMatch` — LIVE, and WEAK BY RULE. "Reviewed capabilities"
 *     and "topic keywords" are not two signals; they are the two SIDES of one
 *     comparison — the client's reviewed capability text against the topic's
 *     title. Declaring them separately would double-count one piece of evidence
 *     and let a single vocabulary coincidence look like two.
 *   - `priorAgencyHistory` — LIVE. The topic's `agency` against
 *     `AwardHistoryFacts.contractAgencies`. Meaningful only when the history was
 *     identifier-derived; see `historyIsIdentifierBacked`.
 *   - `programElementLinkedSourceBacked` — DORMANT. `tango_sbir_topic` has no
 *     program-element column and P42's mapper reads none, because the published
 *     contract carries none. `forecast-relevance.ts` has the same input LIVE
 *     because a forecast rail supplies it; nothing supplies it here. Declared
 *     anyway, and P43's acceptance ("PE link is evidence-bound") is enforced by
 *     the input's own contract: pass `true` ONLY for a source-backed link, never
 *     for a name or a keyword that looks like a program.
 *   - `priorSbirHistorySourceBacked` — DORMANT. Nothing in this schema stores a
 *     client's prior SBIR/STTR awards. `AwardHistoryFacts` carries contract and
 *     assistance agencies and assistance listings, none of which identifies an
 *     award as SBIR. P43's spec says "when source-backed", and today nothing is.
 *
 * NAICS and PSC are ABSENT ENTIRELY and are deliberately not inputs. The client
 * side has both; `tango_sbir_topic` has neither column, because the published
 * SBIR contract does not carry them. An input for it would be a parameter no
 * caller could ever populate from a stored row.
 *
 * The rule for a dormant signal is `forecast-relevance.ts`'s and
 * `dibbs-relevance.ts`'s: pass `false`, never a lookalike. The mistake being
 * avoided is recorded in `AwardHistoryFacts.contractOffices`, which was once fed
 * the awarding sub-tier because it was adjacent and available, producing a
 * signal that fired on the wrong fact.
 *
 * ── PHASE IS NOT PUBLISHED, AND THAT IS A FIELD, NOT A SILENCE ──────────────
 *
 * P43's spec says "distinguish Phase I/II/Direct-to-Phase-II/unknown". **There
 * is no phase field on either SBIR endpoint.** P42's migration header records
 * this; it is not a gap in the mapper.
 *
 * So phase is ALWAYS unknown, and that is reported as a first-class field —
 * `sbirPhaseGap` — rather than by omitting a phase from the output. The same
 * decision, for the same reason, as `dibbsPartProfileGap`: a UI that simply
 * showed no phase would let a reader assume one was evaluated and found
 * unremarkable. "The source does not publish a phase" is a different statement
 * from "this is a Phase I", and the caller has to be able to say which.
 *
 * Do not infer a phase from the topic title. "Direct to Phase II" appearing in
 * free text is the provider describing a topic, not a structured field, and a
 * regex over it would be exactly the lookalike this file refuses elsewhere.
 *
 * ── ELIGIBILITY IS NEVER ESTABLISHED HERE ───────────────────────────────────
 *
 * P43's acceptance: "Eligibility remains needs review unless structured facts
 * establish it." Nothing in this schema establishes SBIR eligibility. It turns
 * on US ownership, employee count, and — for STTR — a research-institution
 * partner, none of which is a structured fact Capiro holds.
 * `setAsideCertifications` is close enough to be tempting and is NOT the same
 * question: an SBA small-business certification is not a statement about the
 * SBIR size standard for this topic's NAICS.
 *
 * So `eligibility` is a constant `'needs_review'` with a reason naming what is
 * missing. It is a field rather than an omission for the same reason the phase
 * gap is.
 *
 * Pure and DB-free, like every scorer in this directory: every signal is a
 * boolean the caller establishes, and `asOf` is the caller's clock. No
 * `new Date()` in this module.
 */

export const SBIR_REASON_CODES = [
  'topic_closed',
  'client_profile_too_thin',
  'no_client_evidence',
  'prior_agency_history',
  'program_element_link',
  'prior_sbir_history',
  'capability_topic_match',
  'closing_imminent',
] as const;
export type SbirReasonCode = (typeof SBIR_REASON_CODES)[number];

/**
 * Why a phase could not be determined.
 *
 * One value today, and it is a fact about the SOURCE rather than about this
 * client or this topic. Kept as a vocabulary rather than a boolean so a later
 * phase that finds phase on a detail endpoint can add a value without changing
 * what this field means.
 */
export const SBIR_PHASE_GAPS = ['phase_not_published_by_source'] as const;
export type SbirPhaseGap = (typeof SBIR_PHASE_GAPS)[number];

/**
 * The four actions P43 names, as a closed vocabulary.
 *
 * Stated as a list rather than composed ad-hoc in each branch so a caller can
 * render them consistently and so no branch can invent a fifth — the same
 * posture `FORECAST_ACTIONS` takes for the forecast rail.
 *
 * Note what is NOT here: submitting anything. A topic is an invitation to
 * propose against a cycle, and the response goes through DSIP, not through
 * Capiro. An action vocabulary that implied submission would promise a surface
 * this program does not have.
 */
export const SBIR_ACTIONS = [
  'assess_fit',
  'confirm_small_business_and_partner_requirements',
  'contact_program_office',
  'prepare_white_paper',
] as const;
export type SbirAction = (typeof SBIR_ACTIONS)[number];

/** A topic's eligibility state. One value, deliberately — see the file doc. */
export const SBIR_ELIGIBILITY_STATES = ['needs_review'] as const;
export type SbirEligibilityState = (typeof SBIR_ELIGIBILITY_STATES)[number];

export interface SbirRelevanceInput {
  /**
   * The provider's own lifecycle word for the parent cycle, as stored. Null
   * means the provider stated none — never treated as closed, because an
   * absence of a statement is not a closure.
   */
  solicitationStatus: string | null;
  /** The topic's `closeDate` as ISO, or null. A calendar day, per P42's column. */
  closeDate: string | null;
  /** True when the client profile cannot support a judgement yet. */
  profileTooThin: boolean;
  /**
   * LIVE, and WEAK BY RULE: the client's reviewed capability text against the
   * topic's title. Cannot clear the suggestion floor alone — P43's acceptance
   * says generic innovation words must not.
   */
  capabilityTopicMatch: boolean;
  /** LIVE: the topic's agency against this client's prior CONTRACT agencies. */
  priorAgencyHistory: boolean;
  /**
   * Whether that agency history came from a verified identifier rather than a
   * reviewed name.
   *
   * A name-derived history is a weaker fact — another company can share a name —
   * so it is carried separately rather than folded into `priorAgencyHistory`.
   * `AwardHistoryFacts.basis` is where a caller reads this.
   */
  historyIsIdentifierBacked: boolean;
  /** DORMANT — no PE column on this source. See the file doc; pass `false`. */
  programElementLinkedSourceBacked: boolean;
  /** DORMANT — nothing stores a client's prior SBIR awards. See the file doc; pass `false`. */
  priorSbirHistorySourceBacked: boolean;
  /** The caller's clock. Never `new Date()` inside this module. */
  asOf: Date;
}

export interface SbirRelevanceResult {
  machineRecommendation: MachineRecommendation;
  /** Evidence quality. NEVER a probability of winning an award. */
  recommendationConfidence: RecommendationConfidence;
  primaryReason: string;
  primaryRisk: string | null;
  recommendedNextAction: string;
  /** The closed vocabulary a UI renders as controls. Empty on a closed topic. */
  actions: SbirAction[];
  reasonCodes: SbirReasonCode[];
  /**
   * Whether this topic is strong enough to manufacture a suggestion row for.
   * Stated, never inferred from `machineRecommendation` — they answer different
   * questions, and a producer that derived one from the other would silently
   * change behaviour the day this function's rule order changed.
   */
  clearsSuggestionFloor: boolean;
  /** ALWAYS set today. A fact about the source, not about the client. */
  sbirPhaseGap: SbirPhaseGap | null;
  /** ALWAYS `needs_review`, with `eligibilityReason` naming what is missing. */
  eligibility: SbirEligibilityState;
  eligibilityReason: string;
}

/** Days inside which a topic's close date is called imminent. */
export const SBIR_IMMINENT_CLOSING_DAYS = 14;

const ELIGIBILITY_REASON =
  'SBIR eligibility is not evaluated. It turns on US ownership, employee count and — for STTR — a ' +
  'research-institution partner, none of which Capiro holds as a structured fact. A small-business ' +
  'certification is not the same question as the SBIR size standard for this topic.';

const PHASE_GAP_REASON =
  'The source publishes no phase for this topic, so none is shown. This is a gap in the published ' +
  'contract, not a judgement about the topic.';

/** UTC midnight of whatever instant this is. */
function startOfUtcDay(at: number): number {
  const on = new Date(at);
  return Date.UTC(on.getUTCFullYear(), on.getUTCMonth(), on.getUTCDate());
}

/**
 * CALENDAR days between two dates, not the instant delta.
 *
 * The same arithmetic, and the same reason, as `dibbs-relevance.ts`. `closeDate`
 * comes from a DATE column anchored at UTC midnight so "a topic closing on the
 * 4th is the 4th everywhere", while `asOf` is a real clock and in production is
 * essentially never midnight. Differencing raw instants makes a topic closing
 * TODAY come out at `floor(-0.5) = -1` at any time past midnight — closed, on
 * its final submittable day.
 *
 * That exact bug shipped in P41 part 1 and survived 28 tests, because every
 * fixture used a midnight `asOf` — the one clock value that makes the instant
 * arithmetic accidentally correct. Any test touching this function uses a
 * mid-day clock.
 */
function daysUntil(date: string | null, asOf: Date): number | null {
  if (!date) return null;
  const at = new Date(date).getTime();
  if (Number.isNaN(at)) return null;
  // Both operands are exact UTC midnights, so this division is exact.
  return Math.round((startOfUtcDay(at) - startOfUtcDay(asOf.getTime())) / 86_400_000);
}

/**
 * The provider's own status words that mean closed.
 *
 * Compared case-insensitively against a small closed set rather than by
 * substring: "Closed" and "Closing Soon" are different states, and a
 * `includes('clos')` test would read the second as the first and pass on a
 * topic that is still open.
 */
const CLOSED_STATUS_WORDS = new Set(['closed', 'archived', 'expired']);

/**
 * Closed means the provider SAID closed, or the close date has genuinely
 * passed.
 *
 * Both are checked because P42 stores the status as stated rather than deriving
 * it — a provider that still says Open on a topic that closed last month is not
 * a reason to invite a proposal, and a past date closes it regardless.
 */
export function isTopicClosed(input: {
  solicitationStatus: string | null;
  closeDate: string | null;
  asOf: Date;
}): boolean {
  const status = input.solicitationStatus?.trim().toLowerCase();
  if (status != null && CLOSED_STATUS_WORDS.has(status)) return true;
  const days = daysUntil(input.closeDate, input.asOf);
  return days != null && days < 0;
}

export function scoreSbirRelevance(input: SbirRelevanceInput): SbirRelevanceResult {
  const phaseGap: SbirPhaseGap = 'phase_not_published_by_source';
  const days = daysUntil(input.closeDate, input.asOf);
  const imminent = days != null && days >= 0 && days <= SBIR_IMMINENT_CLOSING_DAYS;

  const base = {
    sbirPhaseGap: phaseGap,
    eligibility: 'needs_review' as const,
    eligibilityReason: ELIGIBILITY_REASON,
  };

  // ── Rule 1: the topic is closed ─────────────────────────────────────────
  //
  // P43's acceptance: closed topics do not offer Pursue. Enforced structurally
  // here by returning NO actions at all — a caller with an empty list has
  // nothing to render, rather than a control it is trusted to hide.
  if (isTopicClosed(input)) {
    return {
      ...base,
      machineRecommendation: 'pass',
      recommendationConfidence: 'high',
      primaryReason: 'This topic is closed.',
      primaryRisk: null,
      recommendedNextAction:
        'No action. A closed topic is still useful as a read on what this agency is funding.',
      actions: [],
      reasonCodes: ['topic_closed'],
      clearsSuggestionFloor: false,
    };
  }

  // ── Rule 2: we cannot answer yet ────────────────────────────────────────
  if (input.profileTooThin) {
    return {
      ...base,
      machineRecommendation: 'needs_review',
      recommendationConfidence: 'low',
      primaryReason: 'The client profile is too thin for a fit judgement against this topic.',
      primaryRisk: null,
      recommendedNextAction: 'Complete the client profile, then re-review.',
      actions: ['assess_fit'],
      reasonCodes: ['client_profile_too_thin'],
      clearsSuggestionFloor: false,
    };
  }

  const codes: SbirReasonCode[] = [];
  if (input.programElementLinkedSourceBacked) codes.push('program_element_link');
  if (input.priorSbirHistorySourceBacked) codes.push('prior_sbir_history');
  if (input.priorAgencyHistory) codes.push('prior_agency_history');
  if (input.capabilityTopicMatch) codes.push('capability_topic_match');
  if (imminent) codes.push('closing_imminent');

  // A closing date is not evidence: every open topic has one.
  const substantive = codes.filter((code) => code !== 'closing_imminent');

  // ── Rule 3: nothing ties this topic to the client ───────────────────────
  if (substantive.length === 0) {
    return {
      ...base,
      machineRecommendation: 'pass',
      recommendationConfidence: 'high',
      primaryReason: "No evidence ties this topic to the client's recorded profile.",
      primaryRisk: null,
      recommendedNextAction:
        'No action. Recording reviewed capabilities, or a verified identifier that carries award history, is what makes this matchable rather than guessed.',
      actions: [],
      reasonCodes: ['no_client_evidence'],
      clearsSuggestionFloor: false,
    };
  }

  // ── Rule 4: a source-backed structural tie ──────────────────────────────
  //
  // A PE link or a prior SBIR award is a statement about THIS client and THIS
  // program, not a vocabulary coincidence. Both are dormant today, so this
  // branch is unreachable with current data — declared and tested anyway, the
  // same posture forecast-relevance takes for `exactPscMatch`.
  const structural =
    input.programElementLinkedSourceBacked || input.priorSbirHistorySourceBacked;
  if (structural) {
    return {
      ...base,
      machineRecommendation: 'pursue',
      recommendationConfidence:
        input.programElementLinkedSourceBacked && input.priorSbirHistorySourceBacked
          ? 'high'
          : 'medium',
      primaryReason: input.programElementLinkedSourceBacked
        ? 'A source-backed program-element link ties this topic to work this client is already in.'
        : 'A prior source-backed SBIR/STTR award ties this client to this program.',
      primaryRisk: imminentRisk(imminent, days),
      recommendedNextAction: imminent
        ? `Assess fit and start a white paper. The topic closes in ${dayPhrase(days)}.`
        : 'Assess fit, then contact the program office before drafting.',
      actions: [...SBIR_ACTIONS],
      reasonCodes: codes,
      clearsSuggestionFloor: true,
    };
  }

  // ── Rule 5: agency history, with or without capability text ─────────────
  if (input.priorAgencyHistory) {
    // Identifier-backed history is a fact about this client. Name-derived
    // history is a fact about a NAME, which another company can share — so it
    // is worth showing and not worth manufacturing a suggestion from.
    const strong = input.historyIsIdentifierBacked;
    return {
      ...base,
      machineRecommendation: 'monitor',
      recommendationConfidence: strong ? 'medium' : 'low',
      primaryReason: strong
        ? "This client has prior contract history with the topic's agency."
        : "Prior history with the topic's agency, matched on a reviewed NAME rather than a verified identifier.",
      primaryRisk: imminentRisk(imminent, days),
      recommendedNextAction: strong
        ? 'Assess fit and contact the program office to test the topic against current work.'
        : "Confirm the client's identifiers so this history can be verified rather than inferred from a name.",
      actions: strong
        ? ['assess_fit', 'contact_program_office', 'confirm_small_business_and_partner_requirements']
        : ['assess_fit'],
      reasonCodes: codes,
      clearsSuggestionFloor: strong,
    };
  }

  // ── Rule 6: capability text alone ───────────────────────────────────────
  //
  // P43's acceptance, stated directly: generic innovation words cannot clear
  // the floor alone. "We do autonomy" against a topic titled "Autonomous
  // sustainment diagnostics" is a coincidence of vocabulary, not evidence this
  // client can execute THIS topic — worth showing, not worth suggesting.
  return {
    ...base,
    machineRecommendation: 'monitor',
    recommendationConfidence: 'low',
    primaryReason:
      "The topic's title matches the client's capability text, which is a vocabulary match and not evidence of program fit.",
    primaryRisk: imminentRisk(imminent, days),
    recommendedNextAction:
      'Assess fit with the client before investing in a white paper — a keyword match is not a program fit.',
    actions: ['assess_fit'],
    reasonCodes: codes,
    clearsSuggestionFloor: false,
  };
}

function dayPhrase(days: number | null): string {
  return days == null ? 'under two weeks' : `${days} day${days === 1 ? '' : 's'}`;
}

function imminentRisk(imminent: boolean, days: number | null): string | null {
  if (!imminent) return null;
  return `The topic closes in ${dayPhrase(days)}, which is short for a white paper.`;
}

/** The phase gap's own sentence, exported so a UI renders the reasoning rather than reinventing it. */
export function describeSbirPhaseGap(gap: SbirPhaseGap | null): string | null {
  return gap == null ? null : PHASE_GAP_REASON;
}
