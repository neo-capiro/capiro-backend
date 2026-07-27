/**
 * District Nexus — pure, I/O-free relevance-profile shaping.
 *
 * Both `DistrictNexusService.buildClientRelevanceProfile` (the per-client read
 * path) and `generate-grant-opportunity-candidates.ts` (the batch producer)
 * need the SAME client-relevance-profile shape from the SAME kind of rows, but
 * fetch those rows differently (one client vs. many, in a loop). Pulling the
 * shaping logic here means it is written and tested once, not duplicated and
 * left to drift between the read path and the producer.
 */
import type { ClientRelevanceProfile } from './grant-opportunity-relevance.js';

/** Already-fetched rows; a caller assembles these however its own query shape allows. */
export interface ClientRelevanceProfileRows {
  sectorTag: string | null;
  capabilities: Array<{ name: string; tags: unknown }>;
  facilityStates: Array<string | null>;
  priorAssistanceListings: Array<string | null>;
  priorAgencies: Array<string | null>;
}

function dedupeStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v && v.length > 0)),
  );
}

/** `ClientCapability.tags` is a JSON column, not a native string array — never assume the shape. */
function stringTags(tags: unknown): string[] {
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
}

/**
 * Shape a `ClientRelevanceProfile` from already-fetched rows. Every field is a
 * FACT about the client, never an inference — an empty profile is honest, and
 * `scoreOpportunityRelevance` scores over the weight that COULD match, so a
 * thin profile yields a low-confidence score, not a fabricated one.
 */
export function shapeClientRelevanceProfile(
  rows: ClientRelevanceProfileRows,
): ClientRelevanceProfile {
  return {
    sector: rows.sectorTag,
    capabilityKeywords: dedupeStrings([
      ...rows.capabilities.map((c) => c.name),
      ...rows.capabilities.flatMap((c) => stringTags(c.tags)),
    ]),
    priorAssistanceListings: dedupeStrings(rows.priorAssistanceListings),
    priorAgencies: dedupeStrings(rows.priorAgencies),
    // No applicant-type column exists on Client today. Honestly empty, which
    // computeEligibility reports as needs_review — never as eligible.
    applicantTypes: [],
    states: dedupeStrings(rows.facilityStates),
    knownPartnerNames: [],
  };
}
