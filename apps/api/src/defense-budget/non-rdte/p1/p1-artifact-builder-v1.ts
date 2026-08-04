/**
 * p1-artifact-builder-v1 — build a defense_budget_extraction_v1 artifact
 * from P-1 extraction output.
 *
 * Pure module. Uses the Phase 1 ArtifactBuilderV1; no database, no parser,
 * no writer. No canonical writes. No ProgramElementWriterService.
 *
 * Identity rules:
 *   - P-1 line codes are PROCUREMENT_BLIN, NEVER RDTE_PE.
 *   - PE references in narrative are relationships, not identity assertions.
 *   - Base/AP identities are distinct.
 *   - Title is never a natural key.
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
import { moneyToMillionsString } from '../../contracts/decimal-string.js';
import type { P1ExtractionResult, P1BlinIdentity } from './p1-extractor-v1.js';

export function buildP1Artifact(input: {
  source: ExtractionSourceV1;
  parserRuns: readonly ParserRunV1[];
  extraction: P1ExtractionResult;
  cycleFiscalYear: number;
}): DefenseBudgetExtractionArtifactV1 {
  const { source, parserRuns, extraction } = input;
  const builder = new ArtifactBuilderV1(source);

  /* Register parser runs. When none supplied (unit tests), use a synthetic run. */
  const effectiveParserRuns: ParserRunV1[] =
    parserRuns.length > 0
      ? [...parserRuns]
      : [
          {
            parserRunId: parserRunIdV1({ source: source.sourcePdfSha256 }),
            method: 'manual',
            parserVersion: 'p1-extractor-v1',
            parserConfigSha256: source.sourcePdfSha256,
            inputSourceSha256: source.sourcePdfSha256,
            outputArtifactSha256: source.sourcePdfSha256,
            pageRanges: [],
          },
        ];

  for (const run of effectiveParserRuns) {
    builder.addParserRun(run);
  }
  const defaultParserRunId = effectiveParserRuns[0]?.parserRunId ?? '';

  /* Identities — PROCUREMENT_BLIN, never RDTE_PE */
  for (const identity of extraction.identities) {
    const evidenceId = evidenceIdV1({
      code: identity.printedCode,
      page: identity.page,
      tableIndex: identity.tableIndex,
      rowIndex: identity.rowIndex,
      kind: 'p1_identity',
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
      kind: 'p1_identity_fact',
    });
    builder.addSourceFact({
      factId,
      sourcePath: `page:${identity.page}/table:${identity.tableIndex}/row:${identity.rowIndex}`,
      category: 'identity',
      requiredForCompleteness: true,
      rawValue: {
        printedCode: identity.printedCode,
        title: identity.title,
        advanceProcurement: identity.advanceProcurement,
        ...(identity.budgetActivity != null ? { budgetActivity: identity.budgetActivity } : {}),
      },
      evidenceIds: [evidenceId],
    });

    builder.addAssertion({
      assertionKind: 'procurement_line',
      assertionId: assertionIdV1({
        code: identity.printedCode,
        page: identity.page,
        rowIndex: identity.rowIndex,
        kind: 'p1_identity',
      }),
      sourceFactIds: [factId],
      evidenceIds: [evidenceId],
      confidence: 1,
      parentIdentity: {
        lineKind: 'PROCUREMENT_BLIN',
        code: identity.identity.code,
        account: identity.identity.account,
        component: identity.identity.component,
        advanceProcurement: identity.advanceProcurement,
      },
      description: identity.title,
      fiscalYear: input.cycleFiscalYear,
      metadata: {
        exhibit: 'P-1',
        physicalPage: identity.page,
        ...(identity.printedPage != null ? { printedPage: identity.printedPage } : {}),
        tableIndex: identity.tableIndex,
        rowIndex: identity.rowIndex,
        ...(identity.budgetActivity != null ? { budgetActivity: identity.budgetActivity } : {}),
        advanceProcurement: identity.advanceProcurement,
      },
    });
  }

  /* Build a lookup from natural key to identity for funding/quantity assertions. */
  const identityByKey = new Map(
    extraction.identities.map((id) => [id.identity.naturalKey, id]),
  );

  /* Funding values */
  for (const value of extraction.funding) {
    const matchedIdentity = identityByKey.get(value.identityNaturalKey);
    const evidenceId = evidenceIdV1({
      key: value.identityNaturalKey,
      fy: value.fiscalYear ?? null,
      col: value.columnIndex,
      kind: 'p1_funding',
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
      kind: 'p1_funding_fact',
    });
    builder.addSourceFact({
      factId,
      sourcePath: `blin:${value.identityNaturalKey}/fy:${value.fiscalYear ?? 'none'}/col:${value.columnIndex}`,
      category: 'money',
      requiredForCompleteness: true,
      rawValue: value.originalValue,
      evidenceIds: [evidenceId],
    });

    builder.addAssertion({
      assertionKind: 'funding',
      assertionId: assertionIdV1({
        key: value.identityNaturalKey,
        fy: value.fiscalYear ?? null,
        col: value.columnIndex,
        kind: 'p1_funding',
      }),
      sourceFactIds: [factId],
      evidenceIds: [evidenceId],
      confidence: 1,
      identity: {
        lineKind: 'PROCUREMENT_BLIN',
        code: matchedIdentity?.identity.code ?? 'UNKNOWN',
        account: matchedIdentity?.identity.account ?? 'UNKNOWN',
        component: source.component,
        ...(matchedIdentity?.advanceProcurement != null
          ? { advanceProcurement: matchedIdentity.advanceProcurement }
          : {}),
      },
      fiscalYear: value.fiscalYear ?? input.cycleFiscalYear,
      field: 'request',
      money: {
        originalValue: value.originalValue,
        originalUnit: value.originalUnit,
        valueMillions: value.valueMillions,
      },
      metadata: {
        exhibit: 'P-1',
        baseOcoStatus: value.columnBinding.baseOcoStatus,
        fundingStage: value.columnBinding.fundingStage,
        headerText: value.headerText,
        page: value.page,
      },
    });
  }

  /* Quantity values */
  for (const qty of extraction.quantities) {
    const matchedIdentity = identityByKey.get(qty.identityNaturalKey);
    const evidenceId = evidenceIdV1({
      key: qty.identityNaturalKey,
      fy: qty.fiscalYear ?? null,
      col: qty.columnIndex,
      kind: 'p1_quantity',
    });
    builder.addEvidence({
      evidenceId,
      sourcePdfSha256: source.sourcePdfSha256,
      parserRunId: defaultParserRunId,
      granularity: 'page_only',
      page: qty.page,
      columnLabel: qty.headerText,
    });

    const factId = factIdV1({
      key: qty.identityNaturalKey,
      fy: qty.fiscalYear ?? null,
      col: qty.columnIndex,
      kind: 'p1_quantity_fact',
    });
    builder.addSourceFact({
      factId,
      sourcePath: `blin:${qty.identityNaturalKey}/fy:${qty.fiscalYear ?? 'none'}/qty:col:${qty.columnIndex}`,
      category: 'quantity',
      requiredForCompleteness: false,
      rawValue: qty.quantity,
      evidenceIds: [evidenceId],
    });

    builder.addAssertion({
      assertionKind: 'quantity',
      assertionId: assertionIdV1({
        key: qty.identityNaturalKey,
        fy: qty.fiscalYear ?? null,
        col: qty.columnIndex,
        kind: 'p1_quantity',
      }),
      sourceFactIds: [factId],
      evidenceIds: [evidenceId],
      confidence: 1,
      identity: {
        lineKind: 'PROCUREMENT_BLIN',
        code: matchedIdentity?.identity.code ?? 'UNKNOWN',
        account: matchedIdentity?.identity.account ?? 'UNKNOWN',
        component: source.component,
        ...(matchedIdentity?.advanceProcurement != null
          ? { advanceProcurement: matchedIdentity.advanceProcurement }
          : {}),
      },
      fiscalYear: qty.fiscalYear ?? input.cycleFiscalYear,
      quantity: qty.quantity,
      ...(qty.unitLabel != null ? { unitLabel: qty.unitLabel } : {}),
    });
  }

  /* Omissions */
  for (const omission of extraction.omissions) {
    const factId = factIdV1({
      page: omission.page,
      row: omission.rowIndex ?? null,
      col: omission.columnIndex ?? null,
      kind: 'p1_omission',
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
        : omission.reason.includes('identity')
          ? 'invalid_identity'
          : omission.reason.includes('ambiguous')
            ? 'ambiguous_layout'
            : 'missing_value',
      severity: omission.reason.includes('ambiguous') ? 'review' : 'blocking',
      message: `P-1 page ${omission.page}: ${omission.reason}`,
    });
  }

  return builder.finalize();
}
