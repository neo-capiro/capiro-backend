/**
 * The Government Landscape packet (Funding Opportunities P33).
 *
 * ── What this is, and what it deliberately is not ────────────────────────────
 *
 * A DETERMINISTIC EVIDENCE PACKET: the Capiro-proprietary government-affairs
 * context that applies to one client-opportunity pair. Program Elements,
 * budget movement, facilities and districts, reviewed relationships.
 *
 * It is not an analysis, not a summary and not a model output. Every item is a
 * pointer to something Capiro already holds, with the identifier needed to go
 * look at it. There is no LLM anywhere in this phase and no generic web
 * research — the plan says so and the composer's own spec proves it
 * structurally.
 *
 * ── Verified and inferred are different things, and stay different ───────────
 *
 * {@link LandscapeBasis} is the single most load-bearing field in this file.
 *
 *   `source_backed`  the link exists because a source states it: a verbatim PE
 *                    code in the notice text that a REVIEWED match accepted, a
 *                    facility address the client recorded, a relationship a
 *                    human confirmed.
 *   `inferred`       the link exists because two things resemble each other.
 *
 * An inferred item is never presented as verified, never counted toward
 * confidence, and is excluded from every high-confidence action by
 * {@link isHighConfidenceItem}. That is the plan's own line — "a PE link cannot
 * be created from keyword similarity alone unless labelled inferred and
 * excluded from high-confidence actions" — and it is enforced by the type
 * rather than by the renderer remembering.
 *
 * ── Missing sources lower COVERAGE. They never create a negative claim ───────
 *
 * A source Capiro cannot read yet contributes a `not_wired` entry to
 * {@link LandscapePacket.sources} and nothing else. It does not contribute an
 * empty section that reads as "there are no hearings on this", because that is
 * a claim about Congress and this packet cannot support one.
 */

export const LANDSCAPE_BASES = ['source_backed', 'inferred'] as const;
export type LandscapeBasis = (typeof LANDSCAPE_BASES)[number];

/**
 * Every source the packet draws on, whether or not it is wired yet.
 *
 * Declared in full so an unwired source is a VISIBLE gap rather than a section
 * that silently does not exist.
 */
export const LANDSCAPE_SOURCES = [
  'program_element',
  'budget_movement',
  'client_facility',
  'congressional_district',
  'legislation',
  'hearing',
  'regulation',
  'committee',
  'acquisition_personnel',
  'reviewed_relationship',
  'client_priority',
] as const;
export type LandscapeSource = (typeof LANDSCAPE_SOURCES)[number];

/**
 * Whether a source contributed, and why not when it did not.
 *
 *   `available`   read, and its items (if any) are in the packet.
 *   `empty`       read, and it holds nothing for this pair. A real finding.
 *   `not_wired`   Capiro does not read this source yet. NOT a finding — the
 *                 distinction from `empty` is the whole point of having two
 *                 values.
 *   `denied`      the reader may not see it (ethical wall). Reported without
 *                 saying what was withheld.
 */
export const LANDSCAPE_SOURCE_STATES = ['available', 'empty', 'not_wired', 'denied'] as const;
export type LandscapeSourceState = (typeof LANDSCAPE_SOURCE_STATES)[number];

export interface LandscapeItem {
  source: LandscapeSource;
  /** The source's own identifier. What a reader uses to go look. */
  sourceId: string;
  /** One line, composed from facts. Never a judgement. */
  label: string;
  /** How the link was established. See {@link LandscapeBasis}. */
  basis: LandscapeBasis;
  /**
   * The exact value that connected the two things — a PE code, a state, a
   * district key. Never a paraphrase, for the same reason
   * `OpportunityMatchedSignal.matchedOn` is verbatim: the point is that an
   * operator can go check it.
   */
  matchedOn: string;
  /** A citation URL, or an internal evidence reference. Null when neither exists. */
  evidenceRef: string | null;
  /** When the underlying fact was last observed. Null when the source states none. */
  asOf: string | null;
}

export interface LandscapeSourceReport {
  source: LandscapeSource;
  state: LandscapeSourceState;
  /** Items contributed. Zero for every state but `available`. */
  itemCount: number;
  /** Why the state is what it is, in a sentence. Never a claim about the world. */
  explanation: string;
}

export interface LandscapePacket {
  clientId: string;
  source: string;
  sourceRecordId: string;
  /** Deterministically ordered — see `orderLandscapeItems`. */
  items: LandscapeItem[];
  sources: LandscapeSourceReport[];
  /**
   * Sources that CONTRIBUTED, over sources that COULD contribute once wired.
   * A coverage number, never a confidence score: a packet can be 100% covered
   * and contain nothing, which means Capiro looked everywhere it can and found
   * no connection — a real and useful finding.
   */
  coverage: { available: number; wired: number; declared: number };
  /**
   * Stable hash over the ordered items. Two composers holding the same facts
   * produce the same hash, so a change in the packet means a change in the
   * FACTS rather than in the ordering.
   */
  fingerprint: string;
  generatedAt: string;
}
