/**
 * milcon-composer-v1 — compose all MILCON (C-1/DD1391) exhibits into one
 * noncanonical verified family view.
 *
 * Workstream L (Phase 5 plan §12). Matches C-1 and DD1391 by native project
 * identity, not title similarity. Requires compatible component,
 * appropriation, project number, FY, and installation/location context.
 * Preserves mismatches as discrepancies; never overwrites one source with
 * another.
 *
 * Pure module. No database, no parser, no writer. No canonical writes.
 * No ProgramElementWriterService or legacy loader calls.
 */
import type { DefenseBudgetExtractionArtifactV1 } from '../contracts/extraction-artifact-v1.js';
import {
  reconcileMilconFunding,
  checkDd1391CostArithmetic,
  type MilconFundingComparison,
  type MilconFundingValueV1,
} from './milcon-reconciliation-v1.js';
import {
  verifyMilconFamily,
  type MilconVerificationResult,
  type MilconIdentityInput,
  type MilconVerificationInput,
} from './milcon-verification-policy-v1.js';

/* ------------------------------------------------------------------ */
/* Composer input                                                       */
/* ------------------------------------------------------------------ */

export interface MilconExhibitArtifacts {
  c1Artifacts: readonly DefenseBudgetExtractionArtifactV1[];
  dd1391Artifacts: readonly DefenseBudgetExtractionArtifactV1[];
}

export interface MilconCompositionInput {
  artifacts: MilconExhibitArtifacts;
  requiredIdentityKeys: readonly string[];
  dd1391Required: boolean;
  requiredNarrativeSections: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Composer output                                                      */
/* ------------------------------------------------------------------ */

export interface MilconFamilyReport {
  identities: Array<{
    naturalKey: string;
    printedProjectCode: string;
    component: string;
    exhibits: string[];
  }>;
  fundingComparisons: MilconFundingComparison[];
  verification: MilconVerificationResult;
  missingExhibits: string[];
  completenessStatus: 'complete' | 'incomplete' | 'needs_review';
  artifactCount: number;
  assertionCount: number;
}

/* ------------------------------------------------------------------ */
/* Composer                                                             */
/* ------------------------------------------------------------------ */

export function composeMilconFamily(input: MilconCompositionInput): MilconFamilyReport {
  const { artifacts, requiredIdentityKeys, requiredNarrativeSections } = input;

  const identityMap = new Map<
    string,
    {
      naturalKey: string;
      printedProjectCode: string;
      component: string;
      exhibits: Set<string>;
    }
  >();

  const c1Identities: MilconIdentityInput[] = [];
  const dd1391Identities: MilconIdentityInput[] = [];
  const c1FundingValues: MilconFundingValueV1[] = [];
  const dd1391FundingValues: MilconFundingValueV1[] = [];
  const dd1391CostValues: Array<{
    identityNaturalKey: string;
    costCategory: string;
    valueMillions: string;
  }> = [];
  const ocrConfidenceIssues: Array<{ identityNaturalKey: string; requiresReview: boolean }> = [];

  /* Process C-1 artifacts */
  for (const artifact of artifacts.c1Artifacts) {
    for (const assertion of artifact.assertions) {
      if (assertion.assertionKind === 'milcon_project') {
        const id = assertion.identity;
        const naturalKey =
          id.lineKind === 'MILCON_PROJECT'
            ? `MILCON_PROJECT:${id.component}:${id.projectCode.toUpperCase()}:${id.location?.toUpperCase() ?? 'NO_LOC'}:${(assertion.metadata?.installation as string)?.toUpperCase() ?? 'NO_LOC'}`
            : '';

        /* Use the identity's natural key from the identity builder pattern */
        const printedCode = id.projectCode;
        const component = id.component;

        /* Build a natural key that matches the identity builder format */
        const locPart = id.location?.toUpperCase() ?? 'NO_LOC';
        const acctPart = (assertion.metadata?.installation as string)?.toUpperCase() ?? locPart;
        const composedKey = `MILCON_PROJECT:${component}:${printedCode.toUpperCase()}:${locPart}:${acctPart}`;

        const existing = identityMap.get(composedKey) ?? {
          naturalKey: composedKey,
          printedProjectCode: printedCode,
          component,
          exhibits: new Set<string>(),
        };
        existing.exhibits.add('C-1');
        identityMap.set(composedKey, existing);

        c1Identities.push({
          naturalKey: composedKey,
          printedProjectCode: printedCode,
          component,
          ...(id.location != null ? { location: id.location } : {}),
          exhibit: 'C-1',
          page: (assertion.metadata?.physicalPage as number) ?? 0,
          hasScope: false,
          hasSchedule: false,
          hasNarrative: false,
          hasCostCategory: false,
          ...(assertion.metadata?.installation != null
            ? { installation: assertion.metadata.installation as string }
            : {}),
        });
      }
      if (
        assertion.assertionKind === 'funding' &&
        assertion.identity.lineKind === 'MILCON_PROJECT'
      ) {
        const fi = assertion.identity;
        const locPart = fi.location?.toUpperCase() ?? 'NO_LOC';
        const composedKey = `MILCON_PROJECT:${fi.component}:${fi.projectCode.toUpperCase()}:${locPart}:${locPart}`;

        c1FundingValues.push({
          identityNaturalKey: composedKey,
          printedProjectCode: fi.projectCode,
          fundingType: (assertion.metadata?.fundingType as string) ?? 'request',
          fiscalYear: assertion.fiscalYear,
          originalValue: assertion.money.originalValue,
          originalUnit: assertion.money.originalUnit,
          valueMillions: assertion.money.valueMillions,
          page: (assertion.metadata?.page as number) ?? 0,
        });
      }
    }
  }

  /* Process DD1391 artifacts */
  for (const artifact of artifacts.dd1391Artifacts) {
    for (const assertion of artifact.assertions) {
      if (assertion.assertionKind === 'milcon_project') {
        const id = assertion.identity;
        const printedCode = id.projectCode;
        const component = id.component;
        const locPart = id.location?.toUpperCase() ?? 'NO_LOC';
        const composedKey = `MILCON_PROJECT:${component}:${printedCode.toUpperCase()}:${locPart}:${locPart}`;

        const existing = identityMap.get(composedKey) ?? {
          naturalKey: composedKey,
          printedProjectCode: printedCode,
          component,
          exhibits: new Set<string>(),
        };
        existing.exhibits.add('DD1391');
        identityMap.set(composedKey, existing);

        dd1391Identities.push({
          naturalKey: composedKey,
          printedProjectCode: printedCode,
          component,
          ...(id.location != null ? { location: id.location } : {}),
          exhibit: 'DD1391',
          page: (assertion.metadata?.physicalPage as number) ?? 0,
          hasScope: false,
          hasSchedule: false,
          hasNarrative: false,
          hasCostCategory: false,
          ...(assertion.metadata?.installation != null
            ? { installation: assertion.metadata.installation as string }
            : {}),
        });
      }
      if (
        assertion.assertionKind === 'funding' &&
        assertion.identity.lineKind === 'MILCON_PROJECT'
      ) {
        const fi = assertion.identity;
        const locPart = fi.location?.toUpperCase() ?? 'NO_LOC';
        const composedKey = `MILCON_PROJECT:${fi.component}:${fi.projectCode.toUpperCase()}:${locPart}:${locPart}`;

        dd1391FundingValues.push({
          identityNaturalKey: composedKey,
          printedProjectCode: fi.projectCode,
          fundingType: (assertion.metadata?.fundingType as string) ?? 'request',
          fiscalYear: assertion.fiscalYear,
          originalValue: assertion.money.originalValue,
          originalUnit: assertion.money.originalUnit,
          valueMillions: assertion.money.valueMillions,
          page: (assertion.metadata?.page as number) ?? 0,
        });
      }
      if (assertion.assertionKind === 'document_fact') {
        const meta = assertion.metadata ?? {};
        const costCategory = meta.costCategory as string | undefined;
        const identityNaturalKey = meta.identityNaturalKey as string | undefined;

        if (costCategory != null && identityNaturalKey != null) {
          const value = (assertion.value as { valueMillions?: string }).valueMillions ?? '0';
          dd1391CostValues.push({
            identityNaturalKey,
            costCategory,
            valueMillions: value,
          });

          /* Mark the DD1391 identity as having cost category */
          const dd1391Entry = dd1391Identities.find((di) => di.naturalKey === identityNaturalKey);
          if (dd1391Entry != null) dd1391Entry.hasCostCategory = true;
        }
      }
      if (
        assertion.assertionKind === 'narrative' &&
        assertion.identity.lineKind === 'MILCON_PROJECT'
      ) {
        const fi = assertion.identity;
        const locPart = fi.location?.toUpperCase() ?? 'NO_LOC';
        const composedKey = `MILCON_PROJECT:${fi.component}:${fi.projectCode.toUpperCase()}:${locPart}:${locPart}`;
        const dd1391Entry = dd1391Identities.find((di) => di.naturalKey === composedKey);
        if (dd1391Entry != null) dd1391Entry.hasNarrative = true;
      }
    }

    /* Collect OCR confidence issues from warnings */
    for (const warning of artifact.warnings) {
      if (warning.code === 'dd1391_ocr_low_confidence') {
        /* Extract identity from the warning message — it contains the natural key */
        const match = /for (.+)$/.exec(warning.message);
        if (match != null) {
          ocrConfidenceIssues.push({
            identityNaturalKey: match[1]!,
            requiresReview: true,
          });
        }
      }
    }
  }

  /* Mark DD1391 identities that have scope and schedule */
  for (const artifact of artifacts.dd1391Artifacts) {
    for (const assertion of artifact.assertions) {
      if (assertion.assertionKind === 'document_fact') {
        const meta = assertion.metadata ?? {};
        const fieldName = (assertion as { fieldName?: string }).fieldName;
        const identityNaturalKey = meta.identityNaturalKey as string | undefined;
        if (identityNaturalKey == null) continue;

        if (fieldName === 'schedule') {
          const dd1391Entry = dd1391Identities.find((di) => di.naturalKey === identityNaturalKey);
          if (dd1391Entry != null) dd1391Entry.hasSchedule = true;
        }
      }
      if (assertion.assertionKind === 'narrative') {
        const meta = assertion.metadata ?? {};
        const sectionType = meta.sectionType as string | undefined;
        if (sectionType === 'scope' || sectionType === 'requirement') {
          const fi = assertion.identity;
          if (fi.lineKind === 'MILCON_PROJECT') {
            const locPart = fi.location?.toUpperCase() ?? 'NO_LOC';
            const composedKey = `MILCON_PROJECT:${fi.component}:${fi.projectCode.toUpperCase()}:${locPart}:${locPart}`;
            const dd1391Entry = dd1391Identities.find((di) => di.naturalKey === composedKey);
            if (dd1391Entry != null) dd1391Entry.hasScope = true;
          }
        }
      }
    }
  }

  /* Reconcile C-1 ↔ DD1391 funding */
  const fundingComparisons = reconcileMilconFunding({
    c1Values: c1FundingValues,
    dd1391Values: dd1391FundingValues,
  });

  /* Check DD1391 cost arithmetic */
  const costArithmetic = checkDd1391CostArithmetic({ costs: dd1391CostValues });

  /* Run verification */
  const verificationInput: MilconVerificationInput = {
    c1Identities,
    dd1391Identities,
    fundingComparisons,
    requiredIdentityKeys,
    dd1391Required: input.dd1391Required,
    requiredNarrativeSections,
    costArithmetic,
    ocrConfidenceIssues,
  };
  const verification = verifyMilconFamily(verificationInput);

  /* Determine missing exhibits */
  const missingExhibits: string[] = [];
  if (artifacts.c1Artifacts.length === 0) missingExhibits.push('C-1');
  if (input.dd1391Required && artifacts.dd1391Artifacts.length === 0) {
    missingExhibits.push('DD1391');
  }

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
  const identities = [...identityMap.values()]
    .map((id) => ({
      naturalKey: id.naturalKey,
      printedProjectCode: id.printedProjectCode,
      component: id.component,
      exhibits: [...id.exhibits].sort(),
    }))
    .sort((a, b) => a.naturalKey.localeCompare(b.naturalKey));

  /* Count artifacts and assertions */
  const allArtifacts = [...artifacts.c1Artifacts, ...artifacts.dd1391Artifacts];
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
