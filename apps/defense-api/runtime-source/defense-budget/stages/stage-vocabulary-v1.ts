/**
 * Phase 6 Workstream A — shared stage vocabulary.
 *
 * Strict enum vocabularies for the congressional / conference / enacted /
 * post-enactment lifecycle: tracks, stages, authorities, vehicle classes,
 * chambers, and the funding field owned by each authority.
 *
 * These are the only values Phase 6 may combine, and every combination is
 * validated by the stage source profile — a caller can never select an
 * arbitrary target funding field.
 */
import { z } from 'zod';
import type { FundingFieldV1 } from '../contracts/extraction-artifact-v1.js';

/* ------------------------------------------------------------------ */
/* tracks                                                              */
/* ------------------------------------------------------------------ */

export const STAGE_TRACK_V1_VALUES = ['authorization', 'appropriations', 'post_enactment'] as const;
export const stageTrackV1Schema = z.enum(STAGE_TRACK_V1_VALUES);
export type StageTrackV1 = z.infer<typeof stageTrackV1Schema>;

/* ------------------------------------------------------------------ */
/* stages                                                              */
/* ------------------------------------------------------------------ */

export const STAGE_V1_VALUES = [
  'hasc',
  'sasc',
  'ndaa_conference',
  'hac_d',
  'sac_d',
  'appropriations_conference',
  'public_law',
  'continuing_resolution',
  'reprogramming',
  'execution',
] as const;
export const stageV1Schema = z.enum(STAGE_V1_VALUES);
export type StageV1 = z.infer<typeof stageV1Schema>;

/* ------------------------------------------------------------------ */
/* authorities                                                         */
/* ------------------------------------------------------------------ */

export const STAGE_AUTHORITY_V1_VALUES = [
  'hasc_authorization',
  'sasc_authorization',
  'ndaa_conference_authorization',
  'hacd_appropriations',
  'sacd_appropriations',
  'appropriations_conference',
  'enacted_public_law',
  'continuing_resolution',
  'reprogramming',
  'execution',
] as const;
export const stageAuthorityV1Schema = z.enum(STAGE_AUTHORITY_V1_VALUES);
export type StageAuthorityV1 = z.infer<typeof stageAuthorityV1Schema>;

/* ------------------------------------------------------------------ */
/* vehicle classes                                                     */
/* ------------------------------------------------------------------ */

export const STAGE_VEHICLE_CLASS_V1_VALUES = [
  'committee_report',
  'conference_report',
  'joint_explanatory_statement',
  'public_law',
  'continuing_resolution',
  'reprogramming_action',
  'execution_report',
] as const;
export const stageVehicleClassV1Schema = z.enum(STAGE_VEHICLE_CLASS_V1_VALUES);
export type StageVehicleClassV1 = z.infer<typeof stageVehicleClassV1Schema>;

/* ------------------------------------------------------------------ */
/* chambers                                                            */
/* ------------------------------------------------------------------ */

export const STAGE_CHAMBER_V1_VALUES = ['house', 'senate', 'joint', 'none'] as const;
export const stageChamberV1Schema = z.enum(STAGE_CHAMBER_V1_VALUES);
export type StageChamberV1 = z.infer<typeof stageChamberV1Schema>;

/* ------------------------------------------------------------------ */
/* authority -> owned funding field                                    */
/* ------------------------------------------------------------------ */

/**
 * Each authority owns exactly one canonical funding field. This mapping is
 * fixed: Phase 6 emitters derive the field from the authority, and
 * verification rejects any assertion whose field disagrees. A caller can
 * never choose a different target field.
 */
export const STAGE_AUTHORITY_FIELD: Record<StageAuthorityV1, FundingFieldV1> = {
  hasc_authorization: 'hascMark',
  sasc_authorization: 'sascMark',
  ndaa_conference_authorization: 'ndaaConference',
  hacd_appropriations: 'hacDMark',
  sacd_appropriations: 'sacDMark',
  appropriations_conference: 'conference',
  enacted_public_law: 'enacted',
  continuing_resolution: 'enacted',
  reprogramming: 'reprogrammed',
  execution: 'executed',
};

/**
 * Track ownership of every stage. Authorization stages must never populate
 * appropriations fields and vice versa; NDAA conference and appropriations
 * conference remain distinct.
 */
export const STAGE_TRACK: Record<StageV1, StageTrackV1> = {
  hasc: 'authorization',
  sasc: 'authorization',
  ndaa_conference: 'authorization',
  hac_d: 'appropriations',
  sac_d: 'appropriations',
  appropriations_conference: 'appropriations',
  public_law: 'appropriations',
  continuing_resolution: 'appropriations',
  reprogramming: 'post_enactment',
  execution: 'post_enactment',
};

/** Chamber that publishes each stage, when applicable. */
export const STAGE_CHAMBER: Record<StageV1, StageChamberV1> = {
  hasc: 'house',
  sasc: 'senate',
  ndaa_conference: 'joint',
  hac_d: 'house',
  sac_d: 'senate',
  appropriations_conference: 'joint',
  public_law: 'none',
  continuing_resolution: 'none',
  reprogramming: 'none',
  execution: 'none',
};

/**
 * Funding fields that a track may NEVER own. Enforcement lives in
 * validateStageSourceProfileV1; this table is the declaration.
 */
export const TRACK_FORBIDDEN_FIELDS: Record<StageTrackV1, readonly FundingFieldV1[]> = {
  authorization: ['hacDMark', 'sacDMark', 'conference', 'enacted', 'reprogrammed', 'executed'],
  appropriations: ['hascMark', 'sascMark', 'ndaaConference', 'reprogrammed', 'executed'],
  post_enactment: ['hascMark', 'sascMark', 'hacDMark', 'sacDMark', 'ndaaConference', 'conference'],
};
