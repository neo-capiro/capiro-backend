/**
 * The ONE versioned client profile that Funding Opportunities scores against.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before P01 there were three profile-building sites: `readClientFacts` in the
 * service, an inline block in the grant producer, and `buildSamProfileForClient`
 * in the SAM producer. Two of the three agreed by coincidence — `tags()` in the
 * grant producer and `stringTags()` inside `shapeClientRelevanceProfile` are
 * byte-identical implementations, so the grant profile matched.
 *
 * The third did not. The SAM producer resolved contract award history from
 * confirmed `contracting` mapping UEIs ONLY, while the read path also used the
 * client's own `Client.uei`. A client holding a UEI with no confirmed contracting
 * mapping therefore had prior-agency history on screen and none in the producer:
 * the page said "prior award history with DEPT OF THE NAVY" and the nightly job,
 * scoring the same client against the same notice, could not see it. Nothing was
 * going to catch that, because no test built both profiles from one fixture.
 *
 * THE SPLIT
 * ---------
 * `ClientProfileFacts` is what the database holds. `ClientOpportunityProfileV1`
 * is what scoring reads. The repository produces the first, the pure builder
 * turns it into the second, and nothing else is allowed to shape a profile.
 *
 * WHY VERSIONED
 * -------------
 * `version` and `fingerprint` exist so a later phase can tell whether a stored
 * score was computed against the profile the client has NOW. Read-time scoring
 * and background producers must consume the same version — that is a program
 * completion requirement, not a nicety, and an unversioned profile makes it
 * unprovable.
 */

import type { AwardMatchBasis } from './award-history-identity.js';
import type { ClientRelevanceProfile } from '../district-nexus/grant-opportunity-relevance.js';
import type { SamClientProfile } from './sam-opportunity-relevance.js';
import type { ProfileCompleteness } from './missing-profile-fields.js';

export const CLIENT_OPPORTUNITY_PROFILE_VERSION = 'v1' as const;
export type ClientOpportunityProfileVersion = typeof CLIENT_OPPORTUNITY_PROFILE_VERSION;

/**
 * A reviewed identity mapping that a reviewer has said contributes awards.
 *
 * The repository only ever returns rows already filtered to `confirmed: true`,
 * `reviewStatus: 'confirmed'` and `rollUpAwards: true`. That filtering is not
 * repeated here, and callers must not re-widen it: a mapping existing is not the
 * same as the money being the client's.
 */
export interface ProfileMapping {
  /**
   * MEANING DIFFERS BY RAIL, which is why P02 exists:
   *   - `contracting`: a `federal_contractor.id` UUID. NOT a UEI. The verified
   *     UEI lives in `federal_contractor.uei` and must be resolved.
   *   - `assistance_recipient`: `COALESCE(recipient_uei, recipient_name)`, so it
   *     is sometimes a UEI and sometimes a name.
   */
  externalId: string | null;
  externalName: string | null;
  /**
   * How the candidate was originally matched, in the contractor matcher's own
   * vocabulary: `exact_uei` | `exact_cage` | `exact_legal_name_corroborated` |
   * `exact_legal_name` | `fuzzy_name` | `manual_pin` | `legacy_unrecorded`.
   * Null on rows that predate the column. Gates the name fallback — see
   * `award-history-identity.ts`.
   */
  matchBasis: string | null;
  /** Identity tier 1-4 (1 = exact verified identifier, 4 = fuzzy name). */
  matchTier: number | null;
}

export interface ProfileCapability {
  name: string;
  /** `ClientCapability.tags` verbatim — Prisma `Json`, so genuinely unknown. */
  tags: unknown;
  keywords: string[];
  peNumbers: string[];
}

export interface ProfileFacility {
  id: string;
  /** `ClientFacility.name` is NOT NULL in the schema. */
  name: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  congressionalDistrict: string | null;
}

/** Tenant-scoped client facts, exactly as stored. No derivation, no defaults. */
export interface ClientProfileFacts {
  clientId: string;
  name: string | null;
  uei: string | null;
  cageCode: string | null;
  naicsCodes: string[];
  pscCodes: string[];
  applicantTypes: string[];
  setAsideCertifications: string[];
  sectorTag: string | null;
  capabilities: ProfileCapability[];
  facilities: ProfileFacility[];
  /** Confirmed `contracting` mappings with roll-up permitted. */
  contractingMappings: ProfileMapping[];
  /** Confirmed `assistance_recipient` mappings with roll-up permitted. */
  assistanceMappings: ProfileMapping[];
}

/**
 * What the global award tables returned for one client's identities, and under
 * which basis each rail was read.
 *
 * Contract and assistance history are kept SEPARATE. They come from different
 * mapping sources and different tables, and merging them would let a contracting
 * relationship contribute assistance history.
 */
export interface AwardHistoryFacts {
  assistanceListings: string[];
  assistanceAgencies: string[];
  contractAgencies: string[];
  /**
   * Always empty today. `federal_award` has no contracting-office column, and
   * `sam_opportunity.office` holds codes like `'0413 AQ HQ  RCO-HI'`. Feeding it
   * the awarding sub-tier created an office signal that could never fire and
   * surfaced agency names to users as "prior office" terms. Populate only when a
   * real office column exists.
   */
  contractOffices: string[];
  /**
   * How each rail's history was obtained. Absent on a hand-built empty history.
   *
   * This is the field that makes name-derived history distinguishable from
   * identifier-derived history downstream. Without it, `priorAgencies` is a bare
   * string list and nothing can tell a reader whether it came from a verified UEI
   * or from a reviewed name that another company also happens to have.
   */
  basis?: { contract: AwardMatchBasis; assistance: AwardMatchBasis };
}

/**
 * One client, shaped for scoring. Both rails are always present: a caller that
 * needs only one still gets a complete, comparable profile, which is what makes
 * the read path and the two producers checkable against each other.
 */
export interface ClientOpportunityProfileV1 {
  version: ClientOpportunityProfileVersion;
  clientId: string;
  /** Consumed by `scoreOpportunityRelevance` / `computeEligibility`. */
  grant: ClientRelevanceProfile;
  /** Consumed by `scoreSamOpportunityRelevance` / `computeSamEligibility`. */
  sam: SamClientProfile;
  /** Drives `missingProfileFields`. Not a score input. */
  completeness: ProfileCompleteness;
  /**
   * How this client's award history was identified, per rail.
   *
   * Carried on the profile so a consumer can say "prior award history with DEPT
   * OF THE NAVY, matched on your UEI" rather than presenting name-derived history
   * with identifier strength. P09 renders it; nothing scores differently on it
   * yet, and that is deliberate — changing signal strength is a scoring change
   * and does not belong in the same phase as the identity correction.
   */
  identityBasis: { contract: AwardMatchBasis; assistance: AwardMatchBasis };
  /**
   * Stable hash over SOURCE-BACKED profile content only — never a local clock,
   * never `completeness` (which is a derived count of the same facts). Two
   * callers holding the same client facts must produce the same fingerprint, and
   * a fingerprint that moved means a fact moved.
   */
  fingerprint: string;
}
