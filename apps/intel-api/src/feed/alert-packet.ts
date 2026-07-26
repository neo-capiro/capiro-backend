/**
 * §4.1 — the ONE Government Affairs Alert Packet every generator should receive instead
 * of a frontend-authored lossy summary (P1-13).
 *
 * The interface below is the audit's §4.1 shape VERBATIM — same field names, same order,
 * same optionality. Other work will be written against it, so it is a contract, not a
 * convenience type. Do not rename or reorder.
 *
 * Honesty rule: a field this service cannot populate is reported in
 * `confidence.missingFields`, never silently omitted. A packet that quietly drops what it
 * could not find is the P1-11 problem in a new place.
 */
export interface GovernmentAffairsAlertPacket {
  event: {
    sourceType: string;
    whatChanged: string;
    canonicalStatus: string | null;
    occurredAt: string | null;
    effectiveAt: string | null;
  };

  officialEvidence: Array<{
    claimId: string;
    text: string;
    sourceUrl?: string;
    sourceDocumentId?: string;
    page?: number;
    retrievedAt: string;
    verification: 'official' | 'verified' | 'extracted' | 'unverified';
  }>;

  proceduralMeaning: {
    currentStage: string;
    priorStage?: string;
    nextPossibleSteps: string[];
    blockedBy?: string[];
    deadline?: string;
    uncertainty: string[];
  };

  clientContext: {
    clientId: string;
    position?: 'support' | 'oppose' | 'monitor';
    priority?: 'low' | 'med' | 'high';
    matchedTopics: string[];
    capabilities: string[];
    activeStrategies: string[];
    redLines: string[];
    facilities: Array<{ state?: string; district?: string; employees?: number }>;
  };

  relationshipContext: {
    targetOffices: string[];
    existingRelationships: string[];
    recentMeetings: string[];
    openCommitments: string[];
  };

  actionContext: {
    recommendedOwner?: string;
    recommendedTargets: string[];
    recommendedActions: string[];
    actionWindow?: string;
  };

  confidence: {
    relevance: number;
    procedural: number;
    evidenceCoverage: number;
    missingFields: string[];
  };
}

/**
 * Fields this service structurally CANNOT populate, with the reason. They live in
 * apps/api (client Memory files, engagements, targets, facilities), not intel-api, and
 * reaching across the service boundary on this path was rejected in favour of an
 * honestly-incomplete packet (plan §6.1, option a). Every one of these is emitted as an
 * empty array/undefined AND listed in confidence.missingFields, so a consumer can tell
 * "we have nothing" apart from "there is nothing".
 */
export const PACKET_UNAVAILABLE_IN_INTEL_API = [
  'clientContext.capabilities',
  'clientContext.activeStrategies',
  'clientContext.redLines',
  'clientContext.facilities',
  'relationshipContext.targetOffices',
  'relationshipContext.existingRelationships',
  'relationshipContext.recentMeetings',
  'relationshipContext.openCommitments',
  'actionContext.recommendedOwner',
  'actionContext.recommendedTargets',
] as const;

/** §4 edge case 14: a full packet rides inside an outreach contextItem — cap it. */
export const MAX_OFFICIAL_EVIDENCE = 20;

/**
 * §4.6 / c-3's rule, restated here so the packet and the memo agree: an absolute http(s)
 * url is a public official record; a relative path is an internal deep link, which is
 * extracted data. NEVER 'verified' — nothing verifies these today.
 */
export function packetVerificationFor(
  url: string | null | undefined,
): 'official' | 'extracted' | 'unverified' {
  if (!url) return 'unverified';
  return /^https?:\/\//i.test(url) ? 'official' : 'extracted';
}
