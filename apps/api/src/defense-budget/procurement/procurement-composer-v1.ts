/**
 * procurement-composer-v1 — compose all procurement exhibits into one
 * noncanonical verified family view.
 *
 * Workstream F (Phase 5 plan §6). Composes artifacts by native identity and
 * FY without discarding individual source assertions. Requires trusted proof
 * for every source artifact through Phase 2. Produces a procurement family
 * report containing identities, verified assertions, unresolved assertions,
 * source-specific values, reconciliation results, missing exhibits,
 * completeness status.
 *
 * Pure module. No database, no parser, no writer. No canonical writes.
 * No ProgramElementWriterService or legacy P-doc loader calls.
 */
import type { DefenseBudgetExtractionArtifactV1 } from '../contracts/extraction-artifact-v1.js';
import type { ProcurementBlinIdentityV1 } from '../non-rdte/identity-v1.js';
import {
  reconcileProcurementFunding,
  type ProcurementFundingComparison,
  type ProcurementFundingValueV1,
} from './procurement-reconciliation-v1.js';
import {
  verifyProcurementFamily,
  type ProcurementVerificationResult,
  type ProcurementIdentityInput,
  type ProcurementVerificationInput,
} from './procurement-verification-policy-v1.js';

/* ------------------------------------------------------------------ */
/* Composer input                                                       */
/* ------------------------------------------------------------------ */

export interface ProcurementExhibitArtifacts {
  p1Artifacts: readonly DefenseBudgetExtractionArtifactV1[];
  p40Artifacts: readonly DefenseBudgetExtractionArtifactV1[];
  p5Artifacts: readonly DefenseBudgetExtractionArtifactV1[];
  p21Artifacts: readonly DefenseBudgetExtractionArtifactV1[];
  p3aArtifacts: readonly DefenseBudgetExtractionArtifactV1[];
}

export interface ProcurementCompositionInput {
  artifacts: ProcurementExhibitArtifacts;
  /** Manifest-driven requirements. */
  requiredIdentityKeys: readonly string[];
  p40Required: boolean;
  enrichmentRequired: boolean;
  requiredQuantityCategories: readonly string[];
  requiredUnitCostCategories: readonly string[];
  requiredNarrativeSections: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Composer output                                                      */
/* ------------------------------------------------------------------ */

export interface ProcurementFamilyReport {
  identities: Array<{
    naturalKey: string;
    printedCode: string;
    account: string;
    component: string;
    advanceProcurement: boolean;
    exhibits: string[];
  }>;
  fundingComparisons: ProcurementFundingComparison[];
  verification: ProcurementVerificationResult;
  missingExhibits: string[];
  completenessStatus: 'complete' | 'incomplete' | 'needs_review';
  artifactCount: number;
  assertionCount: number;
}

/* ------------------------------------------------------------------ */
/* Composer                                                             */
/* ------------------------------------------------------------------ */

/**
 * Compose all procurement exhibit artifacts into one noncanonical family
 * view. Reconciles P-1 ↔ P-40 funding, runs family-specific verification,
 * and produces a completeness report.
 *
 * No canonical writer or legacy P-doc loader call is permitted.
 */
export function composeProcurementFamily(
  input: ProcurementCompositionInput,
): ProcurementFamilyReport {
  const { artifacts, requiredIdentityKeys, requiredQuantityCategories, requiredUnitCostCategories, requiredNarrativeSections } = input;

  /* Collect all identities from all artifacts. */
  const identityMap = new Map<string, {
    naturalKey: string;
    printedCode: string;
    account: string;
    component: string;
    advanceProcurement: boolean;
    exhibits: Set<string>;
  }>();

  /* Extract identities from artifacts by examining assertions. */
  const p1Identities: ProcurementIdentityInput[] = [];
  const p40Identities: ProcurementIdentityInput[] = [];
  const p5P21P3aIdentities: ProcurementIdentityInput[] = [];
  const p1FundingValues: ProcurementFundingValueV1[] = [];
  const p40FundingValues: ProcurementFundingValueV1[] = [];

  /* Process P-1 artifacts */
  for (const artifact of artifacts.p1Artifacts) {
    for (const assertion of artifact.assertions) {
      if (assertion.assertionKind === 'procurement_line' && assertion.parentIdentity.lineKind === 'PROCUREMENT_BLIN') {
        const pi = assertion.parentIdentity;
        const identity = buildIdentityFromProcurementLine(pi, assertion.assertionKind);
        if (identity != null) {
          const existing = identityMap.get(identity.naturalKey) ?? {
            naturalKey: identity.naturalKey,
            printedCode: identity.printedCode,
            account: identity.account,
            component: identity.component,
            advanceProcurement: identity.advanceProcurement,
            exhibits: new Set<string>(),
          };
          existing.exhibits.add('P-1');
          identityMap.set(identity.naturalKey, existing);

          p1Identities.push({
            naturalKey: identity.naturalKey,
            printedCode: identity.printedCode,
            account: identity.account,
            component: identity.component,
            advanceProcurement: identity.advanceProcurement,
            exhibit: 'P-1',
            page: (assertion.metadata?.page as number) ?? 0,
            hasQuantity: assertion.quantity != null,
            hasUnitCost: assertion.unitCostDollars != null,
            hasNarrative: false,
            referencedPeCodes: [],
          });
        }
      }
      if (assertion.assertionKind === 'funding' && assertion.identity.lineKind === 'PROCUREMENT_BLIN') {
        const fi = assertion.identity;
        const naturalKey = `PROCUREMENT_BLIN:${fi.component}:${fi.account}:${fi.code}:${fi.advanceProcurement ? 'advance' : 'base'}`;
        p1FundingValues.push({
          identityNaturalKey: naturalKey,
          identity: fi as unknown as ProcurementBlinIdentityV1,
          fiscalYear: assertion.fiscalYear,
          columnBinding: {
            columnIndex: (assertion.metadata?.columnIndex as number) ?? 0,
            headerText: (assertion.metadata?.headerText as string) ?? '',
            ...(assertion.fiscalYear != null ? { fiscalYear: assertion.fiscalYear } : {}),
            valueKind: 'money',
            baseOcoStatus: (assertion.metadata?.baseOcoStatus as string) ?? 'none',
            fundingStage: (assertion.metadata?.fundingStage as string) ?? 'unknown',
            confident: true,
            reason: 'from artifact',
          } as unknown as import('../non-rdte/column-semantics-v1.js').ColumnBindingV1,
          originalValue: assertion.money.originalValue,
          originalUnit: assertion.money.originalUnit,
          valueMillions: assertion.money.valueMillions,
          page: (assertion.metadata?.page as number) ?? 0,
        });
      }
    }
  }

  /* Process P-40 artifacts */
  for (const artifact of artifacts.p40Artifacts) {
    for (const assertion of artifact.assertions) {
      if (assertion.assertionKind === 'procurement_line' && assertion.parentIdentity.lineKind === 'PROCUREMENT_BLIN') {
        const pi = assertion.parentIdentity;
        const identity = buildIdentityFromProcurementLine(pi, assertion.assertionKind);
        if (identity != null) {
          const existing = identityMap.get(identity.naturalKey) ?? {
            naturalKey: identity.naturalKey,
            printedCode: identity.printedCode,
            account: identity.account,
            component: identity.component,
            advanceProcurement: identity.advanceProcurement,
            exhibits: new Set<string>(),
          };
          existing.exhibits.add('P-40');
          identityMap.set(identity.naturalKey, existing);

          p40Identities.push({
            naturalKey: identity.naturalKey,
            printedCode: identity.printedCode,
            account: identity.account,
            component: identity.component,
            advanceProcurement: identity.advanceProcurement,
            exhibit: 'P-40',
            page: (assertion.metadata?.page as number) ?? 0,
            hasQuantity: assertion.quantity != null,
            hasUnitCost: assertion.unitCostDollars != null,
            hasNarrative: artifact.assertions.some((a) => a.assertionKind === 'narrative'),
            referencedPeCodes: [],
          });
        }
      }
      if (assertion.assertionKind === 'funding' && assertion.identity.lineKind === 'PROCUREMENT_BLIN') {
        const fi = assertion.identity;
        const naturalKey = `PROCUREMENT_BLIN:${fi.component}:${fi.account}:${fi.code}:${fi.advanceProcurement ? 'advance' : 'base'}`;
        p40FundingValues.push({
          identityNaturalKey: naturalKey,
          identity: fi as unknown as ProcurementBlinIdentityV1,
          fiscalYear: assertion.fiscalYear,
          columnBinding: {
            columnIndex: (assertion.metadata?.columnIndex as number) ?? 0,
            headerText: (assertion.metadata?.headerText as string) ?? '',
            ...(assertion.fiscalYear != null ? { fiscalYear: assertion.fiscalYear } : {}),
            valueKind: 'money',
            baseOcoStatus: (assertion.metadata?.baseOcoStatus as string) ?? 'none',
            fundingStage: (assertion.metadata?.fundingStage as string) ?? 'unknown',
            confident: true,
            reason: 'from artifact',
          } as unknown as import('../non-rdte/column-semantics-v1.js').ColumnBindingV1,
          originalValue: assertion.money.originalValue,
          originalUnit: assertion.money.originalUnit,
          valueMillions: assertion.money.valueMillions,
          page: (assertion.metadata?.page as number) ?? 0,
        });
      }
    }
  }

  /* Process P-5, P-21, P-3A artifacts */
  for (const [exhibit, artifactList] of [
    ['P-5', artifacts.p5Artifacts],
    ['P-21', artifacts.p21Artifacts],
    ['P-3A', artifacts.p3aArtifacts],
  ] as const) {
    for (const artifact of artifactList) {
      for (const assertion of artifact.assertions) {
        const identity = extractIdentityFromAssertion(assertion);
        if (identity != null) {
          const existing = identityMap.get(identity.naturalKey) ?? {
            naturalKey: identity.naturalKey,
            printedCode: identity.printedCode,
            account: identity.account,
            component: identity.component,
            advanceProcurement: identity.advanceProcurement,
            exhibits: new Set<string>(),
          };
          existing.exhibits.add(exhibit);
          identityMap.set(identity.naturalKey, existing);

          p5P21P3aIdentities.push({
            naturalKey: identity.naturalKey,
            printedCode: identity.printedCode,
            account: identity.account,
            component: identity.component,
            advanceProcurement: identity.advanceProcurement,
            exhibit,
            page: (assertion.metadata?.page as number) ?? 0,
            hasQuantity: assertion.assertionKind === 'quantity',
            hasUnitCost: assertion.assertionKind === 'unit_cost',
            hasNarrative: assertion.assertionKind === 'narrative',
            referencedPeCodes: [],
            parentNaturalKey: assertion.assertionKind === 'relationship' && assertion.from.lineKind === 'PROCUREMENT_BLIN'
              ? `PROCUREMENT_BLIN:${assertion.from.component}:${assertion.from.account}:${assertion.from.code}:${assertion.from.advanceProcurement ? 'advance' : 'base'}`
              : undefined,
          });
        }
      }
    }
  }

  /* Reconcile P-1 ↔ P-40 funding */
  const fundingComparisons = reconcileProcurementFunding({
    p1Values: p1FundingValues,
    p40Values: p40FundingValues,
  });

  /* Run verification */
  const verificationInput: ProcurementVerificationInput = {
    p1Identities,
    p40Identities,
    p5P21P3aIdentities,
    fundingComparisons,
    requiredIdentityKeys,
    p40Required: input.p40Required,
    enrichmentRequired: input.enrichmentRequired,
    requiredQuantityCategories,
    requiredUnitCostCategories,
    requiredNarrativeSections,
  };
  const verification = verifyProcurementFamily(verificationInput);

  /* Determine missing exhibits */
  const missingExhibits: string[] = [];
  if (artifacts.p1Artifacts.length === 0) missingExhibits.push('P-1');
  if (input.p40Required && artifacts.p40Artifacts.length === 0) missingExhibits.push('P-40');

  /* Completeness status */
  let completenessStatus: 'complete' | 'incomplete' | 'needs_review';
  if (verification.blocking) {
    completenessStatus = 'incomplete';
  } else if (verification.findings.some((f) => f.severity === 'review')) {
    completenessStatus = 'needs_review';
  } else {
    completenessStatus = 'complete';
  }

  /* Build identity list */
  const identities = [...identityMap.values()].map((id) => ({
    naturalKey: id.naturalKey,
    printedCode: id.printedCode,
    account: id.account,
    component: id.component,
    advanceProcurement: id.advanceProcurement,
    exhibits: [...id.exhibits].sort(),
  })).sort((a, b) => a.naturalKey.localeCompare(b.naturalKey));

  /* Count artifacts and assertions */
  const allArtifacts = [
    ...artifacts.p1Artifacts,
    ...artifacts.p40Artifacts,
    ...artifacts.p5Artifacts,
    ...artifacts.p21Artifacts,
    ...artifacts.p3aArtifacts,
  ];
  const assertionCount = allArtifacts.reduce((sum, a) => sum + a.assertions.length, 0);

  return {
    identities,
    fundingComparisons,
    verification,
    missingExhibits,
    completenessStatus,
    artifactCount: allArtifacts.length,
    assertionCount,
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function buildIdentityFromProcurementLine(
  pi: { lineKind: 'PROCUREMENT_BLIN'; code: string; account: string; component: string; advanceProcurement?: boolean },
  _assertionKind: string,
): { naturalKey: string; printedCode: string; account: string; component: string; advanceProcurement: boolean } | null {
  if (pi.lineKind !== 'PROCUREMENT_BLIN') return null;
  const advance = pi.advanceProcurement ?? false;
  const naturalKey = `PROCUREMENT_BLIN:${pi.component}:${pi.account.toUpperCase()}:${pi.code.toUpperCase()}:${advance ? 'advance' : 'base'}`;
  return {
    naturalKey,
    printedCode: pi.code,
    account: pi.account,
    component: pi.component,
    advanceProcurement: advance,
  };
}

function extractIdentityFromAssertion(
  assertion: DefenseBudgetExtractionArtifactV1['assertions'][number],
): { naturalKey: string; printedCode: string; account: string; component: string; advanceProcurement: boolean } | null {
  /* Try to extract identity from various assertion kinds */
  if ('identity' in assertion && assertion.identity != null) {
    const id = assertion.identity;
    if (id.lineKind === 'PROCUREMENT_BLIN') {
      const advance = id.advanceProcurement ?? false;
      return {
        naturalKey: `PROCUREMENT_BLIN:${id.component}:${id.account.toUpperCase()}:${id.code.toUpperCase()}:${advance ? 'advance' : 'base'}`,
        printedCode: id.code,
        account: id.account,
        component: id.component,
        advanceProcurement: advance,
      };
    }
  }
  if ('parentIdentity' in assertion && assertion.parentIdentity != null) {
    const pi = assertion.parentIdentity;
    if (pi.lineKind === 'PROCUREMENT_BLIN') {
      const advance = pi.advanceProcurement ?? false;
      return {
        naturalKey: `PROCUREMENT_BLIN:${pi.component}:${pi.account.toUpperCase()}:${pi.code.toUpperCase()}:${advance ? 'advance' : 'base'}`,
        printedCode: pi.code,
        account: pi.account,
        component: pi.component,
        advanceProcurement: advance,
      };
    }
  }
  return null;
}
