/**
 * o1-artifact-builder-v1 — build a defense_budget_extraction_v1 artifact
 * from O-1 extraction output.
 *
 * Pure module. Uses the Phase 1 ArtifactBuilderV1; no database, no parser,
 * no writer. No canonical writes. No ProgramElementWriterService.
 *
 * Identity rules:
 *   - O-1 SAG codes are OM_SAG, NEVER RDTE_PE or PROCUREMENT_BLIN.
 *   - Same SAG code under different accounts/components remains distinct.
 *   - Title is never a natural key.
 *   - Funding field is bound from the column binding's funding stage
 *     (request vs enacted), not hardcoded.
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
import type { O1ExtractionResult, O1SagIdentity } from './o1-extractor-v1.js';
import { fundingStageToField } from './o1-extractor-v1.js';

export function buildO1Artifact(input: {
  source: ExtractionSourceV1;
  parserRuns: readonly ParserRunV1[];
  extraction: O1ExtractionResult;
  cycleFiscalYear: number;
}): DefenseBudgetExtractionArtifactV1 {
  const { source, parserRuns, extraction } = input;
  const builder = new ArtifactBuilderV1(source);

  /* Register parser runs. When none supplied (unit tests), use a synthetic run. */
  const syntheticParserRun: Omit<ParserRunV1, 'pageRanges'> = {
    parserRunId: parserRunIdV1({ source: source.sourcePdfSha256 }),
    method: 'manual',
    parserVersion: 'o1-extractor-v1',
    parserConfigSha256: source.sourcePdfSha256,
    inputSourceSha256: source.sourcePdfSha256,
    outputArtifactSha256: source.sourcePdfSha256,
  };

  for (const run of parserRuns) {
    builder.addParserRun(run);
  }
  const defaultParserRunId = parserRuns[0]?.parserRunId ?? syntheticParserRun.parserRunId;

  /* Identities — OM_SAG, never RDTE_PE or PROCUREMENT_BLIN */
  for (const identity of extraction.identities) {
    const evidenceId = evidenceIdV1({
      code: identity.printedCode,
      page: identity.page,
      tableIndex: identity.tableIndex,
      rowIndex: identity.rowIndex,
      kind: 'o1_identity',
    });
    builder.addEvidence({
      evidenceId,
      sourcePdfSha256: source.sourcePdfSha256,
      parserRunId: defaultParserRunId,
      granularity: 'page_only',
      page: identity.page,
      ...(identity.printedPage != null ? { printedPage: identity.printedPage } : {}),
      tableLabel: `table_${identity.tableIndex}`,
      rowLabel: `row_${identity.rowIndex}`,
    });

    const factId = factIdV1({
      code: identity.printedCode,
      page: identity.page,
      rowIndex: identity.rowIndex,
      kind: 'o1_identity_fact',
    });
    builder.addSourceFact({
      factId,
      sourcePath: `page:${identity.page}/table:${identity.tableIndex}/row:${identity.rowIndex}`,
      category: 'identity',
      requiredForCompleteness: true,
      rawValue: {
        printedCode: identity.printedCode,
        title: identity.title,
        ...(identity.budgetActivity != null ? { budgetActivity: identity.budgetActivity } : {}),
        ...(identity.activityGroup != null ? { activityGroup: identity.activityGroup } : {}),
        ...(identity.subActivityGroup != null
          ? { subActivityGroup: identity.subActivityGroup }
          : {}),
      },
      evidenceIds: [evidenceId],
    });

    builder.addAssertion({
      assertionKind: 'om_line',
      assertionId: assertionIdV1({
        code: identity.printedCode,
        page: identity.page,
        rowIndex: identity.rowIndex,
        kind: 'o1_identity',
      }),
      sourceFactIds: [factId],
      evidenceIds: [evidenceId],
      confidence: 1,
      identity: {
        lineKind: 'OM_SAG',
        code: identity.identity.code,
        account: identity.identity.account,
        component: identity.identity.component,
      },
      title: identity.title,
      ...(identity.budgetActivity != null ? { budgetActivity: identity.budgetActivity } : {}),
      ...(identity.activityGroup != null ? { activityGroup: identity.activityGroup } : {}),
      ...(identity.subActivityGroup != null ? { subActivityGroup: identity.subActivityGroup } : {}),
      metadata: {
        exhibit: 'O-1',
        physicalPage: identity.page,
        ...(identity.printedPage != null ? { printedPage: identity.printedPage } : {}),
        tableIndex: identity.tableIndex,
        rowIndex: identity.rowIndex,
      },
    });
  }

  /* Build a lookup from natural key to identity for funding assertions. */
  const identityByKey = new Map(
    extraction.identities.map((id: O1SagIdentity) => [id.identity.naturalKey, id]),
  );

  /* Funding values */
  for (const value of extraction.funding) {
    const matchedIdentity = identityByKey.get(value.identityNaturalKey);
    const evidenceId = evidenceIdV1({
      key: value.identityNaturalKey,
      fy: value.fiscalYear ?? null,
      col: value.columnIndex,
      kind: 'o1_funding',
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
      fy: value.fiscalYear ?? null,
      col: value.columnIndex,
      kind: 'o1_funding_fact',
    });
    builder.addSourceFact({
      factId,
      sourcePath: `sag:${value.identityNaturalKey}/fy:${value.fiscalYear ?? 'none'}/col:${value.columnIndex}`,
      category: 'money',
      requiredForCompleteness: true,
      rawValue: value.originalValue,
      evidenceIds: [evidenceId],
    });

    const field = fundingStageToField(value.columnBinding.fundingStage);

    builder.addAssertion({
      assertionKind: 'funding',
      assertionId: assertionIdV1({
        key: value.identityNaturalKey,
        fy: value.fiscalYear ?? null,
        col: value.columnIndex,
        kind: 'o1_funding',
      }),
      sourceFactIds: [factId],
      evidenceIds: [evidenceId],
      confidence: 1,
      identity: {
        lineKind: 'OM_SAG',
        code: matchedIdentity?.identity.code ?? 'UNKNOWN',
        account: matchedIdentity?.identity.account ?? 'UNKNOWN',
        component: source.component,
      },
      fiscalYear: value.fiscalYear ?? input.cycleFiscalYear,
      field,
      money: {
        originalValue: value.originalValue,
        originalUnit: value.originalUnit,
        valueMillions: value.valueMillions,
      },
      metadata: {
        exhibit: 'O-1',
        baseOcoStatus: value.columnBinding.baseOcoStatus,
        fundingStage: value.columnBinding.fundingStage,
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
      kind: 'o1_omission',
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
      reason: omission.reason.includes('unit')
        ? 'unsupported_unit'
        : omission.reason.includes('identity') || omission.reason.includes('SAG')
          ? 'invalid_identity'
          : omission.reason.includes('ambiguous')
            ? 'ambiguous_layout'
            : 'missing_value',
      severity: 'blocking',
      message: `O-1 page ${omission.page}: ${omission.reason}`,
    });
  }

  if (parserRuns.length === 0) {
    builder.addParserRunCoveringAddedEvidence(syntheticParserRun);
  }

  return builder.finalize();
}
