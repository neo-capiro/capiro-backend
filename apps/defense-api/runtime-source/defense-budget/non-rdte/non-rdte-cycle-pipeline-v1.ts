/**
 * non-rdte-cycle-pipeline-v1 — pure composition of the Phase 5 non-RDT&E
 * cycle:
 *
 *   manifest + per-document artifacts
 *     -> family composers (procurement / O&M / MILCON)
 *     -> cross-exhibit reconciliation
 *     -> cycle certification
 *
 * The pipeline is PURE: verification decisions enter as input references
 * (produced by the Phase 2 verifier at the command boundary), and the
 * pipeline never reads or writes a database. Commands wire infrastructure;
 * this module decides semantics.
 *
 * Workstream N (Phase 5 plan §14). Rules preserved end-to-end:
 *   - only certified family results become projection candidates;
 *   - summary/detail funding reconciliation is blocking;
 *   - duplicates and orphans surface as findings, never last-wins;
 *   - OCR-derived money cannot auto-pass;
 *   - no canonical writes.
 */
import type { DefenseBudgetExtractionArtifactV1 } from '../contracts/extraction-artifact-v1.js';
import type { BudgetCycleManifestDocumentV1 } from '../contracts/budget-cycle-manifest-v1.js';
import type { JsonValue } from '../contracts/canonical-json.js';

import type { ProcurementFamilyReport } from '../procurement/procurement-composer-v1.js';
import type { OmFamilyReport } from '../om/om-composer-v1.js';
import type { MilconFamilyReport } from '../milcon/milcon-composer-v1.js';

import {
  reconcileNonRdteCycle,
  type NonRdteCycleReconcileInput,
  type NonRdteFundingComparisonV1,
} from './non-rdte-cycle-reconciler-v1.js';
import {
  certifyNonRdteCycle,
  type NonRdteCycleCertifyInput,
} from './non-rdte-cycle-certifier-v1.js';
import type {
  NonRdteCycleBundleV1,
  NonRdteCycleCertificationV1,
  NonRdteCycleSourceDocumentV1,
  NonRdteCycleVerificationRefV1,
} from './non-rdte-cycle-bundle-v1.js';

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

export interface NonRdteCycleDocumentInput {
  document: BudgetCycleManifestDocumentV1;
  artifact: DefenseBudgetExtractionArtifactV1;
}

export interface NonRdteCyclePipelineInput {
  cycleIdIdentity: JsonValue;
  fiscalYear: number;
  family: 'procurement' | 'om' | 'milcon';
  manifestContentSha256: string;
  documents: readonly NonRdteCycleDocumentInput[];
  /** Phase 2 verification references (produced at the command boundary). */
  verifications: readonly NonRdteCycleVerificationRefV1[];
  /** Immutable reviewed acceptances allowed by Phase 2 policy. */
  allowedReviewedAcceptances?: ReadonlySet<string>;
  /** Family report from the appropriate composer. */
  familyReport: ProcurementFamilyReport | OmFamilyReport | MilconFamilyReport;
  /** Manifest-driven required identity keys. */
  requiredIdentityKeys: readonly string[];
}

export interface NonRdteCyclePipelineResult {
  certification: NonRdteCycleCertificationV1;
  bundle: NonRdteCycleBundleV1;
  reason: string;
  counts: {
    artifactCount: number;
    identityCount: number;
    fundingComparisonCount: number;
    blockingFindingCount: number;
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function extractIdentityKeys(
  report: ProcurementFamilyReport | OmFamilyReport | MilconFamilyReport,
): { summary: string[]; detail: string[] } {
  const identities = report.identities;
  const summary: string[] = [];
  const detail: string[] = [];

  for (const id of identities) {
    const key = id.naturalKey;
    const exhibits = id.exhibits;
    const isSummary = exhibits.some((e) => e === 'P-1' || e === 'O-1' || e === 'C-1');
    const isDetail = exhibits.some(
      (e) =>
        e === 'P-40' ||
        e === 'OP-5' ||
        e === 'DD1391' ||
        e === 'P-5' ||
        e === 'P-21' ||
        e === 'P-3A',
    );
    if (isSummary) summary.push(key);
    if (isDetail) detail.push(key);
    if (!isSummary && !isDetail) {
      /* Unexhibited identities go to summary as fallback. */
      summary.push(key);
    }
  }

  return {
    summary: [...new Set(summary)].sort(),
    detail: [...new Set(detail)].sort(),
  };
}

function extractFundingComparisons(
  report: ProcurementFamilyReport | OmFamilyReport | MilconFamilyReport,
): NonRdteFundingComparisonV1[] {
  const comparisons = report.fundingComparisons ?? [];
  return comparisons.map(
    (c: {
      identityNaturalKey?: string;
      naturalKey?: string;
      fiscalYear?: number;
      result?: string;
      message?: string;
    }) => ({
      identityNaturalKey: c.identityNaturalKey ?? c.naturalKey ?? 'unknown',
      fiscalYear: c.fiscalYear ?? 0,
      result: (c.result ?? 'not_applicable') as 'pass' | 'fail' | 'review' | 'not_applicable',
      ...(c.message != null ? { message: c.message } : {}),
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

export function runNonRdteCyclePipeline(
  input: NonRdteCyclePipelineInput,
): NonRdteCyclePipelineResult {
  const { familyReport, requiredIdentityKeys } = input;

  /* Build source-document entries. */
  const sourceDocuments: NonRdteCycleSourceDocumentV1[] = input.documents.map((doc) => ({
    manifestDocumentKey: doc.document.documentKey,
    family: doc.document.family as 'procurement' | 'om' | 'milcon',
    exhibit: doc.document.exhibit,
    required: doc.document.required,
    sourcePdfSha256: doc.artifact.source.sourcePdfSha256,
    sourceLocator: doc.artifact.source.sourceLocator,
  }));

  /* Build artifact references. */
  const artifacts = input.documents.map((doc) => ({
    manifestDocumentKey: doc.document.documentKey,
    artifactId: doc.artifact.artifactId,
    artifactContentSha256: doc.artifact.contentSha256,
  }));

  /* Extract identity and funding from the family report. */
  const { summary: summaryKeys, detail: detailKeys } = extractIdentityKeys(familyReport);
  const fundingComparisons = extractFundingComparisons(familyReport);

  /* Coverage inputs. */
  const coverageInputs = [
    {
      category: 'identity',
      expectedKeys: requiredIdentityKeys,
      coveredKeys: summaryKeys,
      applicable: requiredIdentityKeys.length > 0,
    },
    {
      category: 'detail',
      expectedKeys: summaryKeys,
      coveredKeys: detailKeys,
      applicable: summaryKeys.length > 0,
    },
  ];

  /* Reconcile. */
  const reconcileInput: NonRdteCycleReconcileInput = {
    identity: {
      summaryIdentityKeys: summaryKeys,
      detailIdentityKeys: detailKeys,
      requiredIdentityKeys,
    },
    fundingComparisons,
    coverageInputs,
  };
  const reconciliation = reconcileNonRdteCycle(reconcileInput);

  /* Certify. */
  const certifyInput: NonRdteCycleCertifyInput = {
    cycleIdIdentity: input.cycleIdIdentity,
    fiscalYear: input.fiscalYear,
    family: input.family,
    manifestContentSha256: input.manifestContentSha256,
    sourceDocuments,
    artifacts,
    verifications: input.verifications,
    reconciliation,
    ...(input.allowedReviewedAcceptances != null
      ? { allowedReviewedAcceptances: input.allowedReviewedAcceptances }
      : {}),
  };
  const { certification, bundle, reason } = certifyNonRdteCycle(certifyInput);

  return {
    certification,
    bundle,
    reason,
    counts: {
      artifactCount: artifacts.length,
      identityCount: summaryKeys.length,
      fundingComparisonCount: fundingComparisons.length,
      blockingFindingCount: bundle.blockingFindings.length,
    },
  };
}
