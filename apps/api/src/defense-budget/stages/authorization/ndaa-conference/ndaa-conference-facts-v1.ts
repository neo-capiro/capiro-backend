/** Phase 6 Workstream G — vehicle proof and printed chamber-position facts. */
import { z } from 'zod';
import {
  budgetLineIdentityV1Schema,
  moneyValueV1Schema,
  sha256Schema,
} from '../../../contracts/extraction-artifact-v1.js';

export const NDAA_CONFERENCE_VEHICLE_PROOF_FIELD = 'ndaa_conference_vehicle_proof_v1' as const;
export const NDAA_CONFERENCE_CHAMBER_POSITIONS_FIELD =
  'ndaa_conference_chamber_positions_v1' as const;
export const NDAA_CONFERENCE_VEHICLE_PROOF_SCHEMA_VERSION =
  'ndaa_conference_vehicle_proof_v1' as const;
export const NDAA_CONFERENCE_CHAMBER_POSITIONS_SCHEMA_VERSION =
  'ndaa_conference_chamber_positions_v1' as const;

const nonBlank = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: 'must be nonblank',
});

const sourceProofSchema = z
  .object({
    manifestDocumentKey: nonBlank,
    sourceDocumentId: nonBlank,
    sourceSha256: sha256Schema,
    vehicleClass: z.enum(['conference_report', 'joint_explanatory_statement']),
  })
  .strict();

export const ndaaConferenceVehicleProofV1Schema = z
  .object({
    schemaVersion: z.literal(NDAA_CONFERENCE_VEHICLE_PROOF_SCHEMA_VERSION),
    track: z.literal('authorization'),
    stage: z.literal('ndaa_conference'),
    authority: z.literal('ndaa_conference_authorization'),
    fiscalYear: z.number().int().min(1900).max(2200),
    billIds: z.array(nonBlank).min(1),
    reportNumber: nonBlank,
    primary: sourceProofSchema.extend({ vehicleClass: z.literal('conference_report') }).strict(),
    jointExplanatoryStatement: sourceProofSchema
      .extend({ vehicleClass: z.literal('joint_explanatory_statement') })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.billIds).size !== value.billIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'billIds must be unique' });
    }
  });
export type NdaaConferenceVehicleProofV1 = z.infer<typeof ndaaConferenceVehicleProofV1Schema>;

const printedPositionSchema = z
  .object({
    status: z.literal('PRINTED'),
    money: moneyValueV1Schema,
    evidenceIds: z.array(nonBlank).min(1),
  })
  .strict();
const notPrintedSchema = z.object({ status: z.literal('NOT_PRINTED') }).strict();
const chamberPositionSchema = z.discriminatedUnion('status', [printedPositionSchema, notPrintedSchema]);
const conferencePositionSchema = z.discriminatedUnion('status', [
  printedPositionSchema,
  z
    .object({
      status: z.literal('DERIVED'),
      money: moneyValueV1Schema,
      baseline: moneyValueV1Schema,
      change: moneyValueV1Schema,
      evidenceIds: z.array(nonBlank).min(1),
    })
    .strict(),
]);

export const ndaaConferenceChamberPositionsV1Schema = z
  .object({
    schemaVersion: z.literal(NDAA_CONFERENCE_CHAMBER_POSITIONS_SCHEMA_VERSION),
    stage: z.literal('ndaa_conference'),
    authority: z.literal('ndaa_conference_authorization'),
    identity: budgetLineIdentityV1Schema,
    fiscalYear: z.number().int().min(1900).max(2200),
    house: chamberPositionSchema,
    senate: chamberPositionSchema,
    conference: conferencePositionSchema,
    requestBaseline: moneyValueV1Schema.optional(),
    change: moneyValueV1Schema.optional(),
    evidenceIds: z.array(nonBlank).min(1),
  })
  .strict();
export type NdaaConferenceChamberPositionsV1 = z.infer<
  typeof ndaaConferenceChamberPositionsV1Schema
>;

export function parseNdaaConferenceVehicleProofV1(value: unknown): NdaaConferenceVehicleProofV1 {
  return ndaaConferenceVehicleProofV1Schema.parse(value);
}

export function parseNdaaConferenceChamberPositionsV1(
  value: unknown,
): NdaaConferenceChamberPositionsV1 {
  return ndaaConferenceChamberPositionsV1Schema.parse(value);
}
