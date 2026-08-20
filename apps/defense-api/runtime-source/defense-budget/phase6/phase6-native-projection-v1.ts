/** Phase 6 Workstream N — unified noncanonical native stage projection contract. */
import { z } from 'zod';
import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';
import {
  fundingFieldV1Schema,
  moneyValueV1Schema,
  sha256Schema,
} from '../contracts/extraction-artifact-v1.js';
import { stageTrackV1Schema, stageV1Schema, STAGE_TRACK } from '../stages/stage-vocabulary-v1.js';

const nonBlank = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: 'must be nonblank',
});

export const PHASE6_PROJECTION_KIND_VALUES = [
  'vehicle_proof',
  'native_line_binding',
  'stage_position',
  'stage_action',
  'provision_link',
  'enactment_proof',
  'post_enactment_metric',
] as const;
export const phase6ProjectionKindV1Schema = z.enum(PHASE6_PROJECTION_KIND_VALUES);

export const PHASE6_PROJECTION_STATUS_VALUES = [
  'candidate',
  'verified',
  'blocked',
  'superseded',
] as const;
export const phase6ProjectionStatusV1Schema = z.enum(PHASE6_PROJECTION_STATUS_VALUES);

const expectedFieldByStage = {
  hasc: 'hascMark',
  sasc: 'sascMark',
  ndaa_conference: 'ndaaConference',
  hac_d: 'hacDMark',
  sac_d: 'sacDMark',
  appropriations_conference: 'conference',
  public_law: 'enacted',
  continuing_resolution: 'enacted',
  reprogramming: 'reprogrammed',
  execution: 'executed',
} as const;

const EXECUTION_METRICS = new Set([
  'obligations',
  'outlays',
  'expenditures',
  'disbursements',
  'commitments',
  'reviewed_other',
]);

export const phase6NativeProjectionV1Schema = z
  .object({
    schemaVersion: z.literal('phase6_native_projection_v1'),
    projectionId: nonBlank,
    naturalKey: nonBlank,
    idempotencyKey: nonBlank,
    projectionKind: phase6ProjectionKindV1Schema,
    verificationCandidateId: nonBlank,
    verificationRunId: nonBlank,
    artifactId: nonBlank,
    artifactContentSha256: sha256Schema,
    sourceDocumentId: nonBlank,
    sourcePdfSha256: sha256Schema,
    sourceProfileHash: sha256Schema,
    nativeIdentityHash: sha256Schema,
    track: stageTrackV1Schema,
    stage: stageV1Schema,
    fundingField: fundingFieldV1Schema.optional(),
    money: moneyValueV1Schema.optional(),
    directOrDerived: z.enum(['direct', 'derived', 'not_applicable']),
    evidenceIds: z.array(nonBlank),
    bindingStatus: z.enum(['accepted', 'candidate', 'unresolved', 'conflicting', 'not_applicable']),
    projectionStatus: phase6ProjectionStatusV1Schema,
    enactmentProofId: nonBlank.optional(),
    supersedesProjectionId: nonBlank.optional(),
    payload: z.record(z.union([z.string(), z.number().int(), z.boolean(), z.null()])),
    canonicalWriteAllowed: z.literal(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (STAGE_TRACK[value.stage] !== value.track) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `stage ${value.stage} does not belong to track ${value.track}`,
        path: ['track'],
      });
    }
    if (value.projectionKind === 'stage_position') {
      if (value.fundingField == null || value.money == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'stage_position requires fundingField and money',
          path: ['fundingField'],
        });
      } else if (expectedFieldByStage[value.stage] !== value.fundingField) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `stage ${value.stage} may only own ${expectedFieldByStage[value.stage]}`,
          path: ['fundingField'],
        });
      }
    }
    if (
      value.projectionStatus === 'verified' &&
      value.projectionKind === 'stage_position' &&
      value.bindingStatus !== 'accepted'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'verified stage position requires accepted native binding',
        path: ['bindingStatus'],
      });
    }
    if (
      value.projectionKind === 'stage_position' &&
      value.fundingField === 'enacted' &&
      value.enactmentProofId == null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'enacted stage position requires enactmentProofId',
        path: ['enactmentProofId'],
      });
    }
    if (
      value.projectionKind === 'stage_position' &&
      value.stage === 'continuing_resolution' &&
      value.payload.explicitLineAuthority !== true
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'continuing resolution cannot become a line-level enacted position without explicit line authority',
        path: ['payload', 'explicitLineAuthority'],
      });
    }
    if (value.projectionKind === 'stage_position' && value.stage === 'reprogramming') {
      const basis = value.payload.revisedTotalBasis;
      if (basis !== 'explicit_after' && basis !== 'policy_derived') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'reprogrammed position requires explicit_after or policy_derived revised-total basis',
          path: ['payload', 'revisedTotalBasis'],
        });
      }
    }
    if (value.projectionKind === 'stage_position' && value.stage === 'execution') {
      if (typeof value.payload.executionMetric !== 'string' || !EXECUTION_METRICS.has(value.payload.executionMetric)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'executed position requires an explicit supported execution metric',
          path: ['payload', 'executionMetric'],
        });
      }
      if (typeof value.payload.asOfDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.payload.asOfDate)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'executed position requires an as-of date',
          path: ['payload', 'asOfDate'],
        });
      }
      if (typeof value.payload.cumulative !== 'boolean') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'executed position requires explicit cumulative versus period semantics',
          path: ['payload', 'cumulative'],
        });
      }
    }
  });
export type Phase6NativeProjectionV1 = z.infer<typeof phase6NativeProjectionV1Schema>;

export function phase6ProjectionIdV1(identity: JsonValue): string {
  return `p6proj_${sha256CanonicalJson(identity)}`;
}

export function phase6ProjectionContentHashV1(projection: Phase6NativeProjectionV1): string {
  return sha256CanonicalJson(projection as unknown as JsonValue);
}
