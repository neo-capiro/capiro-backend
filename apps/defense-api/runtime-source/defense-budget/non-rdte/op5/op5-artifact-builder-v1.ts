/**
 * op5-artifact-builder-v1 — build a defense_budget_extraction_v1 artifact
 * from OP-5 extraction output.
 *
 * Pure module. Uses the Phase 1 ArtifactBuilderV1; no database, no parser,
 * no writer. No canonical writes. No ProgramElementWriterService.
 *
 * Identity rules:
 *   - OP-5 SAG codes are OM_SAG, NEVER RDTE_PE or PROCUREMENT_BLIN.
 *   - Same SAG code under different accounts/components remains distinct.
 *   - Title is never a natural key.
 *   - Funding field is bound from the column binding's funding stage
 *     (request vs enacted), not hardcoded.
 *   - All numeric values use exact decimal strings.
 *
 * Typed distinction:
 *   - Funding values → funding assertions (identity + FY + field + money).
 *   - Price change, program change, transfers, total change → document_fact
 *     assertions (explanatory deltas, not funding).
 *   - Workload/quantity measures → quantity assertions.
 *   - Narrative sections → narrative assertions (mission, description,
 *     budget justification, etc.).
 *   - Narrative text is never used as money.
 */
import {
  ArtifactBuilderV1,
  assertionIdV1,
  evidenceIdV1,
  factIdV1,
  omissionIdV1,
  parserRunIdV1,
  warningIdV1,
} from '../../contracts/artifact-builders.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
  JsonValue,
  ParserRunV1,
} from '../../contracts/extraction-artifact-v1.js';
import type { Op5ExtractionResult, Op5SagIdentity, Op5ChangeValue } from './op5-extractor-v1.js';
import { fundingStageToField } from './op5-extractor-v1.js';

export function buildOp5Artifact(input: {
  source: ExtractionSourceV1;
  parserRuns: readonly ParserRunV1[];
  extraction: Op5ExtractionResult;
  cycleFiscalYear: number;
}): DefenseBudgetExtractionArtifactV1 {
  const { source, parserRuns, extraction } = input;
  const builder = new ArtifactBuilderV1(source);

  /* Register parser runs. When none supplied (unit tests), use a synthetic run. */
  const syntheticParserRun: Omit<ParserRunV1, 'pageRanges'> = {
    parserRunId: parserRunIdV1({ source: source.sourcePdfSha256 }),
    method: 'manual',
    parserVersion: 'op5-extractor-v1',
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
    addIdentityAssertion(builder, identity, source, defaultParserRunId);
  }

  /* Build a lookup from natural key to identity. */
  const identityByKey = new Map(
    extraction.identities.map((id: Op5SagIdentity) => [id.identity.naturalKey, id]),
  );

  /* Funding values → funding assertions */
  for (const value of extraction.funding) {
    const matchedIdentity = identityByKey.get(value.identityNaturalKey);
    addFundingAssertion(
      builder,
      value,
      matchedIdentity,
      source,
      defaultParserRunId,
      input.cycleFiscalYear,
    );
  }

  /* Change values → document_fact assertions (explanatory deltas, not funding) */
  for (const change of extraction.changes) {
    addChangeAssertion(builder, change, source, defaultParserRunId);
  }

  /* Quantity/workload values → quantity assertions */
  for (const qty of extraction.quantities) {
    addQuantityAssertion(
      builder,
      qty,
      identityByKey,
      source,
      defaultParserRunId,
      input.cycleFiscalYear,
    );
  }

  /* Narrative sections → narrative assertions */
  for (const narrative of extraction.narratives) {
    addNarrativeAssertion(builder, narrative, identityByKey, source, defaultParserRunId);
  }

  /* Omissions */
  for (const omission of extraction.omissions) {
    addOmission(builder, omission, source, defaultParserRunId);
  }

  /* Warning when total-change arithmetic check fails */
  if (
    extraction.totalChangeArithmetic.applicable &&
    extraction.totalChangeArithmetic.passed != null &&
    !extraction.totalChangeArithmetic.passed
  ) {
    const arith = extraction.totalChangeArithmetic;
    builder.addWarning({
      warningId: warningIdV1({
        code: 'total_change_arithmetic_mismatch',
        message: 'price_change + program_change + transfers != total_change',
        sourceFactIds: [],
        evidenceIds: [],
      }),
      code: 'total_change_arithmetic_mismatch',
      severity: 'review',
      message: `OP-5 total-change arithmetic check failed for FY ${arith.fiscalYear ?? '?'}: expected ${arith.expected ?? '?'}, got ${arith.actual ?? '?'}`,
      sourceFactIds: [],
      evidenceIds: [],
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
  identity: Op5SagIdentity,
  source: ExtractionSourceV1,
  parserRunId: string,
): void {
  const evidenceId = evidenceIdV1({
    code: identity.printedCode,
    page: identity.page,
    kind: 'op5_identity',
  });
  builder.addEvidence({
    evidenceId,
    sourcePdfSha256: source.sourcePdfSha256,
    parserRunId,
    granularity: 'page_only',
    page: identity.page,
    ...(identity.printedPage != null ? { printedPage: identity.printedPage } : {}),
  });

  const factId = factIdV1({
    code: identity.printedCode,
    page: identity.page,
    kind: 'op5_identity_fact',
  });
  builder.addSourceFact({
    factId,
    sourcePath: `page:${identity.page}/identity`,
    category: 'identity',
    requiredForCompleteness: true,
    rawValue: {
      printedCode: identity.printedCode,
      title: identity.title,
      ...(identity.budgetActivity != null ? { budgetActivity: identity.budgetActivity } : {}),
      ...(identity.activityGroup != null ? { activityGroup: identity.activityGroup } : {}),
      ...(identity.subActivityGroup != null ? { subActivityGroup: identity.subActivityGroup } : {}),
    },
    evidenceIds: [evidenceId],
  });

  builder.addAssertion({
    assertionKind: 'om_line',
    assertionId: assertionIdV1({
      code: identity.printedCode,
      page: identity.page,
      kind: 'op5_identity',
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
      exhibit: 'OP-5',
      physicalPage: identity.page,
      ...(identity.printedPage != null ? { printedPage: identity.printedPage } : {}),
      tableIndex: identity.tableIndex,
    },
  });
}

function addFundingAssertion(
  builder: ArtifactBuilderV1,
  value: Op5ExtractionResult['funding'][number],
  matchedIdentity: Op5SagIdentity | undefined,
  source: ExtractionSourceV1,
  parserRunId: string,
  cycleFiscalYear: number,
): void {
  const evidenceId = evidenceIdV1({
    key: value.identityNaturalKey,
    row: value.rowLabel,
    fy: value.fiscalYear ?? null,
    col: value.columnIndex,
    kind: 'op5_funding',
  });
  builder.addEvidence({
    evidenceId,
    sourcePdfSha256: source.sourcePdfSha256,
    parserRunId,
    granularity: 'page_only',
    page: value.page,
    columnLabel: value.headerText,
    rowLabel: value.rowLabel,
  });

  const factId = factIdV1({
    key: value.identityNaturalKey,
    row: value.rowLabel,
    fy: value.fiscalYear ?? null,
    col: value.columnIndex,
    kind: 'op5_funding_fact',
  });
  builder.addSourceFact({
    factId,
    sourcePath: `sag:${value.identityNaturalKey}/row:${value.rowLabel}/fy:${value.fiscalYear ?? 'none'}/col:${value.columnIndex}`,
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
      row: value.rowLabel,
      fy: value.fiscalYear ?? null,
      col: value.columnIndex,
      kind: 'op5_funding',
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
    fiscalYear: value.fiscalYear ?? cycleFiscalYear,
    field,
    money: {
      originalValue: value.originalValue,
      originalUnit: value.originalUnit,
      valueMillions: value.valueMillions,
    },
    metadata: {
      exhibit: 'OP-5',
      rowLabel: value.rowLabel,
      baseOcoStatus: value.columnBinding.baseOcoStatus,
      fundingStage: value.columnBinding.fundingStage,
      headerText: value.headerText,
      page: value.page,
      rowIndex: value.rowIndex,
    },
  });
}

function addChangeAssertion(
  builder: ArtifactBuilderV1,
  change: Op5ChangeValue,
  source: ExtractionSourceV1,
  parserRunId: string,
): void {
  const evidenceId = evidenceIdV1({
    key: change.identityNaturalKey,
    changeType: change.changeType,
    row: change.rowLabel,
    fy: change.fiscalYear ?? null,
    col: change.columnIndex,
    kind: 'op5_change',
  });
  builder.addEvidence({
    evidenceId,
    sourcePdfSha256: source.sourcePdfSha256,
    parserRunId,
    granularity: 'page_only',
    page: change.page,
    columnLabel: change.headerText,
    rowLabel: change.rowLabel,
  });

  const factId = factIdV1({
    key: change.identityNaturalKey,
    changeType: change.changeType,
    row: change.rowLabel,
    fy: change.fiscalYear ?? null,
    col: change.columnIndex,
    kind: 'op5_change_fact',
  });
  builder.addSourceFact({
    factId,
    sourcePath: `sag:${change.identityNaturalKey}/change:${change.changeType}/fy:${change.fiscalYear ?? 'none'}/col:${change.columnIndex}`,
    category: 'money',
    requiredForCompleteness: false,
    rawValue: change.originalValue,
    evidenceIds: [evidenceId],
  });

  // document_fact assertion — explanatory delta, not funding.
  // The value carries the amount, unit (when known), and fiscal year.
  // The OM_SAG identity is carried in metadata since document_fact
  // assertions do not have an identity field in the contract.
  const value: JsonValue = {
    amount: change.originalValue,
    changeType: change.changeType,
    rowLabel: change.rowLabel,
    ...(change.fiscalYear != null ? { fiscalYear: change.fiscalYear } : {}),
    ...(change.originalUnit != null ? { unit: change.originalUnit } : {}),
    ...(change.valueMillions != null ? { valueMillions: change.valueMillions } : {}),
  };

  builder.addAssertion({
    assertionKind: 'document_fact',
    assertionId: assertionIdV1({
      key: change.identityNaturalKey,
      changeType: change.changeType,
      row: change.rowLabel,
      fy: change.fiscalYear ?? null,
      col: change.columnIndex,
      kind: 'op5_change',
    }),
    sourceFactIds: [factId],
    evidenceIds: [evidenceId],
    confidence: 1,
    fieldName: change.changeType,
    value,
    metadata: {
      exhibit: 'OP-5',
      changeType: change.changeType,
      rowLabel: change.rowLabel,
      headerText: change.headerText,
      page: change.page,
      rowIndex: change.rowIndex,
      identityNaturalKey: change.identityNaturalKey,
    },
  });
}

function addQuantityAssertion(
  builder: ArtifactBuilderV1,
  qty: Op5ExtractionResult['quantities'][number],
  identityByKey: Map<string, Op5SagIdentity>,
  source: ExtractionSourceV1,
  parserRunId: string,
  cycleFiscalYear: number,
): void {
  const matchedIdentity = identityByKey.get(qty.identityNaturalKey);
  const evidenceId = evidenceIdV1({
    key: qty.identityNaturalKey,
    row: qty.rowLabel,
    fy: qty.fiscalYear ?? null,
    col: qty.columnIndex,
    kind: 'op5_quantity',
  });
  builder.addEvidence({
    evidenceId,
    sourcePdfSha256: source.sourcePdfSha256,
    parserRunId,
    granularity: 'page_only',
    page: qty.page,
    columnLabel: qty.headerText,
    rowLabel: qty.rowLabel,
  });

  const factId = factIdV1({
    key: qty.identityNaturalKey,
    row: qty.rowLabel,
    fy: qty.fiscalYear ?? null,
    col: qty.columnIndex,
    kind: 'op5_quantity_fact',
  });
  builder.addSourceFact({
    factId,
    sourcePath: `sag:${qty.identityNaturalKey}/qty:${qty.rowLabel}/fy:${qty.fiscalYear ?? 'none'}/col:${qty.columnIndex}`,
    category: 'quantity',
    requiredForCompleteness: false,
    rawValue: qty.quantity,
    evidenceIds: [evidenceId],
  });

  builder.addAssertion({
    assertionKind: 'quantity',
    assertionId: assertionIdV1({
      key: qty.identityNaturalKey,
      row: qty.rowLabel,
      fy: qty.fiscalYear ?? null,
      col: qty.columnIndex,
      kind: 'op5_quantity',
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
    fiscalYear: qty.fiscalYear ?? cycleFiscalYear,
    quantity: qty.quantity,
    ...(qty.unitLabel != null ? { unitLabel: qty.unitLabel } : {}),
    metadata: {
      exhibit: 'OP-5',
      rowLabel: qty.rowLabel,
      headerText: qty.headerText,
      page: qty.page,
      rowIndex: qty.rowIndex,
    },
  });
}

function addNarrativeAssertion(
  builder: ArtifactBuilderV1,
  narrative: Op5ExtractionResult['narratives'][number],
  identityByKey: Map<string, Op5SagIdentity>,
  source: ExtractionSourceV1,
  parserRunId: string,
): void {
  const matchedIdentity = identityByKey.get(narrative.identityNaturalKey);
  const evidenceId = evidenceIdV1({
    key: narrative.identityNaturalKey,
    section: narrative.sectionType,
    page: narrative.page,
    kind: 'op5_narrative',
  });
  builder.addEvidence({
    evidenceId,
    sourcePdfSha256: source.sourcePdfSha256,
    parserRunId,
    granularity: 'page_only',
    page: narrative.page,
  });

  const factId = factIdV1({
    key: narrative.identityNaturalKey,
    section: narrative.sectionType,
    page: narrative.page,
    kind: 'op5_narrative_fact',
  });
  builder.addSourceFact({
    factId,
    sourcePath: `page:${narrative.page}/narrative:${narrative.sectionType}`,
    category: 'text',
    requiredForCompleteness: false,
    rawValue: narrative.text,
    evidenceIds: [evidenceId],
  });

  builder.addAssertion({
    assertionKind: 'narrative',
    assertionId: assertionIdV1({
      key: narrative.identityNaturalKey,
      section: narrative.sectionType,
      page: narrative.page,
      kind: 'op5_narrative',
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
    narrativeType: narrative.narrativeType,
    text: narrative.text,
    metadata: {
      exhibit: 'OP-5',
      sectionType: narrative.sectionType,
      page: narrative.page,
    },
  });
}

function addOmission(
  builder: ArtifactBuilderV1,
  omission: Op5ExtractionResult['omissions'][number],
  source: ExtractionSourceV1,
  _parserRunId: string,
): void {
  const factId = factIdV1({
    page: omission.page,
    row: omission.rowIndex ?? null,
    col: omission.columnIndex ?? null,
    kind: 'op5_omission',
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
      reason: omission.reason,
      message: omission.reason,
    }),
    sourceFactId: factId,
    reason: mapOmissionReason(omission.reason),
    severity: omission.severity,
    message: `OP-5 page ${omission.page}: ${omission.reason}`,
  });
}

function mapOmissionReason(
  reason: string,
): 'unsupported_unit' | 'invalid_identity' | 'ambiguous_layout' | 'missing_value' {
  if (reason.includes('unit')) return 'unsupported_unit';
  if (reason.includes('identity') || reason.includes('SAG')) return 'invalid_identity';
  if (reason.includes('ambiguous')) return 'ambiguous_layout';
  return 'missing_value';
}
