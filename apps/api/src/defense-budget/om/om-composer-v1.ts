/**
 * om-composer-v1 — compose all O&M (O-1/OP-5) exhibits into one noncanonical
 * verified family view.
 *
 * Workstream I (Phase 5 plan §9). Composes artifacts by OM_SAG identity, FY,
 * account, component, and scope without discarding individual source
 * assertions. Requires trusted proof for every source artifact through
 * Phase 2. Produces an O&M family report containing identities, verified
 * assertions, unresolved assertions, source-specific values, reconciliation
 * results, missing exhibits, completeness status.
 *
 * Pure module. No database, no parser, no writer. No canonical writes.
 * No ProgramElementWriterService or legacy loader calls.
 */
import type { DefenseBudgetExtractionArtifactV1 } from '../contracts/extraction-artifact-v1.js';
import {
  reconcileOmFunding,
  checkOp5ChangeArithmetic,
  type OmFundingComparison,
  type OmFundingValueV1,
} from './om-reconciliation-v1.js';
import {
  verifyOmFamily,
  type OmVerificationResult,
  type OmIdentityInput,
  type OmVerificationInput,
} from './om-verification-policy-v1.js';

/* ------------------------------------------------------------------ */
/* Composer input                                                       */
/* ------------------------------------------------------------------ */

export interface OmExhibitArtifacts {
  o1Artifacts: readonly DefenseBudgetExtractionArtifactV1[];
  op5Artifacts: readonly DefenseBudgetExtractionArtifactV1[];
}

export interface OmCompositionInput {
  artifacts: OmExhibitArtifacts;
  /** Manifest-driven requirements. */
  requiredIdentityKeys: readonly string[];
  op5Required: boolean;
  requiredNarrativeSections: readonly string[];
  requiredQuantityCategories: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Composer output                                                      */
/* ------------------------------------------------------------------ */

export interface OmFamilyReport {
  identities: Array<{
    naturalKey: string;
    printedCode: string;
    account: string;
    component: string;
    exhibits: string[];
  }>;
  fundingComparisons: OmFundingComparison[];
  verification: OmVerificationResult;
  missingExhibits: string[];
  completenessStatus: 'complete' | 'incomplete' | 'needs_review';
  artifactCount: number;
  assertionCount: number;
}

/* ------------------------------------------------------------------ */
/* Composer                                                             */
/* ------------------------------------------------------------------ */

/**
 * Compose all O&M exhibit artifacts into one noncanonical family view.
 * Reconciles O-1 ↔ OP-5 funding, runs family-specific verification, and
 * produces a completeness report.
 *
 * No canonical writer or legacy loader call is permitted.
 */
export function composeOmFamily(
  input: OmCompositionInput,
): OmFamilyReport {
  const {
    artifacts,
    requiredIdentityKeys,
    requiredNarrativeSections,
    requiredQuantityCategories,
  } = input;

  /* Collect all identities from all artifacts. */
  const identityMap = new Map<string, {
    naturalKey: string;
    printedCode: string;
    account: string;
    component: string;
    exhibits: Set<string>;
  }>();

  const o1Identities: OmIdentityInput[] = [];
  const op5Identities: OmIdentityInput[] = [];
  const o1FundingValues: OmFundingValueV1[] = [];
  const op5FundingValues: OmFundingValueV1[] = [];

  /* Collect OP-5 change values for arithmetic check. */
  const changeValues: Array<{
    identityNaturalKey: string;
    changeType: 'price_change' | 'program_change' | 'transfer' | 'total_change';
    fiscalYear?: number;
    valueMillions?: string;
    originalValue: string;
  }> = [];

  /* Process O-1 artifacts */
  for (const artifact of artifacts.o1Artifacts) {
    for (const assertion of artifact.assertions) {
      if (assertion.assertionKind === 'om_line') {
        const id = assertion.identity;
        const naturalKey = `OM_SAG:${id.component}:${id.account.toUpperCase()}:${id.code.toUpperCase()}`;
        const printedCode = id.code;
        const account = id.account;
        const component = id.component;

        const existing = identityMap.get(naturalKey) ?? {
          naturalKey,
          printedCode,
          account,
          component,
          exhibits: new Set<string>(),
        };
        existing.exhibits.add('O-1');
        identityMap.set(naturalKey, existing);

        o1Identities.push({
          naturalKey,
          printedCode,
          account,
          component,
          exhibit: 'O-1',
          page: (assertion.metadata?.page as number) ?? 0,
          hasNarrative: false,
          hasQuantity: false,
          hasFunding: false,
          ...(assertion.budgetActivity != null
            ? { budgetActivity: assertion.budgetActivity }
            : {}),
          ...(assertion.activityGroup != null
            ? { activityGroup: assertion.activityGroup }
            : {}),
        });
      }
      if (assertion.assertionKind === 'funding' && assertion.identity.lineKind === 'OM_SAG') {
        const fi = assertion.identity;
        const naturalKey = `OM_SAG:${fi.component}:${fi.account.toUpperCase()}:${fi.code.toUpperCase()}`;
        o1FundingValues.push({
          identityNaturalKey: naturalKey,
          identity: fi as unknown as import('../non-rdte/identity-v1.js').OmSagIdentityV1,
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
        /* Mark the identity as having funding. */
        const o1Entry = o1Identities.find((oi) => oi.naturalKey === naturalKey);
        if (o1Entry != null) o1Entry.hasFunding = true;
      }
    }
  }

  /* Process OP-5 artifacts */
  for (const artifact of artifacts.op5Artifacts) {
    for (const assertion of artifact.assertions) {
      if (assertion.assertionKind === 'om_line') {
        const id = assertion.identity;
        const naturalKey = `OM_SAG:${id.component}:${id.account.toUpperCase()}:${id.code.toUpperCase()}`;
        const printedCode = id.code;
        const account = id.account;
        const component = id.component;

        const existing = identityMap.get(naturalKey) ?? {
          naturalKey,
          printedCode,
          account,
          component,
          exhibits: new Set<string>(),
        };
        existing.exhibits.add('OP-5');
        identityMap.set(naturalKey, existing);

        op5Identities.push({
          naturalKey,
          printedCode,
          account,
          component,
          exhibit: 'OP-5',
          page: (assertion.metadata?.page as number) ?? 0,
          hasNarrative: false,
          hasQuantity: false,
          hasFunding: false,
          ...(assertion.budgetActivity != null
            ? { budgetActivity: assertion.budgetActivity }
            : {}),
          ...(assertion.activityGroup != null
            ? { activityGroup: assertion.activityGroup }
            : {}),
        });
      }
      if (assertion.assertionKind === 'funding' && assertion.identity.lineKind === 'OM_SAG') {
        const fi = assertion.identity;
        const naturalKey = `OM_SAG:${fi.component}:${fi.account.toUpperCase()}:${fi.code.toUpperCase()}`;
        op5FundingValues.push({
          identityNaturalKey: naturalKey,
          identity: fi as unknown as import('../non-rdte/identity-v1.js').OmSagIdentityV1,
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
        const op5Entry = op5Identities.find((oi) => oi.naturalKey === naturalKey);
        if (op5Entry != null) op5Entry.hasFunding = true;
      }
      if (assertion.assertionKind === 'narrative' && assertion.identity.lineKind === 'OM_SAG') {
        const fi = assertion.identity;
        const naturalKey = `OM_SAG:${fi.component}:${fi.account.toUpperCase()}:${fi.code.toUpperCase()}`;
        const op5Entry = op5Identities.find((oi) => oi.naturalKey === naturalKey);
        if (op5Entry != null) op5Entry.hasNarrative = true;
      }
      if (assertion.assertionKind === 'quantity' && assertion.identity.lineKind === 'OM_SAG') {
        const fi = assertion.identity;
        const naturalKey = `OM_SAG:${fi.component}:${fi.account.toUpperCase()}:${fi.code.toUpperCase()}`;
        const op5Entry = op5Identities.find((oi) => oi.naturalKey === naturalKey);
        if (op5Entry != null) op5Entry.hasQuantity = true;
      }
      if (assertion.assertionKind === 'document_fact') {
        /* Collect change values for arithmetic check. */
        const meta = assertion.metadata ?? {};
        const identityNaturalKey = meta.identityNaturalKey as string | undefined;
        const changeType = meta.changeType as
          | 'price_change'
          | 'program_change'
          | 'transfer'
          | 'total_change'
          | undefined;
        const fiscalYear = meta.fiscalYear as number | undefined;
        const valueMillions = (assertion.value as { valueMillions?: string }).valueMillions;
        const originalValue = (assertion.value as { amount?: string }).amount ?? '0';

        if (identityNaturalKey != null && changeType != null) {
          changeValues.push({
            identityNaturalKey,
            changeType,
            ...(fiscalYear != null ? { fiscalYear } : {}),
            ...(valueMillions != null ? { valueMillions } : {}),
            originalValue,
          });
        }
      }
    }
  }

  /* Reconcile O-1 ↔ OP-5 funding */
  const fundingComparisons = reconcileOmFunding({
    o1Values: o1FundingValues,
    op5Values: op5FundingValues,
  });

  /* Check OP-5 change arithmetic */
  const changeArithmetic = checkOp5ChangeArithmetic({ changes: changeValues });

  /* Run verification */
  const verificationInput: OmVerificationInput = {
    o1Identities,
    op5Identities,
    fundingComparisons,
    requiredIdentityKeys,
    op5Required: input.op5Required,
    requiredNarrativeSections,
    requiredQuantityCategories,
    changeArithmetic,
  };
  const verification = verifyOmFamily(verificationInput);

  /* Determine missing exhibits */
  const missingExhibits: string[] = [];
  if (artifacts.o1Artifacts.length === 0) missingExhibits.push('O-1');
  if (input.op5Required && artifacts.op5Artifacts.length === 0) missingExhibits.push('OP-5');

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
    exhibits: [...id.exhibits].sort(),
  })).sort((a, b) => a.naturalKey.localeCompare(b.naturalKey));

  /* Count artifacts and assertions */
  const allArtifacts = [
    ...artifacts.o1Artifacts,
    ...artifacts.op5Artifacts,
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
