/** Phase 6 Workstream F — strict authorization report-language contracts. */
import { z } from 'zod';
import { isValidPeCode } from '../../../extractors/types.js';
import {
  budgetComponentV1Schema,
  budgetLineIdentityV1Schema,
  sha256Schema,
  type BudgetLineIdentityV1,
} from '../../../contracts/extraction-artifact-v1.js';

export const AUTHORIZATION_PROVISION_SCHEMA_VERSION = 'authorization_provision_v1' as const;
export const AUTHORIZATION_PROVISION_EXTRACTION_RESULT_SCHEMA_VERSION =
  'authorization_provision_extraction_result_v1' as const;
export const AUTHORIZATION_PROVISION_PROJECTION_PLAN_SCHEMA_VERSION =
  'authorization_provision_projection_plan_v1' as const;

const nonBlank = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, { message: 'must be nonblank' });
const peCode = z.string().refine(isValidPeCode, { message: 'invalid PE code' });

export const provisionStageV1Schema = z.enum(['hasc', 'sasc']);
export type ProvisionStageV1 = z.infer<typeof provisionStageV1Schema>;

export const provisionCommitteeV1Schema = z.enum(['HASC', 'SASC']);
export const provisionAuthorityV1Schema = z.enum(['hasc_authorization', 'sasc_authorization']);
export const provisionActionTypeV1Schema = z.enum([
  'directs_briefing',
  'directs_report',
  'adds',
  'cuts',
  'transfers',
  'restricts',
  'encourages',
  'expresses_concern',
  'narrative',
]);
export type ProvisionActionTypeV1 = z.infer<typeof provisionActionTypeV1Schema>;

export const provisionScopeV1Schema = z.enum([
  'line_specific',
  'project_specific',
  'program_wide',
  'account_wide',
  'component_wide',
  'department_wide',
]);
export type ProvisionScopeV1 = z.infer<typeof provisionScopeV1Schema>;

export const provisionPageRangeV1Schema = z
  .object({
    startPage: z.number().int().positive(),
    endPage: z.number().int().positive(),
    printedStart: z.string().optional(),
    printedEnd: z.string().optional(),
  })
  .strict()
  .refine((value) => value.endPage >= value.startPage, {
    message: 'endPage must be >= startPage',
  });
export type ProvisionPageRangeV1 = z.infer<typeof provisionPageRangeV1Schema>;

export const provisionDeadlineV1Schema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('date'),
      rawText: nonBlank,
      isoDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('relative'),
      rawText: nonBlank,
      days: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type ProvisionDeadlineV1 = z.infer<typeof provisionDeadlineV1Schema>;

export const reportingRecipientV1Schema = z
  .object({
    rawText: nonBlank,
    normalized: z.string().optional(),
  })
  .strict();

export const provisionReferenceV1Schema = z.discriminatedUnion('referenceKind', [
  z
    .object({
      referenceKind: z.literal('pe_code'),
      peCode,
      title: z.string().optional(),
    })
    .strict(),
  z
    .object({
      referenceKind: z.literal('rdte_project'),
      peCode,
      projectCode: nonBlank,
      title: z.string().optional(),
    })
    .strict(),
  z
    .object({
      referenceKind: z.literal('procurement_line'),
      code: nonBlank,
      account: nonBlank,
      component: budgetComponentV1Schema,
      advanceProcurement: z.boolean().optional(),
      title: z.string().optional(),
    })
    .strict(),
  z
    .object({
      referenceKind: z.literal('om_sag'),
      code: nonBlank,
      account: nonBlank,
      component: budgetComponentV1Schema,
      title: z.string().optional(),
    })
    .strict(),
  z
    .object({
      referenceKind: z.literal('milcon_project'),
      projectCode: nonBlank,
      component: budgetComponentV1Schema,
      location: z.string().optional(),
      title: z.string().optional(),
    })
    .strict(),
  z
    .object({
      referenceKind: z.literal('title_only'),
      title: nonBlank,
    })
    .strict(),
]);
export type ProvisionReferenceV1 = z.infer<typeof provisionReferenceV1Schema>;

export const authorizationProvisionV1Schema = z
  .object({
    schemaVersion: z.literal(AUTHORIZATION_PROVISION_SCHEMA_VERSION),
    provisionId: nonBlank,
    track: z.literal('authorization'),
    stage: provisionStageV1Schema,
    committee: provisionCommitteeV1Schema,
    authority: provisionAuthorityV1Schema,
    fiscalYear: z.number().int().min(1900).max(2200),
    profileId: nonBlank,
    sourceDocumentId: nonBlank,
    sourceSha256: sha256Schema,
    heading: nonBlank,
    fullText: nonBlank,
    pageRange: provisionPageRangeV1Schema,
    actionType: provisionActionTypeV1Schema,
    deadline: provisionDeadlineV1Schema.optional(),
    reportingRecipient: reportingRecipientV1Schema.optional(),
    references: z.array(provisionReferenceV1Schema),
    scope: provisionScopeV1Schema,
    attributionCaveat: z.string().optional(),
    evidenceIds: z.array(nonBlank).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expected =
      value.stage === 'hasc'
        ? { committee: 'HASC', authority: 'hasc_authorization' }
        : { committee: 'SASC', authority: 'sasc_authorization' };
    if (value.committee !== expected.committee || value.authority !== expected.authority) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'stage, committee, and authority must agree',
        path: ['committee'],
      });
    }
    if (
      !['line_specific', 'project_specific'].includes(value.scope) &&
      (value.attributionCaveat == null || value.attributionCaveat.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'non-line-specific provision requires attributionCaveat',
        path: ['attributionCaveat'],
      });
    }
    if (new Set(value.evidenceIds).size !== value.evidenceIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'evidenceIds must be unique',
        path: ['evidenceIds'],
      });
    }
  });
export type AuthorizationProvisionV1 = z.infer<typeof authorizationProvisionV1Schema>;

const provisionBoundingBoxV1Schema = z
  .object({ x0: z.string(), y0: z.string(), x1: z.string(), y1: z.string() })
  .strict();

export const authorizationProvisionEvidenceV1Schema = z
  .object({
    evidenceId: nonBlank,
    sourceSha256: sha256Schema,
    page: z.number().int().positive(),
    printedPage: z.string().optional(),
    blockIndex: z.number().int().nonnegative(),
    granularity: z.enum(['page_only', 'text_span']),
    excerpt: nonBlank,
    boundingBox: provisionBoundingBoxV1Schema.optional(),
  })
  .strict();
export type AuthorizationProvisionEvidenceV1 = z.infer<
  typeof authorizationProvisionEvidenceV1Schema
>;

export const authorizationProvisionExtractionResultV1Schema = z
  .object({
    schemaVersion: z.literal(AUTHORIZATION_PROVISION_EXTRACTION_RESULT_SCHEMA_VERSION),
    stage: provisionStageV1Schema,
    profileId: nonBlank,
    sourceDocumentId: nonBlank,
    sourceSha256: sha256Schema,
    provisions: z.array(authorizationProvisionV1Schema),
    evidence: z.array(authorizationProvisionEvidenceV1Schema),
    warnings: z.array(z.string()),
    omittedPages: z.array(z.number().int().positive()),
  })
  .strict()
  .superRefine((value, ctx) => {
    const sorted = [...new Set(value.omittedPages)].sort((a, b) => a - b);
    if (
      sorted.length !== value.omittedPages.length ||
      sorted.some((page, index) => page !== value.omittedPages[index])
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'omittedPages must be sorted and unique',
        path: ['omittedPages'],
      });
    }
    for (const provision of value.provisions) {
      if (
        provision.stage !== value.stage ||
        provision.profileId !== value.profileId ||
        provision.sourceDocumentId !== value.sourceDocumentId ||
        provision.sourceSha256 !== value.sourceSha256
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'provision source binding does not match extraction result',
          path: ['provisions'],
        });
        break;
      }
    }
  });
export type AuthorizationProvisionExtractionResultV1 = z.infer<
  typeof authorizationProvisionExtractionResultV1Schema
>;

export const authorizationProvisionTargetV1Schema = z.discriminatedUnion('targetKind', [
  z
    .object({
      targetKind: z.literal('budget_line'),
      identity: budgetLineIdentityV1Schema,
    })
    .strict(),
  z
    .object({
      targetKind: z.literal('rdte_project'),
      parentPeCode: peCode,
      projectCode: nonBlank,
    })
    .strict(),
]);
export type AuthorizationProvisionTargetV1 = z.infer<typeof authorizationProvisionTargetV1Schema>;

export const authorizationProvisionLinkV1Schema = z
  .object({
    linkId: nonBlank,
    provisionId: nonBlank,
    target: authorizationProvisionTargetV1Schema,
    status: z.enum(['accepted', 'candidate']),
    matchBasis: z.enum([
      'exact_pe_code',
      'exact_project_code',
      'exact_native_reference',
      'reviewed_alias',
      'title_only',
    ]),
    confidence: z.number().min(0).max(1),
    evidenceIds: z.array(nonBlank).min(1),
    attributionCaveat: z.string().optional(),
    reviewId: z.string().optional(),
  })
  .strict();
export type AuthorizationProvisionLinkV1 = z.infer<typeof authorizationProvisionLinkV1Schema>;

export const authorizationProvisionReviewEntryV1Schema = z
  .object({
    reviewId: nonBlank,
    provisionId: nonBlank,
    status: z.enum(['candidate', 'conflicting', 'unresolved']),
    reason: z.enum([
      'title_only_match',
      'ambiguous_exact_reference',
      'unresolved_exact_reference',
      'missing_evidence',
      'duplicate_conflict',
    ]),
    message: nonBlank,
    reference: provisionReferenceV1Schema.optional(),
    targets: z.array(authorizationProvisionTargetV1Schema),
    evidenceIds: z.array(nonBlank),
  })
  .strict();
export type AuthorizationProvisionReviewEntryV1 = z.infer<
  typeof authorizationProvisionReviewEntryV1Schema
>;

export const authorizationProvisionVerificationCheckV1Schema = z
  .object({
    code: z.enum([
      'source_binding',
      'evidence_complete',
      'exact_link_policy',
      'scope_attribution',
      'duplicate_provision',
      'projection_containment',
    ]),
    outcome: z.enum(['PASS', 'REVIEW', 'FAIL']),
    message: nonBlank,
    provisionIds: z.array(nonBlank),
  })
  .strict();

export const authorizationProvisionProjectionPlanV1Schema = z
  .object({
    schemaVersion: z.literal(AUTHORIZATION_PROVISION_PROJECTION_PLAN_SCHEMA_VERSION),
    writeMode: z.literal('projection_only'),
    canonicalWriteAllowed: z.literal(false),
    legacyProvisionMutationAllowed: z.literal(false),
    stage: provisionStageV1Schema,
    profileId: nonBlank,
    sourceDocumentId: nonBlank,
    sourceSha256: sha256Schema,
    provisions: z.array(authorizationProvisionV1Schema),
    acceptedLinks: z.array(authorizationProvisionLinkV1Schema),
    candidateLinks: z.array(authorizationProvisionLinkV1Schema),
    reviewQueue: z.array(authorizationProvisionReviewEntryV1Schema),
    verification: z
      .object({
        status: z.enum(['PASS', 'REVIEW', 'BLOCKED']),
        checks: z.array(authorizationProvisionVerificationCheckV1Schema),
      })
      .strict(),
  })
  .strict();
export type AuthorizationProvisionProjectionPlanV1 = z.infer<
  typeof authorizationProvisionProjectionPlanV1Schema
>;

export interface ProvisionBudgetLineIndexEntryV1 {
  identity: BudgetLineIdentityV1;
  title?: string;
}

export interface ProvisionProjectIndexEntryV1 {
  parentPeCode: string;
  projectCode: string;
  title: string;
}

export interface ReviewedProvisionAliasV1 {
  alias: string;
  target: AuthorizationProvisionTargetV1;
  reviewId: string;
}

export interface AuthorizationProvisionNativeIndexV1 {
  budgetLines: readonly ProvisionBudgetLineIndexEntryV1[];
  projects: readonly ProvisionProjectIndexEntryV1[];
  reviewedAliases: readonly ReviewedProvisionAliasV1[];
}

export function parseAuthorizationProvisionV1(value: unknown): AuthorizationProvisionV1 {
  return authorizationProvisionV1Schema.parse(value);
}

export function parseAuthorizationProvisionExtractionResultV1(
  value: unknown,
): AuthorizationProvisionExtractionResultV1 {
  return authorizationProvisionExtractionResultV1Schema.parse(value);
}

export function parseAuthorizationProvisionProjectionPlanV1(
  value: unknown,
): AuthorizationProvisionProjectionPlanV1 {
  return authorizationProvisionProjectionPlanV1Schema.parse(value);
}
