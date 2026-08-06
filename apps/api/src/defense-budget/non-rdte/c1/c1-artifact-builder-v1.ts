/**
 * c1-artifact-builder-v1 — build a defense_budget_extraction_v1 artifact
 * from C-1 extraction output.
 *
 * Pure module. Uses the Phase 1 ArtifactBuilderV1; no database, no parser,
 * no writer. No canonical writes. No ProgramElementWriterService.
 *
 * Identity rules:
 *   - C-1 project numbers are MILCON_PROJECT, NEVER RDTE_PE or PROCUREMENT_BLIN.
 *   - Same project number at different installations/components remains distinct.
 *   - Project title is never a natural key.
 *   - Funding types remain distinct (request, authorization, appropriation,
 *     total project cost, future cost).
 *   - All numeric values use exact decimal strings.
 */
import {
  ArtifactBuilderV1,
  assertionIdV1,
  evidenceIdV1,
  factIdV1,
  omissionIdV1,
  parserRunIdV1,
} from '../../contracts/artifact-builders.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
  ParserRunV1,
} from '../../contracts/extraction-artifact-v1.js';
import type { C1ExtractionResult, C1ProjectIdentity } from './c1-extractor-v1.js';

export function buildC1Artifact(input: {
  source: ExtractionSourceV1;
  parserRuns: readonly ParserRunV1[];
  extraction: C1ExtractionResult;
  cycleFiscalYear: number;
}): DefenseBudgetExtractionArtifactV1 {
  const { source, parserRuns, extraction } = input;
  const builder = new ArtifactBuilderV1(source);

  /* Register parser runs. When none supplied (unit tests), use a synthetic run. */
  const syntheticParserRun: Omit<ParserRunV1, 'pageRanges'> = {
    parserRunId: parserRunIdV1({ source: source.sourcePdfSha256 }),
    method: 'manual',
    parserVersion: 'c1-extractor-v1',
    parserConfigSha256: source.sourcePdfSha256,
    inputSourceSha256: source.sourcePdfSha256,
    outputArtifactSha256: source.sourcePdfSha256,
  };

  for (const run of parserRuns) {
    builder.addParserRun(run);
  }
  const defaultParserRunId = parserRuns[0]?.parserRunId ?? syntheticParserRun.parserRunId;

  /* Identities — MILCON_PROJECT, never RDTE_PE or PROCUREMENT_BLIN */
  for (const identity of extraction.identities) {
    addIdentityAssertion(builder, identity, source, defaultParserRunId);
  }

  /* Build a lookup from natural key to identity. */
  const identityByKey = new Map(
    extraction.identities.map((id: C1ProjectIdentity) => [id.identity.naturalKey, id]),
  );

  /* Funding values */
  for (const value of extraction.funding) {
    const matchedIdentity = identityByKey.get(value.identityNaturalKey);

    const evidenceId = evidenceIdV1({
      key: value.identityNaturalKey,
      ft: value.fundingType,
      fy: value.fiscalYear,
      col: value.columnIndex,
      kind: 'c1_funding',
    });
    builder.addEvidence({
      evidenceId,
      sourcePdfSha256: source.sourcePdfSha256,
      parserRunId: defaultParserRunId,
      granularity: 'page_only',
      page: value.page,
      columnLabel: value.headerText,
    });

    const factId = factIdV1({
      key: value.identityNaturalKey,
      ft: value.fundingType,
      fy: value.fiscalYear,
      col: value.columnIndex,
      kind: 'c1_funding_fact',
    });
    builder.addSourceFact({
      factId,
      sourcePath: `milcon:${value.identityNaturalKey}/fy:${value.fiscalYear}/${value.fundingType}/col:${value.columnIndex}`,
      category: 'money',
      requiredForCompleteness: true,
      rawValue: value.originalValue,
      evidenceIds: [evidenceId],
    });

    builder.addAssertion({
      assertionKind: 'funding',
      assertionId: assertionIdV1({
        key: value.identityNaturalKey,
        ft: value.fundingType,
        fy: value.fiscalYear,
        col: value.columnIndex,
        kind: 'c1_funding',
      }),
      sourceFactIds: [factId],
      evidenceIds: [evidenceId],
      confidence: 1,
      identity: {
        lineKind: 'MILCON_PROJECT',
        projectCode: matchedIdentity?.identity.projectCode ?? 'UNKNOWN',
        component: matchedIdentity?.identity.component ?? source.component,
        ...(matchedIdentity?.identity.location != null
          ? { location: matchedIdentity.identity.location }
          : {}),
      },
      fiscalYear: value.fiscalYear,
      field: value.fundingType === 'request' ? 'request' : 'enacted',
      money: {
        originalValue: value.originalValue,
        originalUnit: value.originalUnit,
        valueMillions: value.valueMillions,
      },
      metadata: {
        exhibit: 'C-1',
        fundingType: value.fundingType,
        headerText: value.headerText,
        page: value.page,
      },
    });
  }

  /* Omissions */
  for (const omission of extraction.omissions) {
    const factId = factIdV1({
      page: omission.page,
      row: omission.rowIndex ?? null,
      col: omission.columnIndex ?? null,
      kind: 'c1_omission',
    });
    builder.addSourceFact({
      factId,
      sourcePath: `page:${omission.page}/row:${omission.rowIndex ?? 'none'}/col:${omission.columnIndex ?? 'none'}`,
      category: 'metadata',
      requiredForCompleteness: false,
      rawValue: omission.rawText,
      evidenceIds: [],
    });
    builder.addOmission({
      omissionId: omissionIdV1({
        sourceFactId: factId,
        reason: 'missing_value',
        message: omission.reason,
      }),
      sourceFactId: factId,
      reason:
        omission.reason.includes('identity') || omission.reason.includes('project')
          ? 'invalid_identity'
          : 'missing_value',
      severity: omission.severity,
      message: `C-1 page ${omission.page}: ${omission.reason}`,
    });
  }

  if (parserRuns.length === 0) {
    builder.addParserRunCoveringAddedEvidence(syntheticParserRun);
  }

  return builder.finalize();
}

/* ------------------------------------------------------------------ */
/* Assertion builders                                                  */
/* ------------------------------------------------------------------ */

function addIdentityAssertion(
  builder: ArtifactBuilderV1,
  identity: C1ProjectIdentity,
  source: ExtractionSourceV1,
  parserRunId: string,
): void {
  const evidenceId = evidenceIdV1({
    code: identity.printedProjectCode,
    page: identity.page,
    kind: 'c1_identity',
  });
  builder.addEvidence({
    evidenceId,
    sourcePdfSha256: source.sourcePdfSha256,
    parserRunId,
    granularity: 'page_only',
    page: identity.page,
    ...(identity.printedPage != null ? { printedPage: identity.printedPage } : {}),
    tableLabel: `table_${identity.tableIndex}`,
    rowLabel: `row_${identity.rowIndex}`,
  });

  const factId = factIdV1({
    code: identity.printedProjectCode,
    page: identity.page,
    rowIndex: identity.rowIndex,
    kind: 'c1_identity_fact',
  });
  builder.addSourceFact({
    factId,
    sourcePath: `page:${identity.page}/table:${identity.tableIndex}/row:${identity.rowIndex}`,
    category: 'identity',
    requiredForCompleteness: true,
    rawValue: {
      printedProjectCode: identity.printedProjectCode,
      projectTitle: identity.projectTitle,
      ...(identity.installation != null ? { installation: identity.installation } : {}),
      ...(identity.location != null ? { location: identity.location } : {}),
      ...(identity.categoryCode != null ? { categoryCode: identity.categoryCode } : {}),
      ...(identity.newMission != null ? { newMission: identity.newMission } : {}),
    },
    evidenceIds: [evidenceId],
  });

  builder.addAssertion({
    assertionKind: 'milcon_project',
    assertionId: assertionIdV1({
      code: identity.printedProjectCode,
      page: identity.page,
      rowIndex: identity.rowIndex,
      kind: 'c1_identity',
    }),
    sourceFactIds: [factId],
    evidenceIds: [evidenceId],
    confidence: 1,
    identity: {
      lineKind: 'MILCON_PROJECT',
      projectCode: identity.identity.projectCode,
      component: identity.identity.component,
      ...(identity.identity.location != null ? { location: identity.identity.location } : {}),
    },
    title: identity.projectTitle,
    ...(identity.location != null ? { location: identity.location } : {}),
    ...(identity.identity.account != null
      ? {} /* account is metadata, not in milcon_project assertion */
      : {}),
    metadata: {
      exhibit: 'C-1',
      physicalPage: identity.page,
      ...(identity.printedPage != null ? { printedPage: identity.printedPage } : {}),
      tableIndex: identity.tableIndex,
      rowIndex: identity.rowIndex,
      ...(identity.installation != null ? { installation: identity.installation } : {}),
      ...(identity.categoryCode != null ? { categoryCode: identity.categoryCode } : {}),
      ...(identity.newMission != null ? { newMission: identity.newMission } : {}),
    },
  });
}
