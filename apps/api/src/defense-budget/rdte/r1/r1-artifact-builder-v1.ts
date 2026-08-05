/**
 * r1-artifact-builder-v1 — build a defense_budget_extraction_v1 artifact
 * from R-1 extraction output.
 *
 * Pure module. Uses the Phase 1 ArtifactBuilderV1; no database, no parser,
 * no writer.
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
import type { R1ExtractionResult } from './r1-extractor-v1.js';

export function buildR1Artifact(input: {
  source: ExtractionSourceV1;
  parserRuns: readonly ParserRunV1[];
  extraction: R1ExtractionResult;
  cycleFiscalYear: number;
}): DefenseBudgetExtractionArtifactV1 {
  const { source, parserRuns, extraction, cycleFiscalYear } = input;
  const builder = new ArtifactBuilderV1(source);

  /* When no parser runs are supplied (e.g. unit tests), register a
   * deterministic synthetic run so evidence references resolve. */
  const effectiveParserRuns: ParserRunV1[] =
    parserRuns.length > 0
      ? [...parserRuns]
      : [
          {
            parserRunId: parserRunIdV1({ source: source.sourcePdfSha256 }),
            method: 'manual',
            parserVersion: 'r1-extractor-v1',
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

  /* Identities. */
  for (const identity of extraction.identities) {
    const evidenceId = evidenceIdV1({
      peCode: identity.peCode,
      page: identity.page,
      tableIndex: identity.tableIndex,
      rowIndex: identity.rowIndex,
      kind: 'r1_identity',
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
      peCode: identity.peCode,
      page: identity.page,
      tableIndex: identity.tableIndex,
      rowIndex: identity.rowIndex,
      kind: 'r1_identity_fact',
    });
    builder.addSourceFact({
      factId,
      sourcePath: `page:${identity.page}/table:${identity.tableIndex}/row:${identity.rowIndex}`,
      category: 'identity',
      requiredForCompleteness: true,
      rawValue: identity.peCode,
      evidenceIds: [evidenceId],
    });

    builder.addAssertion({
      assertionKind: 'program_element_identity',
      assertionId: assertionIdV1({
        peCode: identity.peCode,
        page: identity.page,
        tableIndex: identity.tableIndex,
        rowIndex: identity.rowIndex,
        kind: 'r1_identity',
      }),
      sourceFactIds: [factId],
      evidenceIds: [evidenceId],
      confidence: 1,
      identity: { lineKind: 'RDTE_PE', peCode: identity.peCode },
      title: identity.title,
      component: source.component,
      ...(identity.appropriation != null ? { appropriation: identity.appropriation } : {}),
      ...(identity.budgetActivity != null ? { budgetActivity: identity.budgetActivity } : {}),
      ...(identity.budgetActivityName != null
        ? { budgetActivityName: identity.budgetActivityName }
        : {}),
      ...(identity.lineNumber != null ? { lineNumber: identity.lineNumber } : {}),
      metadata: {
        exhibit: 'R-1',
        physicalPage: identity.page,
        ...(identity.printedPage != null ? { printedPage: identity.printedPage } : {}),
        tableIndex: identity.tableIndex,
        rowIndex: identity.rowIndex,
      },
    });
  }

  /* Funding values. Each value retains its exact physical source cell. */
  for (const value of extraction.funding) {
    const sourceCellIdentity = {
      peCode: value.peCode,
      fiscalYear: value.fiscalYear ?? null,
      columnRole: value.columnRole,
      page: value.page,
      tableIndex: value.tableIndex,
      rowIndex: value.rowIndex,
      columnIndex: value.columnIndex,
    } as const;
    const evidenceId = evidenceIdV1({
      ...sourceCellIdentity,
      kind: 'r1_funding',
    });
    builder.addEvidence({
      evidenceId,
      sourcePdfSha256: source.sourcePdfSha256,
      parserRunId: defaultParserRunId,
      granularity: 'page_only',
      page: value.page,
      ...(value.printedPage != null ? { printedPage: value.printedPage } : {}),
      tableLabel: `table_${value.tableIndex}`,
      rowLabel: `row_${value.rowIndex}`,
      columnLabel: value.headerText,
    });

    const factId = factIdV1({
      ...sourceCellIdentity,
      kind: 'r1_funding_fact',
    });
    builder.addSourceFact({
      factId,
      sourcePath: `pe:${value.peCode}/fy:${value.fiscalYear ?? 'non_annual'}/page:${value.page}/table:${value.tableIndex}/row:${value.rowIndex}/col:${value.columnIndex}`,
      category: 'money',
      requiredForCompleteness: true,
      rawValue: value.originalValue,
      evidenceIds: [evidenceId],
    });

    /* Only budget_year_request becomes a funding assertion with field
     * 'request'. All other roles become document_fact assertions so the
     * value is preserved truthfully without canonical-stage contamination. */
    if (value.disposition === 'canonical_request_candidate' && value.fiscalYear != null) {
      builder.addAssertion({
        assertionKind: 'funding',
        assertionId: assertionIdV1({
          ...sourceCellIdentity,
          kind: 'r1_funding',
        }),
        sourceFactIds: [factId],
        evidenceIds: [evidenceId],
        confidence: 1,
        identity: { lineKind: 'RDTE_PE', peCode: value.peCode },
        fiscalYear: value.fiscalYear,
        field: 'request',
        money: {
          originalValue: value.originalValue,
          originalUnit: value.originalUnit,
          valueMillions: value.valueMillions,
        },
        metadata: {
          columnRole: value.columnRole,
          disposition: value.disposition,
          positionCycle: `pb_fy${cycleFiscalYear}`,
          headerText: value.headerText,
          cycleFiscalYear,
          direct: value.direct,
          physicalPage: value.page,
          tableIndex: value.tableIndex,
          rowIndex: value.rowIndex,
          columnIndex: value.columnIndex,
        },
      });
    } else {
      builder.addAssertion({
        assertionKind: 'document_fact',
        assertionId: assertionIdV1({
          ...sourceCellIdentity,
          kind: 'r1_document_fact',
        }),
        sourceFactIds: [factId],
        evidenceIds: [evidenceId],
        confidence: 1,
        fieldName: `r1_${value.columnRole}`,
        value: {
          peCode: value.peCode,
          fiscalYear: value.fiscalYear ?? null,
          columnRole: value.columnRole,
          disposition: value.disposition,
          originalValue: value.originalValue,
          originalUnit: value.originalUnit,
          valueMillions: value.valueMillions,
          positionCycle: `pb_fy${cycleFiscalYear}`,
          headerText: value.headerText,
          physicalPage: value.page,
          tableIndex: value.tableIndex,
          rowIndex: value.rowIndex,
          columnIndex: value.columnIndex,
        },
      });
    }
  }

  /* Omissions must reference real registered source facts. */
  const seenOmissionFacts = new Set<string>();
  for (const omission of extraction.omissions) {
    const omissionIdentity = {
      peCode: omission.peCode ?? null,
      page: omission.page,
      rowIndex: omission.rowIndex ?? null,
      columnIndex: omission.columnIndex ?? null,
      reason: omission.reason,
      rawText: omission.rawText,
    } as const;
    const sourceFactId = factIdV1({ ...omissionIdentity, kind: 'r1_omission_fact' });
    if (!seenOmissionFacts.has(sourceFactId)) {
      seenOmissionFacts.add(sourceFactId);
      builder.addSourceFact({
        factId: sourceFactId,
        sourcePath: `omitted:${omission.reason}/page:${omission.page}${
          omission.rowIndex != null ? `/row:${omission.rowIndex}` : ''
        }${omission.columnIndex != null ? `/col:${omission.columnIndex}` : ''}`,
        category: omission.columnIndex != null ? 'money' : 'metadata',
        requiredForCompleteness: false,
        rawValue: omission.rawText,
        evidenceIds: [],
      });
    }
    builder.addOmission({
      omissionId: omissionIdV1({ ...omissionIdentity, kind: 'r1_omission' }),
      sourceFactId,
      reason: mapOmissionReason(omission.reason),
      severity: omission.reason === 'missing_unit' ? 'blocking' : 'review',
      message: `R-1 omission: ${omission.reason} at page ${omission.page}${
        omission.rowIndex != null ? ` row ${omission.rowIndex}` : ''
      }${omission.columnIndex != null ? ` col ${omission.columnIndex}` : ''}: ${omission.rawText}`,
    });
  }

  /* Conflicts become blocking warnings. */
  for (const conflict of extraction.conflicts) {
    builder.addWarning({
      warningId: `warn_r1_conflict_${conflict.peCode}_${conflict.fiscalYear}_${conflict.columnRole}`,
      code: 'r1_duplicate_conflicting_value',
      severity: 'blocking',
      message: `R-1 conflict for ${conflict.peCode} FY${conflict.fiscalYear} ${conflict.columnRole}: values ${conflict.values.join(', ')} on pages ${conflict.pages.join(', ')}`,
      sourceFactIds: [],
      evidenceIds: [],
    });
  }

  return builder.finalize();
}

function mapOmissionReason(
  reason: string,
):
  | 'unsupported_field'
  | 'missing_value'
  | 'invalid_number'
  | 'unsupported_unit'
  | 'invalid_identity'
  | 'missing_evidence'
  | 'ambiguous_layout'
  | 'legacy_artifact_missing_detail'
  | 'adapter_unimplemented'
  | 'other' {
  switch (reason) {
    case 'invalid_pe_code':
      return 'invalid_identity';
    case 'invalid_number':
      return 'invalid_number';
    case 'missing_unit':
      return 'unsupported_unit';
    case 'unresolved_column_role':
    case 'unresolved_row_alignment':
      return 'ambiguous_layout';
    case 'missing_fiscal_year':
      return 'missing_value';
    default:
      return 'other';
  }
}
