/**
 * non-rdte-cycle-reconciler-v1 — cross-exhibit reconciliation for one
 * non-RDT&E cycle.
 *
 * Workstream N (Phase 5 plan §14). Combines identity, funding reconciliation
 * (from family composers), and coverage into one deterministic
 * reconciliation result. Pure module.
 */
import type {
  NonRdteCycleCoverageEntryV1,
  NonRdteCycleFindingV1,
} from './non-rdte-cycle-bundle-v1.js';

/* ------------------------------------------------------------------ */
/* Input types                                                         */
/* ------------------------------------------------------------------ */

export interface NonRdteIdentityCatalogV1 {
  /** Identity natural keys from the summary exhibit (P-1, O-1, or C-1). */
  summaryIdentityKeys: readonly string[];
  /** Identity natural keys from the detail exhibit (P-40, OP-5, or DD1391). */
  detailIdentityKeys: readonly string[];
  /** Required identity keys from the manifest. */
  requiredIdentityKeys: readonly string[];
}

export interface NonRdteFundingComparisonV1 {
  identityNaturalKey: string;
  fiscalYear: number;
  result: 'pass' | 'fail' | 'review' | 'not_applicable';
  message?: string;
}

export interface NonRdteCycleReconcileInput {
  identity: NonRdteIdentityCatalogV1;
  fundingComparisons: readonly NonRdteFundingComparisonV1[];
  /** Category coverage inputs. */
  coverageInputs: readonly NonRdteCategoryCoverageInput[];
  /** Optional: identities with blocking omissions remaining. */
  blockingOmissionKeys?: readonly string[];
  /** Optional: unresolved source pages. */
  unresolvedPages?: readonly number[];
}

export interface NonRdteCategoryCoverageInput {
  category: string;
  expectedKeys: readonly string[];
  coveredKeys: readonly string[];
  applicable: boolean;
}

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

export interface NonRdteCycleReconciliationResult {
  identity: { complete: boolean };
  funding: { complete: boolean };
  coverage: readonly NonRdteCycleCoverageEntryV1[];
  findings: readonly NonRdteCycleFindingV1[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function computeCoverageEntry(input: NonRdteCategoryCoverageInput): NonRdteCycleCoverageEntryV1 {
  if (!input.applicable) {
    return {
      category: input.category,
      status: 'not_applicable',
      numerator: 0,
      denominator: 0,
      missingKeys: [],
    };
  }
  const expected = new Set(input.expectedKeys);
  const covered = new Set(input.coveredKeys);
  const missing = [...expected].filter((k) => !covered.has(k)).sort();
  const status = missing.length === 0 ? 'complete' : covered.size === 0 ? 'missing' : 'partial';
  return {
    category: input.category,
    status,
    numerator: covered.size,
    denominator: expected.size,
    missingKeys: missing,
  };
}

/* ------------------------------------------------------------------ */
/* Reconciler                                                          */
/* ------------------------------------------------------------------ */

export function reconcileNonRdteCycle(
  input: NonRdteCycleReconcileInput,
): NonRdteCycleReconciliationResult {
  const findings: NonRdteCycleFindingV1[] = [];
  let findingSeq = 0;
  const nextId = (code: string) => `recon_${code}_${++findingSeq}`;

  /* Identity reconciliation. */
  const summarySet = new Set(input.identity.summaryIdentityKeys);
  const detailSet = new Set(input.identity.detailIdentityKeys);
  const requiredSet = new Set(input.identity.requiredIdentityKeys);

  /* Missing required identities. */
  for (const key of input.identity.requiredIdentityKeys) {
    if (!summarySet.has(key)) {
      findings.push({
        findingId: nextId('missing_identity'),
        severity: 'blocking',
        code: 'required_identity_missing',
        message: `Required identity ${key} is missing from summary exhibit`,
        evidenceIds: [],
      });
    }
  }

  /* Orphan detail identities (in detail but not in summary). */
  for (const key of input.identity.detailIdentityKeys) {
    if (!summarySet.has(key) && !requiredSet.has(key)) {
      findings.push({
        findingId: nextId('orphan_detail'),
        severity: 'review',
        code: 'orphan_detail_identity',
        message: `Detail identity ${key} has no matching summary identity`,
        evidenceIds: [],
      });
    }
  }

  /* Duplicate identity detection. We check for duplicates within
   * the summary list and within the detail list separately — the same
   * key legitimately appearing in both summary and detail (e.g. P-1
   * and P-40 for the same BLIN) is NOT a duplicate. */
  const checkDuplicates = (keys: readonly string[], label: string): void => {
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) {
        findings.push({
          findingId: nextId('duplicate_identity'),
          severity: 'blocking',
          code: 'duplicate_natural_key',
          message: `Duplicate ${label} identity natural key: ${key}`,
          evidenceIds: [],
        });
      }
      seen.add(key);
    }
  };
  checkDuplicates(input.identity.summaryIdentityKeys, 'summary');
  checkDuplicates(input.identity.detailIdentityKeys, 'detail');

  const identityComplete = !findings.some((f) => f.code === 'required_identity_missing');

  /* Funding reconciliation. */
  let fundingComplete = true;
  for (const comparison of input.fundingComparisons) {
    if (comparison.result === 'fail') {
      fundingComplete = false;
      findings.push({
        findingId: nextId('funding_mismatch'),
        severity: 'blocking',
        code: 'summary_detail_funding_mismatch',
        message:
          comparison.message ??
          `Funding mismatch for ${comparison.identityNaturalKey} FY${comparison.fiscalYear}`,
        evidenceIds: [],
      });
    } else if (comparison.result === 'review') {
      findings.push({
        findingId: nextId('funding_review'),
        severity: 'review',
        code: 'funding_review',
        message:
          comparison.message ??
          `Funding review needed for ${comparison.identityNaturalKey} FY${comparison.fiscalYear}`,
        evidenceIds: [],
      });
    }
  }

  /* Blocking omissions. */
  if (input.blockingOmissionKeys) {
    for (const key of input.blockingOmissionKeys) {
      findings.push({
        findingId: nextId('blocking_omission'),
        severity: 'blocking',
        code: 'blocking_omission_remaining',
        message: `Blocking omission remaining for ${key}`,
        evidenceIds: [],
      });
    }
  }

  /* Unresolved pages. */
  if (input.unresolvedPages && input.unresolvedPages.length > 0) {
    findings.push({
      findingId: nextId('unresolved_pages'),
      severity: 'blocking',
      code: 'unresolved_source_page',
      message: `${input.unresolvedPages.length} unresolved source page(s)`,
      evidenceIds: [],
    });
  }

  /* Coverage. */
  const coverage = input.coverageInputs.map(computeCoverageEntry);
  for (const entry of coverage) {
    if (entry.status === 'missing') {
      findings.push({
        findingId: nextId('coverage_missing'),
        severity: 'blocking',
        code: 'category_coverage_missing',
        message: `Category ${entry.category} is missing (${entry.numerator}/${entry.denominator})`,
        evidenceIds: [],
      });
    }
  }

  findings.sort((a, b) => {
    const sev = a.severity.localeCompare(b.severity);
    if (sev !== 0) return sev;
    const code = a.code.localeCompare(b.code);
    if (code !== 0) return code;
    return a.message.localeCompare(b.message);
  });

  return {
    identity: { complete: identityComplete },
    funding: { complete: fundingComplete },
    coverage,
    findings,
  };
}
