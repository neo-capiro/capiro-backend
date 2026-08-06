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
  externalId: string | null;
  externalName: string | null;
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
 * The identity sets used to query the global award tables.
 *
 * Contract and assistance identities are kept SEPARATE. They come from different
 * mapping sources and are compared against different tables, and merging them
 * would let a contracting relationship contribute assistance history.
 *
 * P02 replaces the flat name arrays here with a labeled match basis. Until then
 * a name and a UEI are both in play for the same query, which is exactly the
 * weakness P02 exists to fix — see the note on `contractorNames`.
 */
export interface AwardHistoryIdentity {
  contractorUeis: string[];
  /**
   * Lowercased reviewed names. Currently OR'd with the UEI list in one SQL
   * predicate, so a same-name entity can contribute history even when an exact
   * UEI is present. P02 splits this into a labeled fallback.
   */
  contractorNames: string[];
  assistanceUeis: string[];
  assistanceNames: string[];
}

/** What the global award tables returned for one client's identities. */
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
   * Stable hash over SOURCE-BACKED profile content only — never a local clock,
   * never `completeness` (which is a derived count of the same facts). Two
   * callers holding the same client facts must produce the same fingerprint, and
   * a fingerprint that moved means a fact moved.
   */
  fingerprint: string;
}
