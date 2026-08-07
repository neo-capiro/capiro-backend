/**
 * Phase 6 Workstream B — BudgetLineReferenceV1 raw reference union,
 * ResolvedBudgetLineBindingV1, and the reviewed alias-map contract.
 *
 * Raw congressional row references are resolved against the native Phase 4/5
 * identity space (RDTE_PE, PROCUREMENT_BLIN, OM_SAG, MILCON_PROJECT).
 *
 * Hard rules (enforced by line-reference-resolver.ts):
 *   - exact source codes and account context outrank titles;
 *   - procurement short line numbers require appropriation/account namespace;
 *   - base and advance procurement stay distinct;
 *   - O&M SAG identity includes account and component;
 *   - MILCON identity includes project number and component (location context
 *     retained for same-project-at-different-installation disambiguation);
 *   - title-only matches create candidates, never accepted bindings;
 *   - multiple plausible targets are `conflicting`, never best-score-wins;
 *   - missing context is `unresolved`, never guessed;
 *   - no `program_element` stub is ever created and titles never bind.
 */
import { z } from 'zod';
import {
  budgetLineIdentityV1Schema,
  type BudgetLineIdentityV1,
} from '../contracts/extraction-artifact-v1.js';
import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';

/* ------------------------------------------------------------------ */
/* raw reference union                                                 */
/* ------------------------------------------------------------------ */

export const budgetLineReferencePeCodeV1Schema = z
  .object({
    referenceKind: z.literal('pe_code'),
    peCode: z.string().min(1),
    /** Titles are evidence, never identity. */
    rowTitle: z.string().optional(),
  })
  .strict();

export const budgetLineReferenceProcurementV1Schema = z
  .object({
    referenceKind: z.literal('procurement_line'),
    /** Short line number; NOT globally unique without account namespace. */
    lineCode: z.string().min(1),
    account: z.string().optional(),
    component: z.string().optional(),
    advanceProcurement: z.boolean().optional(),
    rowTitle: z.string().optional(),
  })
  .strict();

export const budgetLineReferenceOmSagV1Schema = z
  .object({
    referenceKind: z.literal('om_sag'),
    sagCode: z.string().min(1),
    account: z.string().optional(),
    component: z.string().optional(),
    rowTitle: z.string().optional(),
  })
  .strict();

export const budgetLineReferenceMilconV1Schema = z
  .object({
    referenceKind: z.literal('milcon_project'),
    projectCode: z.string().min(1),
    component: z.string().optional(),
    location: z.string().optional(),
    rowTitle: z.string().optional(),
  })
  .strict();

export const budgetLineReferencePackageScopeV1Schema = z
  .object({
    referenceKind: z.literal('package_scope'),
    scope: z.string().min(1),
    rowTitle: z.string().optional(),
  })
  .strict();

export const budgetLineReferenceUnresolvedV1Schema = z
  .object({
    referenceKind: z.literal('unresolved_reference'),
    rawText: z.string().min(1),
  })
  .strict();

export const budgetLineReferenceV1Schema = z.discriminatedUnion('referenceKind', [
  budgetLineReferencePeCodeV1Schema,
  budgetLineReferenceProcurementV1Schema,
  budgetLineReferenceOmSagV1Schema,
  budgetLineReferenceMilconV1Schema,
  budgetLineReferencePackageScopeV1Schema,
  budgetLineReferenceUnresolvedV1Schema,
]);
export type BudgetLineReferenceV1 = z.infer<typeof budgetLineReferenceV1Schema>;

/* ------------------------------------------------------------------ */
/* reviewed alias/binding map                                          */
/* ------------------------------------------------------------------ */

export const stageAliasMapEntryV1Schema = z
  .object({
    /** Exact source token as printed (e.g. row label or short code). */
    sourceToken: z.string().min(1),
    /** Exact native identity the token binds to. */
    identity: budgetLineIdentityV1Schema,
    /** Fiscal year the binding is effective for. */
    effectiveFiscalYear: z.number().int().min(1900).max(2200),
    /** Profile ID the binding was reviewed against. */
    sourceProfileId: z.string().min(1),
    author: z.string().min(1),
    reviewer: z.string().min(1),
    reviewedAt: z.string().min(1),
  })
  .strict();
export type StageAliasMapEntryV1 = z.infer<typeof stageAliasMapEntryV1Schema>;

export const stageAliasMapV1Schema = z
  .object({
    aliasMapVersion: z.string().min(1),
    entries: z.array(stageAliasMapEntryV1Schema),
  })
  .strict();
export type StageAliasMapV1 = z.infer<typeof stageAliasMapV1Schema>;

/** Deterministic hash of a reviewed alias map (canonical JSON). */
export function stageAliasMapHashV1(aliasMap: StageAliasMapV1): string {
  return sha256CanonicalJson(aliasMap as unknown as JsonValue);
}

/* ------------------------------------------------------------------ */
/* resolved binding                                                    */
/* ------------------------------------------------------------------ */

export const RESOLUTION_BASIS_V1_VALUES = [
  'exact_identity',
  'code_plus_unique_context',
  'reviewed_alias',
  'title_candidate',
  'none',
] as const;
export const resolutionBasisV1Schema = z.enum(RESOLUTION_BASIS_V1_VALUES);
export type ResolutionBasisV1 = z.infer<typeof resolutionBasisV1Schema>;

export const BINDING_STATUS_V1_VALUES = [
  'accepted',
  'candidate',
  'unresolved',
  'conflicting',
] as const;
export const bindingStatusV1Schema = z.enum(BINDING_STATUS_V1_VALUES);
export type BindingStatusV1 = z.infer<typeof bindingStatusV1Schema>;

export interface ResolvedBudgetLineBindingV1 {
  reference: BudgetLineReferenceV1;
  /** Present only for accepted bindings. */
  targetIdentity?: BudgetLineIdentityV1;
  /** All plausible identities, present for candidate/conflicting. */
  candidates: BudgetLineIdentityV1[];
  basis: ResolutionBasisV1;
  /**
   * Confidence is informational only: candidate/conflicting bindings can
   * never machine-pass verification regardless of this value.
   */
  confidence: number;
  status: BindingStatusV1;
  supportingEvidenceIds: string[];
  aliasMapVersion?: string;
  aliasMapHash?: string;
}

/**
 * Candidate and conflicting bindings can never machine-pass stage
 * verification. This is the single choke point verification uses.
 */
export function bindingMachinePassAllowed(binding: ResolvedBudgetLineBindingV1): boolean {
  return binding.status === 'accepted';
}

/** Canonical natural key for a native identity (deterministic ordering). */
export function nativeIdentityKeyV1(identity: BudgetLineIdentityV1): string {
  switch (identity.lineKind) {
    case 'RDTE_PE':
      return `RDTE_PE:${identity.peCode}`;
    case 'PROCUREMENT_BLIN':
      return `PROCUREMENT_BLIN:${identity.component}:${identity.account}:${identity.code}:${
        identity.advanceProcurement === true ? 'advance' : 'base'
      }`;
    case 'OM_SAG':
      return `OM_SAG:${identity.component}:${identity.account}:${identity.code}`;
    case 'MILCON_PROJECT':
      return `MILCON_PROJECT:${identity.component}:${identity.projectCode}`;
    case 'UNKNOWN':
      return `UNKNOWN:${identity.code}`;
  }
}
