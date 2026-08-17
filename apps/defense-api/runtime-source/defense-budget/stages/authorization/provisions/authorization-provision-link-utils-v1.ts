/** Phase 6 Workstream F — pure link/review identity helpers. */
import { sha256CanonicalJson, type JsonValue } from '../../../contracts/canonical-json.js';
import {
  type AuthorizationProvisionLinkV1,
  type AuthorizationProvisionReviewEntryV1,
  type AuthorizationProvisionTargetV1,
  type AuthorizationProvisionV1,
  type ProvisionReferenceV1,
} from './authorization-provision-v1.js';
import { targetKey, uniqueTargets } from './authorization-provision-targets-v1.js';

export function linkFor(
  provision: AuthorizationProvisionV1,
  target: AuthorizationProvisionTargetV1,
  status: 'accepted' | 'candidate',
  matchBasis: AuthorizationProvisionLinkV1['matchBasis'],
  confidence: number,
  reviewId?: string,
): AuthorizationProvisionLinkV1 {
  return {
    linkId: stableId('provision-link', {
      provisionId: provision.provisionId,
      target: targetKey(target),
      matchBasis,
    }),
    provisionId: provision.provisionId,
    target,
    status,
    matchBasis,
    confidence,
    evidenceIds: provision.evidenceIds,
    ...(provision.attributionCaveat != null
      ? { attributionCaveat: provision.attributionCaveat }
      : {}),
    ...(reviewId != null ? { reviewId } : {}),
  };
}

export function reviewEntry(
  provision: AuthorizationProvisionV1,
  status: AuthorizationProvisionReviewEntryV1['status'],
  reason: AuthorizationProvisionReviewEntryV1['reason'],
  message: string,
  reference: ProvisionReferenceV1 | undefined,
  targets: AuthorizationProvisionTargetV1[],
): AuthorizationProvisionReviewEntryV1 {
  return {
    reviewId: stableId('provision-review', {
      provisionId: provision.provisionId,
      status,
      reason,
      reference: reference ?? null,
      targets: targets.map(targetKey).sort(),
    }),
    provisionId: provision.provisionId,
    status,
    reason,
    message,
    ...(reference != null ? { reference } : {}),
    targets: uniqueTargets(targets),
    evidenceIds: provision.evidenceIds,
  };
}

export function sortLinks(links: AuthorizationProvisionLinkV1[]): AuthorizationProvisionLinkV1[] {
  const map = new Map<string, AuthorizationProvisionLinkV1>();
  for (const link of links) map.set(link.linkId, link);
  return [...map.values()].sort((a, b) => a.linkId.localeCompare(b.linkId));
}

/**
 * Stable IDs are content identities, not JavaScript insertion-order identities.
 *
 * `JSON.stringify` preserves object key insertion order, so two semantically
 * identical objects assembled in a different order could previously receive
 * different provision/review IDs. Phase 1's canonical JSON contract already
 * exists for exactly this class of replay defect; reuse it here rather than
 * maintaining a second hashing convention.
 */
export function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${sha256CanonicalJson(value as JsonValue)}`;
}
