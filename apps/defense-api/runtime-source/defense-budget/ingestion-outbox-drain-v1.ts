/**
 * Pure policy for the lifecycle ingestion outbox. Governed REVIEW/REJECT
 * outcomes reuse the migrated `dead_letter` state and remain distinguishable
 * through `metadata_jsonb.governedDisposition`; no new schema state is needed.
 */
import type { AuthorityTrack, SourceFamily } from '@capiro/defense-domain';
import type { ObservationIngestionBridgeResult } from './observation-ingestion-bridge.service.js';
import { routingForSourceFamily } from './parser-router/source-family-routing.js';
import {
  UNSUPPORTED_READINESS_TRACKS,
  type CycleFamilyReadinessIdentityV1,
  type ReadinessFamilyGroupV1,
} from './promotion/readiness/cycle-family-readiness-v1.js';

export {
  drainBackoffMsV1,
  drainFailureDispositionV1,
  isClaimableV1,
  isDrainEligibleV1,
  isStalledProcessingV1,
} from './promotion/promotion-outbox-drain-v1.js';

export const SUPPORTED_DRAIN_FAMILY_GROUPS_V1 = [
  'rdte',
  'procurement',
  'om',
  'milcon',
] as const satisfies readonly ReadinessFamilyGroupV1[];

export type IngestionBridgeDispositionV1 =
  | 'succeeded'
  | 'governed_review'
  | 'governed_reject'
  | 'retry';

export function ingestionOutboxDispositionForBridgeResultV1(
  result: ObservationIngestionBridgeResult,
): { disposition: IngestionBridgeDispositionV1; detail: string } {
  const detail = result.reason ?? result.status;
  if (result.ingestionSucceeded) return { disposition: 'succeeded', detail };
  if (result.status === 'review_required') return { disposition: 'governed_review', detail };
  if (
    ['verification_rejected', 'blocked', 'source_bytes_changed', 'rejected'].includes(result.status)
  ) {
    return { disposition: 'governed_reject', detail };
  }
  // Only downstream_failed is retryable. `already_ingested` normally
  // resolves as a successful replay; a contradictory false success flag is
  // safer to surface through bounded retries than silently quarantine.
  return { disposition: 'retry', detail };
}

export function readinessScopeForSucceededObservationV1(input: {
  classifiedSourceFamily: SourceFamily;
  authorityTrack: AuthorityTrack;
  fiscalYear: number;
}): CycleFamilyReadinessIdentityV1 | null {
  if (UNSUPPORTED_READINESS_TRACKS.includes(input.authorityTrack)) return null;
  const family = routingForSourceFamily(input.classifiedSourceFamily).family;
  const familyGroup: ReadinessFamilyGroupV1 | null =
    family === 'public_law'
      ? 'committee'
      : family === 'rdte' ||
          family === 'procurement' ||
          family === 'om' ||
          family === 'milcon' ||
          family === 'committee'
        ? family
        : null;
  return familyGroup
    ? { fiscalYear: input.fiscalYear, authorityTrack: input.authorityTrack, familyGroup }
    : null;
}
