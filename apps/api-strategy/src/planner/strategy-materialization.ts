// Exact owner implementation lives in the pure shared server-contract codec.
import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { plannerCalendarDate } from '@capiro/strategy-verifier';
import { digest } from '../meri/objective-generation.types.js';
import { canonicalRegenerationHash } from './canonical-regeneration-plan.js';
import { createPlannerMaterializationCodec, MATERIALIZATION_ERRORS, type MaterializationIssue } from '@capiro/shared/objective-planner-owner-codec';
export { STRATEGY_MATERIALIZATION_RECEIPT, CANONICAL_MATERIALIZATION_RECEIPT, MATERIALIZATION_ERRORS, MATERIALIZATION_ISSUES, CANONICAL_MATERIALIZATION_ISSUES } from '@capiro/shared/objective-planner-owner-codec';
export type { MaterializationInput, MaterializationIssue, MaterializationSource, MaterializationOutput, MaterializationResult, StoredMaterialization, CanonicalMaterializationBinding, StoredCanonicalMaterializationV2, CanonicalMaterializationIssue, CanonicalMaterializationResult, CanonicalRegenerationWitness, StoredCanonicalMaterializationV3, StoredCanonicalMaterialization, CanonicalMaterializationPredecessor, MaterializationOutputResolver } from '@capiro/shared/objective-planner-owner-codec';

export function materializationError(
  code: keyof typeof MATERIALIZATION_ERRORS,
  requestId: string | null,
  recordedAttempt: true | null = null,
  issues: MaterializationIssue[] = [],
): never {
  const [httpStatus, message] = MATERIALIZATION_ERRORS[code];
  throw new HttpException(
    {
      httpStatus,
      code,
      requestId,
      message,
      outcome: recordedAttempt ? 'recorded' : 'unconfirmed',
      recordedAttempt,
      issues,
    },
    httpStatus,
  );
}

const codec = createPlannerMaterializationCodec({ digest, canonicalRegenerationHash, plannerCalendarDate, materializationError,
  sha256: value => createHash('sha256').update(value, 'utf8').digest('hex') });
export const { materializationIssue, materializationUuid, parseMaterialization, materializationReceiptId, parseCanonicalMaterializationBinding, canonicalMaterializationReceiptId, canonicalMaterializationFingerprint, materializationProjectDescription, canonicalRegenerationPrevious, canonicalRegenerationWitness, canonicalRegenerationResult, requireCanonicalMaterializationSource, materializationOutputResolver, materializationOutputId, materializationResult, checkedMaterialization, checkedCanonicalMaterialization, materializationPlan } = codec;
