/**
 * The pure half of the client profile: facts in, profile out, no I/O.
 *
 * Pure on purpose. Every scoring difference between the read path and the
 * producers before P01 came from the SHAPING step, not from the queries — so the
 * shaping is the part that has to be testable without a database, and the part a
 * parity test can call three times with one fixture.
 */

import { createHash } from 'node:crypto';
import { shapeClientRelevanceProfile } from '../district-nexus/grant-opportunity-candidates.js';
import type { ClientRelevanceProfile } from '../district-nexus/grant-opportunity-relevance.js';
import type { SamClientProfile } from './sam-opportunity-relevance.js';
import type { ProfileCompleteness } from './missing-profile-fields.js';
import type { AwardMatchBasis } from './award-history-identity.js';
import {
  CLIENT_OPPORTUNITY_PROFILE_VERSION,
  type AwardHistoryFacts,
  type ClientOpportunityProfileV1,
  type ClientProfileFacts,
} from './client-opportunity-profile.types.js';

/** Trim, drop empties, dedupe. Order-preserving. */
export function dedupeStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v && v.length > 0)),
  );
}

function stringTags(tags: unknown): string[] {
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
}

const UEI_RE = /^[A-Z0-9]{12}$/;

/** A UEI is 12 alphanumerics. Anything else is not an identifier we will query. */
export function normalizeUei(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  return UEI_RE.test(normalized) ? normalized : null;
}

export function emptyAwardHistory(): AwardHistoryFacts {
  return {
    assistanceListings: [],
    assistanceAgencies: [],
    contractAgencies: [],
    contractOffices: [],
    basis: { contract: 'none', assistance: 'none' },
  };
}

function buildGrantProfile(
  facts: ClientProfileFacts,
  history: AwardHistoryFacts,
): ClientRelevanceProfile {
  // Delegated, not reimplemented: District Nexus owns this shape and dedupes
  // every field internally. Reimplementing it here is how the two would drift
  // again, one dedupe at a time.
  return shapeClientRelevanceProfile({
    sectorTag: facts.sectorTag,
    capabilities: facts.capabilities.map((c) => ({ name: c.name, tags: c.tags })),
    facilityStates: facts.facilities.map((f) => f.state),
    priorAssistanceListings: history.assistanceListings,
    priorAgencies: history.assistanceAgencies,
    applicantTypes: facts.applicantTypes,
  });
}

function buildSamProfile(facts: ClientProfileFacts, history: AwardHistoryFacts): SamClientProfile {
  return {
    naicsCodes: facts.naicsCodes,
    pscCodes: facts.pscCodes,
    capabilityKeywords: dedupeStrings([
      ...facts.capabilities.map((c) => c.name),
      ...facts.capabilities.flatMap((c) => c.keywords ?? []),
      ...facts.capabilities.flatMap((c) => stringTags(c.tags)),
    ]),
    programElementCodes: dedupeStrings(facts.capabilities.flatMap((c) => c.peNumbers ?? [])),
    priorAgencies: history.contractAgencies,
    priorOffices: history.contractOffices,
    facilityStates: dedupeStrings(facts.facilities.map((f) => f.state)),
    // NOT deduped and NOT filtered: a site with a null city is still a state
    // match, and `facilitySites` is positional evidence rather than a term list.
    facilitySites: facts.facilities.map((f) => ({ city: f.city, state: f.state, zip: f.zip })),
    setAsideCertifications: facts.setAsideCertifications,
    sector: facts.sectorTag,
    applicantTypes: facts.applicantTypes,
  };
}

function buildCompleteness(
  facts: ClientProfileFacts,
  history: AwardHistoryFacts,
  programElementCount: number,
): ProfileCompleteness {
  return {
    clientId: facts.clientId,
    hasUei: Boolean(facts.uei),
    hasCageCode: Boolean(facts.cageCode),
    naicsCount: facts.naicsCodes.length,
    pscCount: facts.pscCodes.length,
    applicantTypeCount: facts.applicantTypes.length,
    capabilityCount: facts.capabilities.length,
    facilityCount: facts.facilities.length,
    hasSector: Boolean(facts.sectorTag),
    confirmedContractorMappings: facts.contractingMappings.length,
    priorAssistanceListingCount: dedupeStrings(history.assistanceListings).length,
    priorAgencyCount: dedupeStrings([...history.assistanceAgencies, ...history.contractAgencies])
      .length,
    programElementCount,
  };
}

/**
 * Canonical JSON with sorted keys, so a fingerprint depends on VALUES and not on
 * the order a JS object happened to be constructed in. Arrays keep their order —
 * their order is content.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Hash over source-backed scoring content only.
 *
 * `completeness` is excluded: it is a count of the same facts, so including it
 * would let the fingerprint move for a reason already covered. Local clocks are
 * excluded for the reason `source-lifecycle.ts` documents — hashing our own sync
 * timestamps makes the hash change on every ordinary re-sync, which is how an
 * amendment alert fired every night.
 */
export function profileFingerprint(input: {
  grant: ClientRelevanceProfile;
  sam: SamClientProfile;
  identityBasis?: { contract: AwardMatchBasis; assistance: AwardMatchBasis };
}): string {
  const canonical = JSON.stringify(canonicalize({ v: CLIENT_OPPORTUNITY_PROFILE_VERSION, ...input }));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 40);
}

/**
 * Build the profile. The only sanctioned way to produce a
 * `ClientOpportunityProfileV1`.
 */
export function buildClientOpportunityProfile(
  facts: ClientProfileFacts,
  history: AwardHistoryFacts,
): ClientOpportunityProfileV1 {
  const grant = buildGrantProfile(facts, history);
  const sam = buildSamProfile(facts, history);
  const identityBasis = history.basis ?? { contract: 'none', assistance: 'none' };
  return {
    version: CLIENT_OPPORTUNITY_PROFILE_VERSION,
    clientId: facts.clientId,
    grant,
    sam,
    completeness: buildCompleteness(facts, history, sam.programElementCodes.length),
    identityBasis,
    // The basis is part of the fingerprint: the same agency list reached via a
    // reviewed name is not the same evidence as one reached via a verified UEI,
    // and a profile whose basis changed has materially changed.
    fingerprint: profileFingerprint({ grant, sam, identityBasis }),
  };
}
