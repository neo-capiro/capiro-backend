/**
 * Phase 6 Workstream A — DefenseBudgetStageSourceProfileV1.
 *
 * One strict, hashed, human-reviewed profile governs every Phase 6 source
 * document. The profile fixes track, stage, authority, fiscal year, vehicle
 * class, chamber, legislative identifiers, companion-document requirements,
 * required line families, table semantics policy, declared units, required
 * comparison stages, enactment-proof requirements, absence policy, and (for
 * execution sources) the exact execution metric.
 *
 * Hard rules encoded here:
 *   - the owned funding field derives from authority; callers never choose it;
 *   - impossible track/stage/authority/vehicle combinations fail before
 *     parsing (semantic validation throws);
 *   - request baselines printed in later-stage tables are comparison data only
 *     and never transfer request ownership;
 *   - public-law profiles require enactment proof;
 *   - execution profiles require an explicit metric and as-of policy.
 */
import { z } from 'zod';
import { fundingFieldV1Schema, type FundingFieldV1 } from '../contracts/extraction-artifact-v1.js';
import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';
import {
  stageAuthorityV1Schema,
  stageChamberV1Schema,
  stageTrackV1Schema,
  stageV1Schema,
  stageVehicleClassV1Schema,
  STAGE_AUTHORITY_FIELD,
  STAGE_CHAMBER,
  STAGE_TRACK,
  TRACK_FORBIDDEN_FIELDS,
  type StageAuthorityV1,
  type StageChamberV1,
  type StageTrackV1,
  type StageV1,
  type StageVehicleClassV1,
} from './stage-vocabulary-v1.js';

export const DEFENSE_BUDGET_STAGE_SOURCE_PROFILE_SCHEMA_VERSION =
  'defense_budget_stage_source_profile_v1' as const;

/* ------------------------------------------------------------------ */
/* line families required per stage                                    */
/* ------------------------------------------------------------------ */

export const STAGE_LINE_FAMILY_V1_VALUES = [
  'rdte_pe',
  'procurement_blin',
  'om_sag',
  'milcon_project',
  'general_provisions',
  'classified',
] as const;
export const stageLineFamilyV1Schema = z.enum(STAGE_LINE_FAMILY_V1_VALUES);
export type StageLineFamilyV1 = z.infer<typeof stageLineFamilyV1Schema>;

/* ------------------------------------------------------------------ */
/* table semantics policy                                              */
/* ------------------------------------------------------------------ */

export const TABLE_SEMANTICS_POLICY_V1_VALUES = [
  /** Headers must name every money column; no positional selection. */
  'header_required',
  /** A table may carry only totals; per-row change semantics forbidden. */
  'totals_only',
  /** Narrative tables; no money assertions allowed. */
  'narrative_only',
] as const;
export const tableSemanticsPolicyV1Schema = z.enum(TABLE_SEMANTICS_POLICY_V1_VALUES);
export type TableSemanticsPolicyV1 = z.infer<typeof tableSemanticsPolicyV1Schema>;

/* ------------------------------------------------------------------ */
/* execution metric policy                                             */
/* ------------------------------------------------------------------ */

export const EXECUTION_METRIC_V1_VALUES = [
  'obligations',
  'outlays',
  'expenditures',
  'disbursements',
  'commitments',
  'reviewed_other',
] as const;
export const executionMetricV1Schema = z.enum(EXECUTION_METRIC_V1_VALUES);
export type ExecutionMetricV1 = z.infer<typeof executionMetricV1Schema>;

export const executionMetricPolicyV1Schema = z
  .object({
    /** The exact metric this source measures; ambiguity blocks `executed`. */
    metric: executionMetricV1Schema,
    /** As-of date is mandatory for every execution record. */
    requiresAsOfDate: z.literal(true),
    /** Period/end-of-year cumulative flag must be declared. */
    requiresCumulativeFlag: z.literal(true),
  })
  .strict();
export type ExecutionMetricPolicyV1 = z.infer<typeof executionMetricPolicyV1Schema>;

/* ------------------------------------------------------------------ */
/* enactment proof requirement                                         */
/* ------------------------------------------------------------------ */

export const ENACTMENT_PROOF_REQUIREMENT_V1_VALUES = [
  'not_required',
  'statutory_or_incorporated',
] as const;
export const enactmentProofRequirementV1Schema = z.enum(ENACTMENT_PROOF_REQUIREMENT_V1_VALUES);
export type EnactmentProofRequirementV1 = z.infer<typeof enactmentProofRequirementV1Schema>;

/* ------------------------------------------------------------------ */
/* companion document                                                  */
/* ------------------------------------------------------------------ */

export const stageCompanionDocumentV1Schema = z
  .object({
    companionKind: z.enum(['joint_explanatory_statement', 'public_law_text', 'other_reviewed']),
    manifestDocumentKey: z.string().min(1),
    required: z.boolean(),
  })
  .strict();
export type StageCompanionDocumentV1 = z.infer<typeof stageCompanionDocumentV1Schema>;

/* ------------------------------------------------------------------ */
/* the profile schema                                                  */
/* ------------------------------------------------------------------ */

export const defenseBudgetStageSourceProfileV1Schema = z
  .object({
    schemaVersion: z.literal(DEFENSE_BUDGET_STAGE_SOURCE_PROFILE_SCHEMA_VERSION),
    profileId: z.string().min(1),
    profileVersion: z.number().int().positive(),
    track: stageTrackV1Schema,
    stage: stageV1Schema,
    authority: stageAuthorityV1Schema,
    fiscalYear: z.number().int().min(1900).max(2200),
    vehicleClass: stageVehicleClassV1Schema,
    chamber: stageChamberV1Schema,
    billId: z.string().optional(),
    reportNumber: z.string().optional(),
    publicLawNumber: z.string().optional(),
    /** Keys of the primary source documents this profile governs. */
    sourceDocumentKeys: z.array(z.string().min(1)).min(1),
    /** Companion documents that must accompany the primary source. */
    companionDocuments: z.array(stageCompanionDocumentV1Schema).default([]),
    /** Line families the stage must cover (or explicitly certify absent). */
    requiredLineFamilies: z.array(stageLineFamilyV1Schema).min(1),
    tableSemanticsPolicy: tableSemanticsPolicyV1Schema,
    /** Units this source declares; magnitude inference is forbidden. */
    declaredUnits: z.array(z.enum(['dollars', 'thousands', 'millions'])).min(1),
    /** Stages this stage must compare against during certification. */
    requiredComparisonStages: z.array(stageV1Schema).default([]),
    enactmentProofRequirement: enactmentProofRequirementV1Schema,
    /** Whether a line may be absent from this stage (absent != zero). */
    absenceAllowed: z.boolean(),
    executionMetricPolicy: executionMetricPolicyV1Schema.optional(),
  })
  .strict();
export type DefenseBudgetStageSourceProfileV1 = z.infer<
  typeof defenseBudgetStageSourceProfileV1Schema
>;

/* ------------------------------------------------------------------ */
/* semantic validation                                                 */
/* ------------------------------------------------------------------ */

export interface StageProfileValidationResult {
  ok: boolean;
  errors: string[];
  /** The funding field this profile's authority owns (set when ok). */
  ownedField?: FundingFieldV1;
}

/**
 * Reject impossible combinations before parsing. Errors are deterministic and
 * enumerated so callers can fail closed with full context.
 */
export function validateStageSourceProfileV1(input: unknown): StageProfileValidationResult {
  const errors: string[] = [];

  const parsed = defenseBudgetStageSourceProfileV1Schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    };
  }
  const profile = parsed.data;

  /* -- track/stage/authority/chamber coherence ---------------------- */

  const expectedTrack: StageTrackV1 = STAGE_TRACK[profile.stage];
  if (profile.track !== expectedTrack) {
    errors.push(
      `stage '${profile.stage}' belongs to track '${expectedTrack}', not '${profile.track}'`,
    );
  }

  const expectedChamber: StageChamberV1 = STAGE_CHAMBER[profile.stage];
  if (profile.chamber !== expectedChamber) {
    errors.push(
      `stage '${profile.stage}' has chamber '${expectedChamber}', not '${profile.chamber}'`,
    );
  }

  /* -- stage/authority pairing -------------------------------------- */

  const stageAuthorityPairs: Record<StageV1, StageAuthorityV1> = {
    hasc: 'hasc_authorization',
    sasc: 'sasc_authorization',
    ndaa_conference: 'ndaa_conference_authorization',
    hac_d: 'hacd_appropriations',
    sac_d: 'sacd_appropriations',
    appropriations_conference: 'appropriations_conference',
    public_law: 'enacted_public_law',
    continuing_resolution: 'continuing_resolution',
    reprogramming: 'reprogramming',
    execution: 'execution',
  };
  const expectedAuthority = stageAuthorityPairs[profile.stage];
  if (profile.authority !== expectedAuthority) {
    errors.push(
      `stage '${profile.stage}' requires authority '${expectedAuthority}', got '${profile.authority}'`,
    );
  }

  /* -- vehicle class per stage -------------------------------------- */

  const allowedVehicles: Record<StageV1, readonly StageVehicleClassV1[]> = {
    hasc: ['committee_report'],
    sasc: ['committee_report'],
    ndaa_conference: ['conference_report', 'joint_explanatory_statement'],
    hac_d: ['committee_report'],
    sac_d: ['committee_report'],
    appropriations_conference: ['conference_report', 'joint_explanatory_statement'],
    public_law: ['public_law'],
    continuing_resolution: ['continuing_resolution'],
    reprogramming: ['reprogramming_action'],
    execution: ['execution_report'],
  };
  if (!allowedVehicles[profile.stage].includes(profile.vehicleClass)) {
    errors.push(`stage '${profile.stage}' forbids vehicle class '${profile.vehicleClass}'`);
  }

  /* -- ownership: field derives from authority ----------------------- */

  const ownedField: FundingFieldV1 = STAGE_AUTHORITY_FIELD[profile.authority];
  const forbidden = TRACK_FORBIDDEN_FIELDS[profile.track];
  if (forbidden.includes(ownedField)) {
    errors.push(`track '${profile.track}' cannot own funding field '${ownedField}'`);
  }

  /* -- stage-specific impossibility gates ---------------------------- */

  if (profile.stage === 'ndaa_conference' && profile.track === 'appropriations') {
    errors.push('NDAA conference can never map to the appropriations track');
  }
  if (profile.stage === 'public_law' && profile.authority !== 'enacted_public_law') {
    errors.push('public-law stage requires enacted_public_law authority');
  }

  /* -- enactment proof ------------------------------------------------ */

  if (
    (profile.stage === 'public_law' || profile.stage === 'continuing_resolution') &&
    profile.enactmentProofRequirement !== 'statutory_or_incorporated'
  ) {
    errors.push(
      `stage '${profile.stage}' requires enactmentProofRequirement 'statutory_or_incorporated'`,
    );
  }

  /* -- continuing resolutions are interim ----------------------------- */

  if (profile.stage === 'continuing_resolution' && profile.tableSemanticsPolicy !== 'totals_only') {
    errors.push(
      'continuing_resolution supports totals_only semantics only — a CR is never a full-year line-level enacted table',
    );
  }

  /* -- execution metric policy ---------------------------------------- */

  if (profile.stage === 'execution') {
    if (profile.executionMetricPolicy == null) {
      errors.push('execution stage requires an explicit executionMetricPolicy');
    } else if (profile.executionMetricPolicy.metric === 'reviewed_other') {
      errors.push(
        "execution metric 'reviewed_other' requires governed review before `executed` may be asserted",
      );
    }
  } else if (profile.executionMetricPolicy != null) {
    errors.push('executionMetricPolicy is only valid for the execution stage');
  }

  /* -- reprogramming must not claim a metric -------------------------- */

  if (profile.stage === 'reprogramming' && profile.executionMetricPolicy != null) {
    errors.push('reprogramming stage cannot carry an execution metric policy');
  }

  /* -- legislative identifiers ---------------------------------------- */

  if (
    (profile.stage === 'ndaa_conference' ||
      profile.stage === 'appropriations_conference' ||
      profile.stage === 'public_law') &&
    profile.billId == null &&
    profile.reportNumber == null &&
    profile.publicLawNumber == null
  ) {
    errors.push(
      `stage '${profile.stage}' requires at least one of billId, reportNumber, publicLawNumber`,
    );
  }
  if (profile.stage === 'public_law' && profile.publicLawNumber == null) {
    errors.push('public_law stage requires publicLawNumber');
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, errors: [], ownedField };
}

/* ------------------------------------------------------------------ */
/* profile hash                                                        */
/* ------------------------------------------------------------------ */

/**
 * Deterministic hash of the canonical profile. Reported with every stage
 * cycle so downstream consumers can prove which profile governed extraction.
 * Hash is stable under key-order variation (canonical JSON).
 */
export function stageSourceProfileHashV1(profile: DefenseBudgetStageSourceProfileV1): string {
  return sha256CanonicalJson(profile as unknown as JsonValue);
}

/** Parse + validate; throws with all semantic errors on failure. */
export function parseStageSourceProfileV1(input: unknown): DefenseBudgetStageSourceProfileV1 {
  const result = validateStageSourceProfileV1(input);
  if (!result.ok) {
    throw new Error(`invalid stage source profile: ${result.errors.join('; ')}`);
  }
  return defenseBudgetStageSourceProfileV1Schema.parse(input);
}

/**
 * Request values printed in later-stage tables are comparison baselines only.
 * The request field is owned exclusively by the President's Budget request
 * source; no congressional, conference, enacted, or post-enactment authority
 * may claim it. Phase 6 profiles therefore never own `request`.
 */
export function requestOwnershipAllowedForAuthority(_authority: StageAuthorityV1): boolean {
  return false;
}
