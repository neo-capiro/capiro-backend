/**
 * Phase 10B-1 repair — the only `CanonicalProjectionPort` implementation
 * wired today.
 *
 * Traced starting from `ParserRouterV1Service`'s terminal result: the real
 * canonical write path, `DefenseBudgetCanonicalPromotionServiceV1.execute`
 * (Phase 7 Workstream E), is unreachable from a single-observation bridge —
 * it plans and executes over an entire certified cycle/family, requires a
 * separately issued human `defense_budget_promotion_authorization_v1` bound
 * to that plan's hash, and runs under a `PROMOTER_DATABASE_URL` role the
 * serving API does not hold. No legitimate per-observation boundary exists.
 *
 * This adapter makes that gap explicit rather than silent: every call
 * deterministically refuses with
 * `PHASE10B1_BLOCKED_CANONICAL_PROJECTION_BOUNDARY_MISSING`, so
 * `ObservationIngestionBridgeService` can never report overall success for
 * an observation whose bytes were merely parsed/verified but never actually
 * promoted into canonical Defense Budget data.
 */
import { Injectable } from '@nestjs/common';
import { PHASE10B1_BLOCKED_CANONICAL_PROJECTION_BOUNDARY_MISSING } from '@capiro/defense-domain';
import type {
  CanonicalProjectionInput,
  CanonicalProjectionOutcome,
  CanonicalProjectionPort,
} from './observation-ingestion-bridge.ports.js';

@Injectable()
export class Phase10B1CanonicalProjectionBoundaryMissingAdapter implements CanonicalProjectionPort {
  async project(input: CanonicalProjectionInput): Promise<CanonicalProjectionOutcome> {
    return {
      succeeded: false,
      reason:
        `${PHASE10B1_BLOCKED_CANONICAL_PROJECTION_BOUNDARY_MISSING}: no legitimate per-observation ` +
        `canonical-projection boundary exists from a verified SourceDocument (sourceDocumentId=` +
        `${input.sourceDocumentId}) to a canonical Defense Budget write; ` +
        'DefenseBudgetCanonicalPromotionServiceV1.execute requires a whole-cycle promotion plan, a ' +
        'separately issued human authorization, and the PROMOTER_DATABASE_URL role, none of which a ' +
        'single-observation bridge invocation can supply',
    };
  }
}
