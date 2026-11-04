import type {
  EntityResolutionCandidate,
  CanonicalEntityRecord,
} from '../knowledge/entities/entity-resolution.types.js';
import {
  identityName,
  identityDomain,
  identityScore,
  type ProfileIdentityInput,
  type DiscoveredProfileIdentity,
  type ProfileIdentitySourceCandidate,
  type ProfileIdentityClaim,
} from './profile-identity.contracts.js';

export interface DisplayIdentity {
  entity: {
    id: string | null;
    canonicalName: string;
    entityType: string;
    metadata: Record<string, unknown>;
  };
  confidence: number;
  resolutionMethod: string;
  reasons: string[];
  provenance: unknown[];
  sourceCandidate?: ProfileIdentitySourceCandidate;
  claims?: ProfileIdentityClaim[];
  evidence?: DiscoveredProfileIdentity['evidence'];
}

export function canonicalIdentityCandidates(
  rows: EntityResolutionCandidate[],
  input: ProfileIdentityInput,
): DisplayIdentity[] {
  return rows.map((row) => {
    const exact =
      row.resolutionMethod === 'identifier_exact' &&
      row.provenance.some(
        (provenance) =>
          provenance.identifierType &&
          (!['domain', 'official_domain'].includes(provenance.identifierType) ||
            identityName(row.entity.canonicalName) === identityName(input.name)),
      );
    return { ...row, confidence: exact ? row.confidence : Math.min(row.confidence, 0.8) };
  });
}
export function mergeIdentityCandidate(
  candidates: DisplayIdentity[],
  input: ProfileIdentityInput,
  item: DiscoveredProfileIdentity,
  entity: CanonicalEntityRecord | null,
) {
  const row: DisplayIdentity = {
    entity: entity ?? {
      id: null,
      canonicalName: item.sourceCandidate.name,
      entityType: 'organization',
      metadata: {
        state: item.state ?? null,
        city: item.city ?? null,
        website: item.sourceCandidate.website ?? null,
      },
    },
    confidence: identityScore(input, item),
    resolutionMethod: 'source_candidate',
    reasons: item.evidence.map((evidence) => evidence.excerpt),
    provenance: item.evidence,
    sourceCandidate: item.sourceCandidate,
    claims: item.claims,
    evidence: item.evidence,
  };
  const prior = candidates.find((candidate) =>
    entity
      ? candidate.entity.id === entity.id
      : (candidate.sourceCandidate?.externalId === item.sourceCandidate.externalId ||
          (candidate.sourceCandidate?.source === 'website' &&
            item.sourceCandidate.source === 'website' &&
            identityDomain(candidate.sourceCandidate.website) !== null &&
            identityDomain(candidate.sourceCandidate.website) ===
              identityDomain(item.sourceCandidate.website))) &&
        identityName(candidate.entity.canonicalName) === identityName(item.sourceCandidate.name),
  );
  if (prior) {
    prior.confidence = Math.max(prior.confidence, row.confidence);
    prior.sourceCandidate ??= row.sourceCandidate;
    prior.claims = [
      ...new Map(
        [...(prior.claims ?? []), ...(row.claims ?? [])].map((claim) => [
          JSON.stringify(claim),
          claim,
        ]),
      ).values(),
    ];
    prior.evidence = [...(prior.evidence ?? []), ...(row.evidence ?? [])];
  } else candidates.push(row);
}
