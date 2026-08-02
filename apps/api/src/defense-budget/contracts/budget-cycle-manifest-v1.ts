/**
 * defense_budget_cycle_manifest_v1 — manually curated annual-cycle manifest.
 *
 * The manifest is a HUMAN-REVIEWED inventory of the documents that make up one
 * defense budget cycle. It does not discover documents, does not execute
 * parsers, and does not claim that any source is archived or parsed. It is the
 * input contract the local converter uses to build adapter contexts, and later
 * phases use it to decide required-data completeness.
 */
import { z } from 'zod';
import {
  budgetAuthorityV1Schema,
  budgetComponentV1Schema,
  budgetFamilyV1Schema,
  budgetLineIdentityV1Schema,
  DEFENSE_BUDGET_MANIFEST_SCHEMA_VERSION,
  exhibitV1Schema,
  fundingFieldV1Schema,
  jsonMetadataSchema,
  sha256Schema,
  type BudgetLineKindV1,
} from './extraction-artifact-v1.js';

/* ------------------------------------------------------------------ */
/* document-level vocabularies                                         */
/* ------------------------------------------------------------------ */

export const PARSER_POLICY_V1_VALUES = [
  'native_structured',
  'deterministic_table',
  'mixed_layout',
  'ocr',
  'complex',
] as const;
export const parserPolicyV1Schema = z.enum(PARSER_POLICY_V1_VALUES);
export type ParserPolicyV1 = z.infer<typeof parserPolicyV1Schema>;

export const REQUIRED_DATA_CATEGORY_V1_VALUES = [
  'identity',
  'funding',
  'narrative',
  'projects',
  'project_funding',
  'performers',
  'procurement_lines',
  'quantities',
  'unit_cost',
  'om_lines',
  'milcon_projects',
  'milestones',
  'relationships',
] as const;
export const requiredDataCategoryV1Schema = z.enum(REQUIRED_DATA_CATEGORY_V1_VALUES);
export type RequiredDataCategoryV1 = z.infer<typeof requiredDataCategoryV1Schema>;

export const LEGACY_ARTIFACT_KIND_V1_VALUES = [
  'extraction_result',
  'r1',
  'r2',
  'r3_performer',
  'committee',
  'pdoc',
] as const;
export const legacyArtifactKindV1Schema = z.enum(LEGACY_ARTIFACT_KIND_V1_VALUES);
export type LegacyArtifactKindV1 = z.infer<typeof legacyArtifactKindV1Schema>;

const BUDGET_LINE_KIND_V1_VALUES = [
  'RDTE_PE',
  'PROCUREMENT_BLIN',
  'OM_SAG',
  'MILCON_PROJECT',
  'UNKNOWN',
] as const satisfies readonly BudgetLineKindV1[];
export const budgetLineKindV1Schema = z.enum(BUDGET_LINE_KIND_V1_VALUES);

const nonBlankString = z
  .string()
  .min(1)
  .refine((s) => s.trim().length > 0, { message: 'must be nonblank' });

/* ------------------------------------------------------------------ */
/* document entry                                                      */
/* ------------------------------------------------------------------ */

export const budgetCycleManifestDocumentV1Schema = z
  .object({
    documentKey: nonBlankString,
    required: z.boolean(),
    title: nonBlankString,
    sourceLocator: nonBlankString,
    sourceUrl: z.string().optional(),
    expectedSourceSha256: sha256Schema.optional(),
    family: budgetFamilyV1Schema,
    exhibit: exhibitV1Schema,
    authority: budgetAuthorityV1Schema,
    component: budgetComponentV1Schema,
    budgetCycle: nonBlankString,
    documentType: nonBlankString,
    parserPolicy: parserPolicyV1Schema,
    requiredDataCategories: z.array(requiredDataCategoryV1Schema),
    requiredFundingFields: z.array(fundingFieldV1Schema).optional(),
    expectedLineKinds: z.array(budgetLineKindV1Schema),
    allowEmpty: z.boolean(),
    legacyArtifactKind: legacyArtifactKindV1Schema.optional(),
    legacyArtifactPath: z.string().optional(),
    metadata: jsonMetadataSchema.optional(),
  })
  .strict();
export type BudgetCycleManifestDocumentV1 = z.infer<typeof budgetCycleManifestDocumentV1Schema>;

/* ------------------------------------------------------------------ */
/* manifest envelope                                                   */
/* ------------------------------------------------------------------ */

export const budgetCycleManifestV1Schema = z
  .object({
    schemaVersion: z.literal(DEFENSE_BUDGET_MANIFEST_SCHEMA_VERSION),
    cycleId: nonBlankString,
    fiscalYear: z.number().int().min(1900).max(2200),
    domain: z.literal('defense'),
    documents: z.array(budgetCycleManifestDocumentV1Schema),
    metadata: jsonMetadataSchema.optional(),
  })
  .strict();
export type BudgetCycleManifestV1 = z.infer<typeof budgetCycleManifestV1Schema>;

/* ------------------------------------------------------------------ */
/* semantic validation                                                 */
/* ------------------------------------------------------------------ */

export interface ManifestFindingV1 {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
}

const R_SERIES_EXHIBITS = new Set(['R-1', 'R-2', 'R-2A', 'R-3', 'R-4', 'R-4A']);
const P_SERIES_EXHIBITS = new Set(['P-1', 'P-3A', 'P-5', 'P-5A', 'P-21', 'P-40']);
const O_SERIES_EXHIBITS = new Set(['O-1', 'OP-5']);
const MILCON_EXHIBITS = new Set(['C-1', 'DD1391']);
const FUNDING_CATEGORIES = new Set<RequiredDataCategoryV1>(['funding', 'project_funding']);

/** Parse the manifest envelope with Zod. Throws ZodError on schema failure. */
export function parseBudgetCycleManifestV1(input: unknown): BudgetCycleManifestV1 {
  return budgetCycleManifestV1Schema.parse(input);
}

/** Semantic validation over a schema-valid manifest. */
export function validateBudgetCycleManifestV1(
  manifest: BudgetCycleManifestV1,
): ManifestFindingV1[] {
  const findings: ManifestFindingV1[] = [];
  const error = (code: string, path: string, message: string): void => {
    findings.push({ severity: 'error', code, path, message });
  };

  /* unique documentKey */
  const seenKeys = new Map<string, number>();
  manifest.documents.forEach((doc, index) => {
    const firstIndex = seenKeys.get(doc.documentKey);
    if (firstIndex != null) {
      error(
        'duplicate_document_key',
        `documents[${index}].documentKey`,
        `documentKey "${doc.documentKey}" duplicates documents[${firstIndex}]`,
      );
    } else {
      seenKeys.set(doc.documentKey, index);
    }
  });

  /* cycleId must mention the fiscal year (fiscal-year-specific) */
  if (!manifest.cycleId.includes(String(manifest.fiscalYear))) {
    error(
      'cycle_id_not_fiscal_year_specific',
      'cycleId',
      `cycleId "${manifest.cycleId}" does not contain the fiscal year ${manifest.fiscalYear}`,
    );
  }

  manifest.documents.forEach((doc, index) => {
    const path = `documents[${index}]`;

    /* every required document has at least one required data category */
    if (doc.required && doc.requiredDataCategories.length === 0) {
      error(
        'required_document_without_categories',
        `${path}.requiredDataCategories`,
        `required document "${doc.documentKey}" declares no required data categories`,
      );
    }

    /* allowEmpty must be false for any required document */
    if (doc.required && doc.allowEmpty) {
      error(
        'required_document_allows_empty',
        `${path}.allowEmpty`,
        `required document "${doc.documentKey}" cannot allow an empty extraction`,
      );
    }

    /* funding categories require funding fields unless narrative-only */
    const hasFundingCategory = doc.requiredDataCategories.some((category) =>
      FUNDING_CATEGORIES.has(category),
    );
    const narrativeOnly = doc.requiredDataCategories.every(
      (category) =>
        category === 'identity' || category === 'narrative' || category === 'relationships',
    );
    if (
      hasFundingCategory &&
      !narrativeOnly &&
      (doc.requiredFundingFields == null || doc.requiredFundingFields.length === 0)
    ) {
      error(
        'funding_category_without_fields',
        `${path}.requiredFundingFields`,
        `document "${doc.documentKey}" requires funding data but declares no required funding fields`,
      );
    }

    /* exhibit -> expected line kind consistency */
    const lineKinds = new Set(doc.expectedLineKinds);
    if (R_SERIES_EXHIBITS.has(doc.exhibit) && !onlyKinds(lineKinds, ['RDTE_PE'])) {
      error(
        'r_series_wrong_line_kind',
        `${path}.expectedLineKinds`,
        `${doc.exhibit} documents must expect RDTE_PE line kind only`,
      );
    }
    if (P_SERIES_EXHIBITS.has(doc.exhibit) && !onlyKinds(lineKinds, ['PROCUREMENT_BLIN'])) {
      error(
        'p_series_wrong_line_kind',
        `${path}.expectedLineKinds`,
        `${doc.exhibit} documents must expect PROCUREMENT_BLIN line kind only`,
      );
    }
    if (O_SERIES_EXHIBITS.has(doc.exhibit) && !onlyKinds(lineKinds, ['OM_SAG'])) {
      error(
        'o_series_wrong_line_kind',
        `${path}.expectedLineKinds`,
        `${doc.exhibit} documents must expect OM_SAG line kind only`,
      );
    }
    if (MILCON_EXHIBITS.has(doc.exhibit) && !onlyKinds(lineKinds, ['MILCON_PROJECT'])) {
      error(
        'milcon_wrong_line_kind',
        `${path}.expectedLineKinds`,
        `${doc.exhibit} documents must expect MILCON_PROJECT line kind only`,
      );
    }

    /* legacy artifact path requires a kind, and vice versa */
    if (doc.legacyArtifactPath != null && doc.legacyArtifactKind == null) {
      error(
        'legacy_path_without_kind',
        `${path}.legacyArtifactKind`,
        `document "${doc.documentKey}" names a legacy artifact path without a legacy artifact kind`,
      );
    }
    if (doc.legacyArtifactKind != null && doc.legacyArtifactPath == null) {
      error(
        'legacy_kind_without_path',
        `${path}.legacyArtifactPath`,
        `document "${doc.documentKey}" names a legacy artifact kind without a legacy artifact path`,
      );
    }
  });

  return findings;
}

/** Throw an AggregateError-shaped Error when any error findings exist. */
export function assertBudgetCycleManifestV1(manifest: BudgetCycleManifestV1): void {
  const errors = validateBudgetCycleManifestV1(manifest).filter((f) => f.severity === 'error');
  if (errors.length > 0) {
    const detail = errors.map((e) => `${e.code} at ${e.path}: ${e.message}`).join('; ');
    throw new Error(`manifest semantic validation failed: ${detail}`);
  }
}

function onlyKinds(actual: Set<string>, allowed: string[]): boolean {
  if (actual.size === 0) return false;
  for (const kind of actual) {
    if (!allowed.includes(kind)) return false;
  }
  return true;
}

// Re-export for consumers that only import the manifest module.
export { DEFENSE_BUDGET_MANIFEST_SCHEMA_VERSION, budgetLineIdentityV1Schema };
