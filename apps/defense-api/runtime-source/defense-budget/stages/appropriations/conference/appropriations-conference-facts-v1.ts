/** Phase 6 Workstream K — exact appropriations conference vehicle/chamber facts. */
import { z } from 'zod';
import {
  budgetLineIdentityV1Schema,
  moneyValueV1Schema,
  sha256Schema,
} from '../../../contracts/extraction-artifact-v1.js';
import { appropriationsConferenceStructureV1Schema } from './appropriations-conference-source-profile-v1.js';

const nonBlank = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: 'must be nonblank',
});

export const APPROPRIATIONS_CONFERENCE_VEHICLE_PROOF_FIELD =
  'appropriations_conference_vehicle_proof_v1' as const;
export const APPROPRIATIONS_CONFERENCE_CHAMBER_POSITIONS_FIELD =
  'appropriations_conference_chamber_positions_v1' as const;

const sourceProofSchema = z
  .object({
    manifestDocumentKey: nonBlank,
    sourceDocumentId: nonBlank,
    sourceSha256: sha256Schema,
    vehicleClass: z.enum(['conference_report', 'joint_explanatory_statement']),
    current: z.literal(true),
  })
  .strict();

export const appropriationsConferenceVehicleProofV1Schema = z
  .object({
    schemaVersion: z.literal('appropriations_conference_vehicle_proof_v1'),
    track: z.literal('appropriations'),
    stage: z.literal('appropriations_conference'),
    authority: z.literal('appropriations_conference'),
    fiscalYear: z.number().int().min(1900).max(2200),
    billId: nonBlank,
    reportNumber: nonBlank.optional(),
    vehicleStructure: appropriationsConferenceStructureV1Schema,
    division: nonBlank.optional(),
    title: nonBlank.optional(),
    primary: sourceProofSchema,
    jointExplanatoryStatement: sourceProofSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.primary.vehicleClass !== 'conference_report') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'appropriations conference primary source must be a conference_report',
        path: ['primary', 'vehicleClass'],
      });
    }
    if (
      value.jointExplanatoryStatement != null &&
      value.jointExplanatoryStatement.vehicleClass !== 'joint_explanatory_statement'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'conference companion must be a joint_explanatory_statement',
        path: ['jointExplanatoryStatement', 'vehicleClass'],
      });
    }
  });
export type AppropriationsConferenceVehicleProofV1 = z.infer<
  typeof appropriationsConferenceVehicleProofV1Schema
>;

const printedPositionSchema = z
  .object({ status: z.literal('PRINTED'), money: moneyValueV1Schema })
  .strict();
const notPrintedSchema = z.object({ status: z.literal('NOT_PRINTED') }).strict();
const positionSchema = z.discriminatedUnion('status', [printedPositionSchema, notPrintedSchema]);

export const appropriationsConferenceChamberPositionsV1Schema = z
  .object({
    schemaVersion: z.literal('appropriations_conference_chamber_positions_v1'),
    identity: budgetLineIdentityV1Schema,
    fiscalYear: z.number().int().min(1900).max(2200),
    hacd: positionSchema,
    sacd: positionSchema,
    conference: printedPositionSchema,
    evidenceIds: z.array(nonBlank).min(1),
  })
  .strict();
export type AppropriationsConferenceChamberPositionsV1 = z.infer<
  typeof appropriationsConferenceChamberPositionsV1Schema
>;
