/**
 * defense_budget_extraction_v1 — strict runtime contract.
 *
 * One versioned artifact format that every current and future defense-budget
 * parser produces. It is a DATA BOUNDARY ONLY: contract validity is not
 * verification, and a contract-valid artifact is not canonical approval.
 *
 * Everything here is runtime-validated with Zod and strict: unknown fields fail
 * closed. No `any`/`unknown` appears in the exported artifact contract.
 */
import { z } from 'zod';
import { isValidPeCode } from '../extractors/types.js';
import { isCanonicalDecimalString, type MoneyUnitV1 } from './decimal-string.js';
import type { JsonValue } from './canonical-json.js';

export type { JsonValue } from './canonical-json.js';
export type { MoneyUnitV1 } from './decimal-string.js';

/* ------------------------------------------------------------------ */
/* A1. Version constants                                               */
/* ------------------------------------------------------------------ */

export const DEFENSE_BUDGET_EXTRACTION_SCHEMA_VERSION = 'defense_budget_extraction_v1' as const;

export const DEFENSE_BUDGET_MANIFEST_SCHEMA_VERSION = 'defense_budget_cycle_manifest_v1' as const;

/* ------------------------------------------------------------------ */
/* shared primitives                                                   */
/* ------------------------------------------------------------------ */

const SHA256_RE = /^[a-f0-9]{64}$/;

export const sha256Schema = z
  .string()
  .regex(SHA256_RE, 'expected lowercase 64-character hexadecimal SHA-256');

const nonBlankString = z
  .string()
  .min(1)
  .refine((s) => s.trim().length > 0, {
    message: 'must be nonblank',
  });

const canonicalDecimalStringSchema = z
  .string()
  .refine(isCanonicalDecimalString, { message: 'expected canonical decimal string' });

/** Runtime schema for JSON-safe values (open metadata maps). */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

export const jsonMetadataSchema = z.record(jsonValueSchema);

/* ------------------------------------------------------------------ */
/* A3. Document classification vocabulary (contract-owned)             */
/* ------------------------------------------------------------------ */

export const BUDGET_FAMILY_V1_VALUES = [
  'rdte',
  'procurement',
  'om',
  'milcon',
  'milpers',
  'committee',
  'public_law',
  'overview',
  'unknown',
] as const;
export const budgetFamilyV1Schema = z.enum(BUDGET_FAMILY_V1_VALUES);
export type BudgetFamilyV1 = z.infer<typeof budgetFamilyV1Schema>;

export const EXHIBIT_V1_VALUES = [
  'R-1',
  'R-2',
  'R-2A',
  'R-3',
  'R-4',
  'R-4A',
  'P-1',
  'P-5',
  'P-5A',
  'P-21',
  'P-3A',
  'P-40',
  'O-1',
  'OP-5',
  'C-1',
  'DD1391',
  'committee_report',
  'conference_report',
  'public_law',
  'unknown',
] as const;
export const exhibitV1Schema = z.enum(EXHIBIT_V1_VALUES);
export type ExhibitV1 = z.infer<typeof exhibitV1Schema>;

export const BUDGET_AUTHORITY_V1_VALUES = [
  'dod-comptroller',
  'hasc',
  'sasc',
  'hac_d',
  'sac_d',
  'ndaa_conference',
  'appropriations_conference',
  'public_law',
  'reprogramming',
  'execution',
  'manual',
  'unknown',
] as const;
export const budgetAuthorityV1Schema = z.enum(BUDGET_AUTHORITY_V1_VALUES);
export type BudgetAuthorityV1 = z.infer<typeof budgetAuthorityV1Schema>;

export const BUDGET_COMPONENT_V1_VALUES = [
  'ARMY',
  'NAVY',
  'AF',
  'SF',
  'USMC',
  'DW',
  'DARPA',
  'DHA',
  'MDA',
  'SOCOM',
  'OTHER',
  'UNKNOWN',
] as const;
export const budgetComponentV1Schema = z.enum(BUDGET_COMPONENT_V1_VALUES);
export type BudgetComponentV1 = z.infer<typeof budgetComponentV1Schema>;

/* ------------------------------------------------------------------ */
/* A4. Parser method vocabulary                                        */
/* ------------------------------------------------------------------ */

export const EXTRACTION_METHOD_V1_VALUES = [
  'native_structured',
  'deterministic_pdfplumber',
  'camelot',
  'docling',
  'paddleocr',
  'llamaparse',
  'manual',
] as const;
export const extractionMethodV1Schema = z.enum(EXTRACTION_METHOD_V1_VALUES);
export type ExtractionMethodV1 = z.infer<typeof extractionMethodV1Schema>;

/* ------------------------------------------------------------------ */
/* A5. Parser-run schema                                               */
/* ------------------------------------------------------------------ */

export const pageRangeV1Schema = z
  .object({
    startPage: z.number().int().positive(),
    endPage: z.number().int().positive(),
  })
  .strict()
  .refine((range) => range.endPage >= range.startPage, {
    message: 'endPage must be >= startPage',
  });
export type PageRangeV1 = z.infer<typeof pageRangeV1Schema>;

export const parserRunV1Schema = z
  .object({
    parserRunId: nonBlankString,
    method: extractionMethodV1Schema,
    parserVersion: nonBlankString,
    parserConfigSha256: sha256Schema,
    inputSourceSha256: sha256Schema,
    outputArtifactSha256: sha256Schema,
    pageRanges: z.array(pageRangeV1Schema),
    providerJobId: z.string().optional(),
    metadata: jsonMetadataSchema.optional(),
  })
  .strict();
export type ParserRunV1 = z.infer<typeof parserRunV1Schema>;

/* ------------------------------------------------------------------ */
/* A6. Source-document schema                                          */
/* ------------------------------------------------------------------ */

export const extractionSourceV1Schema = z
  .object({
    manifestDocumentKey: nonBlankString,
    sourceDocumentId: z.string().optional(),
    sourcePdfSha256: sha256Schema,
    sourceLocator: nonBlankString,
    sourceUrl: z.string().optional(),
    fiscalYear: z.number().int().min(1900).max(2200),
    family: budgetFamilyV1Schema,
    exhibit: exhibitV1Schema,
    authority: budgetAuthorityV1Schema,
    component: budgetComponentV1Schema,
    budgetCycle: nonBlankString,
    documentType: nonBlankString,
    pageCount: z.number().int().positive().optional(),
    title: z.string().optional(),
  })
  .strict();
export type ExtractionSourceV1 = z.infer<typeof extractionSourceV1Schema>;

/* ------------------------------------------------------------------ */
/* A7. Evidence granularity                                            */
/* ------------------------------------------------------------------ */

export const EVIDENCE_GRANULARITY_V1_VALUES = [
  'document_only',
  'page_only',
  'cell_bbox',
  'text_span',
] as const;
export const evidenceGranularityV1Schema = z.enum(EVIDENCE_GRANULARITY_V1_VALUES);
export type EvidenceGranularityV1 = z.infer<typeof evidenceGranularityV1Schema>;

export const boundingBoxV1Schema = z
  .object({
    x0: z.number().finite(),
    y0: z.number().finite(),
    x1: z.number().finite(),
    y1: z.number().finite(),
    coordinateSystem: z.enum(['pdf_points', 'pixels', 'normalized_0_1']),
    pageWidth: z.number().finite().positive().optional(),
    pageHeight: z.number().finite().positive().optional(),
  })
  .strict();
export type BoundingBoxV1 = z.infer<typeof boundingBoxV1Schema>;

export const textSpanV1Schema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .strict()
  .refine((span) => span.start < span.end, { message: 'text span requires start < end' });
export type TextSpanV1 = z.infer<typeof textSpanV1Schema>;

export const sourceEvidenceV1Schema = z
  .object({
    evidenceId: nonBlankString,
    sourcePdfSha256: sha256Schema,
    parserRunId: nonBlankString,
    granularity: evidenceGranularityV1Schema,
    page: z.number().int().positive().optional(),
    printedPage: z.string().optional(),
    boundingBox: boundingBoxV1Schema.optional(),
    textSpan: textSpanV1Schema.optional(),
    tableLabel: z.string().optional(),
    rowLabel: z.string().optional(),
    columnLabel: z.string().optional(),
    excerpt: z.string().optional(),
    sourceSpanSha256: sha256Schema.optional(),
  })
  .strict();
export type SourceEvidenceV1 = z.infer<typeof sourceEvidenceV1Schema>;

/* ------------------------------------------------------------------ */
/* A8. Budget-line identity union                                      */
/* ------------------------------------------------------------------ */

export const rdtePeIdentityV1Schema = z
  .object({
    lineKind: z.literal('RDTE_PE'),
    peCode: z.string().refine(isValidPeCode, { message: 'invalid RDT&E PE code' }),
  })
  .strict();

export const procurementBlinIdentityV1Schema = z
  .object({
    lineKind: z.literal('PROCUREMENT_BLIN'),
    code: nonBlankString,
    account: nonBlankString,
    component: budgetComponentV1Schema,
    advanceProcurement: z.boolean().optional(),
  })
  .strict();

export const omSagIdentityV1Schema = z
  .object({
    lineKind: z.literal('OM_SAG'),
    code: nonBlankString,
    account: nonBlankString,
    component: budgetComponentV1Schema,
  })
  .strict();

export const milconProjectIdentityV1Schema = z
  .object({
    lineKind: z.literal('MILCON_PROJECT'),
    projectCode: nonBlankString,
    component: budgetComponentV1Schema,
    location: z.string().optional(),
  })
  .strict();

export const unknownIdentityV1Schema = z
  .object({
    lineKind: z.literal('UNKNOWN'),
    code: nonBlankString,
  })
  .strict();

export const budgetLineIdentityV1Schema = z.discriminatedUnion('lineKind', [
  rdtePeIdentityV1Schema,
  procurementBlinIdentityV1Schema,
  omSagIdentityV1Schema,
  milconProjectIdentityV1Schema,
  unknownIdentityV1Schema,
]);
export type BudgetLineIdentityV1 = z.infer<typeof budgetLineIdentityV1Schema>;
export type BudgetLineKindV1 = BudgetLineIdentityV1['lineKind'];

/* ------------------------------------------------------------------ */
/* A9. Money schema                                                    */
/* ------------------------------------------------------------------ */

export const MONEY_UNIT_V1_VALUES = ['dollars', 'thousands', 'millions'] as const;
export const moneyUnitV1Schema = z.enum(MONEY_UNIT_V1_VALUES);

export const moneyValueV1Schema = z
  .object({
    originalValue: canonicalDecimalStringSchema,
    originalUnit: moneyUnitV1Schema,
    valueMillions: canonicalDecimalStringSchema,
  })
  .strict();
export type MoneyValueV1 = z.infer<typeof moneyValueV1Schema>;

/* ------------------------------------------------------------------ */
/* A10. Source-fact ledger                                             */
/* ------------------------------------------------------------------ */

export const SOURCE_FACT_CATEGORY_V1_VALUES = [
  'identity',
  'money',
  'quantity',
  'text',
  'project',
  'performer',
  'milestone',
  'relationship',
  'metadata',
] as const;
export const sourceFactCategoryV1Schema = z.enum(SOURCE_FACT_CATEGORY_V1_VALUES);
export type SourceFactCategoryV1 = z.infer<typeof sourceFactCategoryV1Schema>;

export const sourceFactV1Schema = z
  .object({
    factId: nonBlankString,
    sourcePath: nonBlankString,
    category: sourceFactCategoryV1Schema,
    requiredForCompleteness: z.boolean(),
    rawValue: jsonValueSchema.optional(),
    evidenceIds: z.array(nonBlankString),
  })
  .strict();
export type SourceFactV1 = z.infer<typeof sourceFactV1Schema>;

/* ------------------------------------------------------------------ */
/* A11. Assertion union                                                */
/* ------------------------------------------------------------------ */

export const FUNDING_FIELD_V1_VALUES = [
  'request',
  'hascMark',
  'sascMark',
  'hacDMark',
  'sacDMark',
  'ndaaConference',
  'conference',
  'enacted',
  'reprogrammed',
  'executed',
] as const;
export const fundingFieldV1Schema = z.enum(FUNDING_FIELD_V1_VALUES);
export type FundingFieldV1 = z.infer<typeof fundingFieldV1Schema>;

const assertionBaseShape = {
  assertionId: nonBlankString,
  sourceFactIds: z.array(nonBlankString),
  evidenceIds: z.array(nonBlankString),
  confidence: z.number().min(0).max(1),
  metadata: jsonMetadataSchema.optional(),
};

export const programElementIdentityAssertionV1Schema = z
  .object({
    ...assertionBaseShape,
    assertionKind: z.literal('program_element_identity'),
    identity: rdtePeIdentityV1Schema,
    title: nonBlankString,
    component: budgetComponentV1Schema,
    serviceCode: z.string().optional(),
    appropriation: z.string().optional(),
    appropriationType: z.string().optional(),
    budgetActivity: z.string().optional(),
    budgetActivityName: z.string().optional(),
    lineNumber: z.string().optional(),
    firstSeenFy: z.number().int().min(1900).max(2200).optional(),
  })
  .strict();

export const fundingAssertionV1Schema = z
  .object({
    ...assertionBaseShape,
    assertionKind: z.literal('funding'),
    identity: budgetLineIdentityV1Schema,
    fiscalYear: z.number().int().min(1900).max(2200),
    field: fundingFieldV1Schema,
    money: moneyValueV1Schema,
  })
  .strict();

export const NARRATIVE_TYPE_V1_VALUES = [
  'mission',
  'description',
  'accomplishments',
  'plans',
  'rationale',
  'schedule_notes',
  'other',
] as const;
export const narrativeTypeV1Schema = z.enum(NARRATIVE_TYPE_V1_VALUES);
export type NarrativeTypeV1 = z.infer<typeof narrativeTypeV1Schema>;

export const narrativeAssertionV1Schema = z
  .object({
    ...assertionBaseShape,
    assertionKind: z.literal('narrative'),
    identity: budgetLineIdentityV1Schema,
    narrativeType: narrativeTypeV1Schema,
    text: z.string(),
  })
  .strict();

export const projectAssertionV1Schema = z
  .object({
    ...assertionBaseShape,
    assertionKind: z.literal('project'),
    parentPeCode: z.string().refine(isValidPeCode, { message: 'invalid parent PE code' }),
    projectCode: nonBlankString,
    title: nonBlankString,
    mission: z.string().optional(),
    budgetActivity: z.string().optional(),
  })
  .strict();

export const projectFundingAssertionV1Schema = z
  .object({
    ...assertionBaseShape,
    assertionKind: z.literal('project_funding'),
    parentPeCode: z.string().refine(isValidPeCode, { message: 'invalid parent PE code' }),
    projectCode: nonBlankString,
    fiscalYear: z.number().int().min(1900).max(2200),
    field: z.enum(['request', 'enacted', 'executed', 'reprogrammed']),
    money: moneyValueV1Schema,
  })
  .strict();

export const PERFORMER_ROLE_V1_VALUES = [
  'PERFORMING_ACTIVITY',
  'PRIME_CONTRACTOR',
  'UNKNOWN',
] as const;
export const performerRoleV1Schema = z.enum(PERFORMER_ROLE_V1_VALUES);
export type PerformerRoleV1 = z.infer<typeof performerRoleV1Schema>;

export const performerAssertionV1Schema = z
  .object({
    ...assertionBaseShape,
    assertionKind: z.literal('performer'),
    parentPeCode: z.string().refine(isValidPeCode, { message: 'invalid parent PE code' }),
    projectCode: z.string().optional(),
    performerName: nonBlankString,
    performerNormalized: z.string().optional(),
    performerRole: performerRoleV1Schema,
    location: z.string().optional(),
    contractMethod: z.string().optional(),
    costCategory: z.string().optional(),
    fiscalYear: z.number().int().min(1900).max(2200).optional(),
    totalCost: moneyValueV1Schema.optional(),
  })
  .strict();

export const procurementLineAssertionV1Schema = z
  .object({
    ...assertionBaseShape,
    assertionKind: z.literal('procurement_line'),
    parentIdentity: procurementBlinIdentityV1Schema,
    description: z.string(),
    fiscalYear: z.number().int().min(1900).max(2200),
    quantity: canonicalDecimalStringSchema.optional(),
    dollars: moneyValueV1Schema.optional(),
    unitCostDollars: canonicalDecimalStringSchema.optional(),
  })
  .strict();

export const quantityAssertionV1Schema = z
  .object({
    ...assertionBaseShape,
    assertionKind: z.literal('quantity'),
    identity: budgetLineIdentityV1Schema,
    fiscalYear: z.number().int().min(1900).max(2200),
    quantity: canonicalDecimalStringSchema,
    unitLabel: z.string().optional(),
  })
  .strict();

export const unitCostAssertionV1Schema = z
  .object({
    ...assertionBaseShape,
    assertionKind: z.literal('unit_cost'),
    identity: budgetLineIdentityV1Schema,
    fiscalYear: z.number().int().min(1900).max(2200),
    unitCostDollars: canonicalDecimalStringSchema,
  })
  .strict();

export const omLineAssertionV1Schema = z
  .object({
    ...assertionBaseShape,
    assertionKind: z.literal('om_line'),
    identity: omSagIdentityV1Schema,
    title: nonBlankString,
    budgetActivity: z.string().optional(),
    activityGroup: z.string().optional(),
    subActivityGroup: z.string().optional(),
  })
  .strict();

export const milconProjectAssertionV1Schema = z
  .object({
    ...assertionBaseShape,
    assertionKind: z.literal('milcon_project'),
    identity: milconProjectIdentityV1Schema,
    title: nonBlankString,
    scope: z.string().optional(),
    location: z.string().optional(),
    authorizationAmount: moneyValueV1Schema.optional(),
    appropriationAmount: moneyValueV1Schema.optional(),
  })
  .strict();

export const milestoneAssertionV1Schema = z
  .object({
    ...assertionBaseShape,
    assertionKind: z.literal('milestone'),
    parentPeCode: z.string().refine(isValidPeCode, { message: 'invalid parent PE code' }),
    milestoneType: nonBlankString,
    plannedDate: z.string().optional(),
    actualDate: z.string().optional(),
    status: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict();

export const RELATIONSHIP_TYPE_V1_VALUES = [
  'references',
  'supports',
  'funds',
  'project_of',
  'performer_for',
  'summary_of',
  'detail_of',
  'other',
] as const;
export const relationshipTypeV1Schema = z.enum(RELATIONSHIP_TYPE_V1_VALUES);
export type RelationshipTypeV1 = z.infer<typeof relationshipTypeV1Schema>;

export const relationshipAssertionV1Schema = z
  .object({
    ...assertionBaseShape,
    assertionKind: z.literal('relationship'),
    from: budgetLineIdentityV1Schema,
    to: budgetLineIdentityV1Schema,
    relationshipType: relationshipTypeV1Schema,
    explicitInSource: z.boolean(),
  })
  .strict();

export const documentAssertionV1Schema = z
  .object({
    ...assertionBaseShape,
    assertionKind: z.literal('document_fact'),
    fieldName: nonBlankString,
    value: jsonValueSchema,
  })
  .strict();

export const defenseBudgetAssertionV1Schema = z.discriminatedUnion('assertionKind', [
  programElementIdentityAssertionV1Schema,
  fundingAssertionV1Schema,
  narrativeAssertionV1Schema,
  projectAssertionV1Schema,
  projectFundingAssertionV1Schema,
  performerAssertionV1Schema,
  procurementLineAssertionV1Schema,
  quantityAssertionV1Schema,
  unitCostAssertionV1Schema,
  omLineAssertionV1Schema,
  milconProjectAssertionV1Schema,
  milestoneAssertionV1Schema,
  relationshipAssertionV1Schema,
  documentAssertionV1Schema,
]);
export type DefenseBudgetAssertionV1 = z.infer<typeof defenseBudgetAssertionV1Schema>;
export type AssertionKindV1 = DefenseBudgetAssertionV1['assertionKind'];

/* ------------------------------------------------------------------ */
/* A12. Warning and omission schemas                                   */
/* ------------------------------------------------------------------ */

export const extractionWarningV1Schema = z
  .object({
    warningId: nonBlankString,
    code: nonBlankString,
    severity: z.enum(['info', 'review', 'blocking']),
    message: z.string(),
    sourceFactIds: z.array(nonBlankString),
    evidenceIds: z.array(nonBlankString),
  })
  .strict();
export type ExtractionWarningV1 = z.infer<typeof extractionWarningV1Schema>;

export const OMISSION_REASON_V1_VALUES = [
  'unsupported_field',
  'missing_value',
  'invalid_number',
  'unsupported_unit',
  'invalid_identity',
  'missing_evidence',
  'ambiguous_layout',
  'legacy_artifact_missing_detail',
  'adapter_unimplemented',
  'other',
] as const;
export const omissionReasonV1Schema = z.enum(OMISSION_REASON_V1_VALUES);
export type OmissionReasonV1 = z.infer<typeof omissionReasonV1Schema>;

export const extractionOmissionV1Schema = z
  .object({
    omissionId: nonBlankString,
    sourceFactId: nonBlankString,
    reason: omissionReasonV1Schema,
    severity: z.enum(['review', 'blocking']),
    message: z.string(),
  })
  .strict();
export type ExtractionOmissionV1 = z.infer<typeof extractionOmissionV1Schema>;

/* ------------------------------------------------------------------ */
/* A13. Artifact envelope                                              */
/* ------------------------------------------------------------------ */

export const COMPLETENESS_STATUS_V1_VALUES = [
  'complete',
  'complete_with_omissions',
  'incomplete',
] as const;
export const completenessStatusV1Schema = z.enum(COMPLETENESS_STATUS_V1_VALUES);
export type CompletenessStatusV1 = z.infer<typeof completenessStatusV1Schema>;

export const extractionArtifactSummaryV1Schema = z
  .object({
    sourceFactCount: z.number().int().nonnegative(),
    requiredSourceFactCount: z.number().int().nonnegative(),
    coveredRequiredSourceFactCount: z.number().int().nonnegative(),
    omittedRequiredSourceFactCount: z.number().int().nonnegative(),
    uncoveredRequiredSourceFactCount: z.number().int().nonnegative(),
    assertionCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
    omissionCount: z.number().int().nonnegative(),
    countsByAssertionKind: z.record(z.number().int().nonnegative()),
    countsByOmissionReason: z.record(z.number().int().nonnegative()),
    completenessStatus: completenessStatusV1Schema,
  })
  .strict();
export type ExtractionArtifactSummaryV1 = z.infer<typeof extractionArtifactSummaryV1Schema>;

export const defenseBudgetExtractionArtifactV1Schema = z
  .object({
    schemaVersion: z.literal(DEFENSE_BUDGET_EXTRACTION_SCHEMA_VERSION),
    artifactId: nonBlankString,
    contentSha256: sha256Schema,
    source: extractionSourceV1Schema,
    parserRuns: z.array(parserRunV1Schema),
    evidence: z.array(sourceEvidenceV1Schema),
    sourceFacts: z.array(sourceFactV1Schema),
    assertions: z.array(defenseBudgetAssertionV1Schema),
    warnings: z.array(extractionWarningV1Schema),
    omissions: z.array(extractionOmissionV1Schema),
    summary: extractionArtifactSummaryV1Schema,
  })
  .strict();
export type DefenseBudgetExtractionArtifactV1 = z.infer<
  typeof defenseBudgetExtractionArtifactV1Schema
>;
