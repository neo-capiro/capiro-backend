/**
 * Phase 6 Workstream B — deterministic line-reference resolver.
 *
 * Resolves raw congressional row references against a caller-supplied native
 * identity index (Phase 4/5 verified request corpus). Pure and deterministic:
 * same inputs always produce the same binding.
 *
 * Resolution order:
 *   1. exact full native identity;
 *   2. exact code plus unique manifest context;
 *   3. exact reviewed alias/binding map entry;
 *   4. candidate only (title similarity — never accepted);
 *   5. unresolved.
 *
 * The resolver never queries or creates `program_element` rows and never uses
 * title similarity for an accepted binding.
 */
import type { BudgetLineIdentityV1 } from '../contracts/extraction-artifact-v1.js';
import {
  budgetLineReferenceV1Schema,
  nativeIdentityKeyV1,
  stageAliasMapHashV1,
  type BudgetLineReferenceV1,
  type ResolvedBudgetLineBindingV1,
  type ResolutionBasisV1,
  type StageAliasMapEntryV1,
  type StageAliasMapV1,
} from './budget-line-reference-v1.js';

/* ------------------------------------------------------------------ */
/* resolution context                                                  */
/* ------------------------------------------------------------------ */

/**
 * One known native identity from the Phase 4/5 request corpus. The resolver
 * never queries or creates `program_element` rows; this index is supplied by
 * the caller from verified request artifacts.
 */
export interface NativeIdentityIndexEntry {
  identity: BudgetLineIdentityV1;
  manifestDocumentKey: string;
  /** Printed title — evidence for candidate generation, never identity. */
  title?: string;
}

export interface LineReferenceResolutionContext {
  index: readonly NativeIdentityIndexEntry[];
  aliasMap?: StageAliasMapV1;
  aliasMapHash?: string;
  fiscalYear: number;
  profileId: string;
}

/* ------------------------------------------------------------------ */
/* resolver                                                            */
/* ------------------------------------------------------------------ */

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Resolve one raw stage reference against the native identity index.
 */
export function resolveBudgetLineReferenceV1(
  reference: BudgetLineReferenceV1,
  context: LineReferenceResolutionContext,
): ResolvedBudgetLineBindingV1 {
  const parsedReference = budgetLineReferenceV1Schema.parse(reference);

  /* -- explicit unresolved / package scope --------------------------- */

  if (parsedReference.referenceKind === 'unresolved_reference') {
    return unresolved(parsedReference);
  }
  if (parsedReference.referenceKind === 'package_scope') {
    return unresolved(parsedReference);
  }

  const indexEntries = context.index.filter((entry) => entry.identity.lineKind !== 'UNKNOWN');

  /* -- 1. exact full native identity ---------------------------------- */

  const exactMatches = distinctIdentities(findExactIdentityMatches(parsedReference, indexEntries));
  if (exactMatches.length === 1) {
    return acceptedBinding(parsedReference, exactMatches[0]!.identity, 'exact_identity', 1);
  }
  if (exactMatches.length > 1) {
    return {
      reference: parsedReference,
      candidates: exactMatches.map((entry) => entry.identity),
      basis: 'exact_identity',
      confidence: 0,
      status: 'conflicting',
      supportingEvidenceIds: [],
    };
  }

  /* -- 2. exact code + unique manifest context ------------------------ */

  const contextMatches = distinctIdentities(findContextMatches(parsedReference, indexEntries));
  if (contextMatches.length === 1) {
    return acceptedBinding(
      parsedReference,
      contextMatches[0]!.identity,
      'code_plus_unique_context',
      1,
    );
  }
  if (contextMatches.length > 1) {
    return {
      reference: parsedReference,
      candidates: contextMatches.map((entry) => entry.identity),
      basis: 'code_plus_unique_context',
      confidence: 0,
      status: 'conflicting',
      supportingEvidenceIds: [],
    };
  }

  /* -- 3. exact reviewed alias map ------------------------------------ */

  const aliasMatch = findAliasMatch(parsedReference, context);
  if (aliasMatch != null) {
    const binding = acceptedBinding(
      parsedReference,
      aliasMatch.entry.identity,
      'reviewed_alias',
      1,
    );
    binding.aliasMapVersion = context.aliasMap!.aliasMapVersion;
    binding.aliasMapHash = context.aliasMapHash ?? stageAliasMapHashV1(context.aliasMap!);
    return binding;
  }

  /* -- 4. title-only candidates --------------------------------------- */

  const titleCandidates = findTitleCandidates(parsedReference, indexEntries);
  if (titleCandidates.length > 0) {
    return {
      reference: parsedReference,
      candidates: titleCandidates.map((entry) => entry.identity),
      basis: 'title_candidate',
      confidence: 0,
      status: 'candidate',
      supportingEvidenceIds: [],
    };
  }

  /* -- 5. unresolved --------------------------------------------------- */

  return unresolved(parsedReference);
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function unresolved(reference: BudgetLineReferenceV1): ResolvedBudgetLineBindingV1 {
  return {
    reference,
    candidates: [],
    basis: 'none',
    confidence: 0,
    status: 'unresolved',
    supportingEvidenceIds: [],
  };
}

function acceptedBinding(
  reference: BudgetLineReferenceV1,
  identity: BudgetLineIdentityV1,
  basis: ResolutionBasisV1,
  confidence: number,
): ResolvedBudgetLineBindingV1 {
  return {
    reference,
    targetIdentity: identity,
    candidates: [identity],
    basis,
    confidence,
    status: 'accepted',
    supportingEvidenceIds: [],
  };
}

function componentOf(reference: BudgetLineReferenceV1): string | null {
  switch (reference.referenceKind) {
    case 'procurement_line':
    case 'om_sag':
    case 'milcon_project':
      return reference.component ?? null;
    default:
      return null;
  }
}

/**
 * Collapse index entries that name the SAME native identity (e.g. the same PE
 * printed in two exhibits). Distinct targets still conflict; duplicates of one
 * target never do. First entry wins for provenance — deterministic.
 */
function distinctIdentities(entries: NativeIdentityIndexEntry[]): NativeIdentityIndexEntry[] {
  const seen = new Map<string, NativeIdentityIndexEntry>();
  for (const entry of entries) {
    const key = nativeIdentityKeyV1(entry.identity);
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()];
}

function findExactIdentityMatches(
  reference: BudgetLineReferenceV1,
  index: readonly NativeIdentityIndexEntry[],
): NativeIdentityIndexEntry[] {
  switch (reference.referenceKind) {
    case 'pe_code':
      return index.filter(
        (entry) =>
          entry.identity.lineKind === 'RDTE_PE' && entry.identity.peCode === reference.peCode,
      );
    case 'procurement_line': {
      if (reference.account == null || reference.component == null) return [];
      const account = reference.account;
      const component = reference.component.toUpperCase();
      const advance = reference.advanceProcurement === true;
      return index.filter(
        (entry) =>
          entry.identity.lineKind === 'PROCUREMENT_BLIN' &&
          entry.identity.code === reference.lineCode &&
          entry.identity.account === account &&
          entry.identity.component === component &&
          (entry.identity.advanceProcurement === true) === advance,
      );
    }
    case 'om_sag': {
      if (reference.account == null || reference.component == null) return [];
      const account = reference.account;
      const component = reference.component.toUpperCase();
      return index.filter(
        (entry) =>
          entry.identity.lineKind === 'OM_SAG' &&
          entry.identity.code === reference.sagCode &&
          entry.identity.account === account &&
          entry.identity.component === component,
      );
    }
    case 'milcon_project': {
      if (reference.component == null) return [];
      const component = reference.component.toUpperCase();
      return index.filter(
        (entry) =>
          entry.identity.lineKind === 'MILCON_PROJECT' &&
          entry.identity.projectCode === reference.projectCode &&
          entry.identity.component === component,
      );
    }
    default:
      return [];
  }
}

/**
 * Exact code plus unique manifest context: the reference carries enough
 * namespace information that exactly one index entry matches, even when the
 * full tuple was not all stated. Missing namespace fields fall back to
 * alias/title paths — they never widen the match set.
 */
function findContextMatches(
  reference: BudgetLineReferenceV1,
  index: readonly NativeIdentityIndexEntry[],
): NativeIdentityIndexEntry[] {
  switch (reference.referenceKind) {
    case 'procurement_line': {
      if (reference.account == null) return [];
      const advance = reference.advanceProcurement === true;
      return index.filter(
        (entry) =>
          entry.identity.lineKind === 'PROCUREMENT_BLIN' &&
          entry.identity.code === reference.lineCode &&
          entry.identity.account === reference.account &&
          (entry.identity.advanceProcurement === true) === advance &&
          (reference.component == null ||
            entry.identity.component === reference.component.toUpperCase()),
      );
    }
    case 'om_sag': {
      if (reference.account == null) return [];
      return index.filter(
        (entry) =>
          entry.identity.lineKind === 'OM_SAG' &&
          entry.identity.code === reference.sagCode &&
          entry.identity.account === reference.account &&
          (reference.component == null ||
            entry.identity.component === reference.component.toUpperCase()),
      );
    }
    case 'milcon_project':
      // MILCON project codes are only unique with component; handled above.
      return [];
    default:
      return [];
  }
}

function findAliasMatch(
  reference: BudgetLineReferenceV1,
  context: LineReferenceResolutionContext,
): { entry: StageAliasMapEntryV1 } | null {
  if (context.aliasMap == null) return null;
  const token = referenceToken(reference);
  if (token == null) return null;
  const matches = context.aliasMap.entries.filter(
    (entry) =>
      entry.sourceToken === token &&
      entry.effectiveFiscalYear === context.fiscalYear &&
      entry.sourceProfileId === context.profileId,
  );
  if (matches.length !== 1) return null;
  return { entry: matches[0]! };
}

function findTitleCandidates(
  reference: BudgetLineReferenceV1,
  index: readonly NativeIdentityIndexEntry[],
): NativeIdentityIndexEntry[] {
  const title = rowTitleOf(reference);
  if (title == null) return [];
  const normalized = normalizeText(title);
  if (normalized.length === 0) return [];
  return index.filter((entry) => entry.title != null && normalizeText(entry.title) === normalized);
}

function referenceToken(reference: BudgetLineReferenceV1): string | null {
  switch (reference.referenceKind) {
    case 'pe_code':
      return reference.peCode;
    case 'procurement_line':
      return reference.lineCode;
    case 'om_sag':
      return reference.sagCode;
    case 'milcon_project':
      return reference.projectCode;
    default:
      return null;
  }
}

function rowTitleOf(reference: BudgetLineReferenceV1): string | null {
  switch (reference.referenceKind) {
    case 'pe_code':
    case 'procurement_line':
    case 'om_sag':
    case 'milcon_project':
    case 'package_scope':
      return reference.rowTitle ?? null;
    default:
      return null;
  }
}

/** Component accessor exported for callers that need namespace context. */
export function referenceComponentV1(reference: BudgetLineReferenceV1): string | null {
  return componentOf(reference);
}
