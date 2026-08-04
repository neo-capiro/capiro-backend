/**
 * r2-pe-funding-builder — build a defense_budget_extraction_v1 artifact
 * from R-2 PE-level funding extraction output.
 *
 * Workstream G (Phase 4 plan §12). Rules:
 *   - Only `canonical_request_candidate` values become `funding` assertions
 *     with field `request`; everything else is preserved as a
 *     `document_fact` so no historical/contextual value is ever projected
 *     to a canonical stage;
 *   - outyear projections keep `pe_budget_position` disposition metadata;
 *   - base/OCO splits are contextual components; a missing total is NEVER
 *     derived silently (no synthetic derived values);
 *   - cost-to-complete/total-cost are non-annual costs;
 *   - R-1/R-2 comparison requests reference the R-1 side by natural key
 *     only; the two exhibits always retain different source-document/proof
 *     identities.
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
  warningIdV1,
} from '../../contracts/artifact-builders.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
  ParserRunV1,
} from '../../contracts/extraction-artifact-v1.js';
import type {
  R2ExtractionResult,
  R2FundingValue,
  R2R1ComparisonRequestV1,
} from './r2-cost-table-extractor-v1.js';

/* ------------------------------------------------------------------ */
/* Omission reason mapping (shared with the R-1 artifact builder)       */
/* ------------------------------------------------------------------ */

type OmissionReasonV1 =
  | 'unsupported_field'
  | 'missing_value'
  | 'invalid_number'
  | 'unsupported_unit'
  | 'invalid_identity'
  | 'missing_evidence'
  | 'ambiguous_layout'
  | 'legacy_artifact_missing_detail'
  | 'adapter_unimplemented'
  | 'other';

export function mapR2OmissionReason(reason: string): OmissionReasonV1 {
  switch (reason) {
    case 'invalid_pe_code':
      return 'invalid_identity';
    case 'invalid_number':
      return 'invalid_number';
    case 'missing_unit':
      return 'unsupported_unit';
    case 'unresolved_column_role':
    case 'repeated_header':
    case 'continuation_row':
      return 'ambiguous_layout';
    case 'missing_fiscal_year':
      return 'missing_value';
    default:
      return 'other';
  }
}

/* ------------------------------------------------------------------ */
/* Assertion metadata                                                   */
/* ------------------------------------------------------------------ */

function fundingMetadata(
  value: R2FundingValue,
  cycleFiscalYear: number,
): Record<string, string | number | boolean | null> {
  return {
    exhibit: 'R-2',
    rowKind: value.rowKind,
    columnRole: value.columnRole,
    disposition: value.disposition,
    positionCycle: `pb_fy${cycleFiscalYear}`,
    headerText: value.headerText,
    cycleFiscalYear,
    componentContext: value.componentContext,
    direct: value.direct,
    physicalPage: value.page,
    tableIndex: value.tableIndex,
    rowIndex: value.rowIndex,
    columnIndex: value.columnIndex,
    ...(value.projectCode != null ? { projectCode: value.projectCode } : {}),
    ...(value.printedPage != null ? { printedPage: value.printedPage } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Builder                                                              */
/* ------------------------------------------------------------------ */

export function buildR2PeFundingArtifact(input: {
  source: ExtractionSourceV1;
  parserRuns: readonly ParserRunV1[];
  extractions: readonly R2ExtractionResult[];
  comparisonRequests?: readonly R2R1ComparisonRequestV1[];
  cycleFiscalYear: number;
}): DefenseBudgetExtractionArtifactV1 {
  const { source, parserRuns, cycleFiscalYear } = input;
  const builder = new ArtifactBuilderV1(source);

  /* Deterministic synthetic parser run when none are supplied (unit tests). */
  const effectiveParserRuns: ParserRunV1[] =
    parserRuns.length > 0
      ? [...parserRuns]
      : [
          {
            parserRunId: parserRunIdV1({ source: source.sourcePdfSha256 }),
            method: 'manual',
            parserVersion: 'r2-pe-funding-builder-v1',
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

  for (const extraction of input.extractions) {
    for (const value of extraction.values) {
      const evidenceId = evidenceIdV1({
        peCode: value.peCode,
        fiscalYear: value.fiscalYear ?? null,
        rowKind: value.rowKind,
        rowIndex: value.rowIndex,
        columnIndex: value.columnIndex,
        page: value.page,
        kind: 'r2_funding',
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
        peCode: value.peCode,
        fiscalYear: value.fiscalYear ?? null,
        columnRole: value.columnRole,
        rowKind: value.rowKind,
        rowIndex: value.rowIndex,
        columnIndex: value.columnIndex,
        page: value.page,
        kind: 'r2_funding_fact',
      });
      builder.addSourceFact({
        factId,
        sourcePath: `pe:${value.peCode}/fy:${value.fiscalYear ?? 'non_annual'}/page:${value.page}/row:${value.rowIndex}/col:${value.columnIndex}`,
        category: 'money',
        requiredForCompleteness: true,
        rawValue: value.originalValue,
        evidenceIds: [evidenceId],
      });

      /* Only the cycle-FY budget-year request becomes a funding assertion.
       * Every other role becomes a document_fact so the printed value is
       * preserved truthfully without canonical-stage contamination. */
      if (value.disposition === 'canonical_request_candidate' && value.fiscalYear != null) {
        builder.addAssertion({
          assertionKind: 'funding',
          assertionId: assertionIdV1({
            peCode: value.peCode,
            fiscalYear: value.fiscalYear,
            columnRole: value.columnRole,
            rowIndex: value.rowIndex,
            page: value.page,
            kind: 'r2_funding',
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
          metadata: fundingMetadata(value, cycleFiscalYear),
        });
      } else {
        builder.addAssertion({
          assertionKind: 'document_fact',
          assertionId: assertionIdV1({
            peCode: value.peCode,
            fiscalYear: value.fiscalYear ?? null,
            columnRole: value.columnRole,
            rowKind: value.rowKind,
            rowIndex: value.rowIndex,
            columnIndex: value.columnIndex,
            page: value.page,
            kind: 'r2_document_fact',
          }),
          sourceFactIds: [factId],
          evidenceIds: [evidenceId],
          confidence: 1,
          fieldName: `r2_${value.columnRole}`,
          value: {
            peCode: value.peCode,
            projectCode: value.projectCode ?? null,
            rowKind: value.rowKind,
            fiscalYear: value.fiscalYear ?? null,
            columnRole: value.columnRole,
            disposition: value.disposition,
            originalValue: value.originalValue,
            originalUnit: value.originalUnit,
            valueMillions: value.valueMillions,
            componentContext: value.componentContext,
            positionCycle: `pb_fy${cycleFiscalYear}`,
            headerText: value.headerText,
            direct: value.direct,
          },
        });
      }
    }

    /* Omissions. Each omission references a REAL registered source fact —
     * the contract rejects dangling omission references. Omitted facts are
     * not required for completeness and carry no evidence (the value could
     * not be extracted). Layout notes (repeated headers, continuation rows)
     * are review-severity and do not need evidence either. */
    const seenOmissionFacts = new Set<string>();
    for (const omission of extraction.omissions) {
      const factId = factIdV1({
        peCode: omission.peCode ?? null,
        page: omission.page,
        rowIndex: omission.rowIndex ?? null,
        columnIndex: omission.columnIndex ?? null,
        reason: omission.reason,
        kind: 'r2_omission_fact',
      });
      if (!seenOmissionFacts.has(factId)) {
        seenOmissionFacts.add(factId);
        builder.addSourceFact({
          factId,
          sourcePath: `omitted:${omission.reason}/page:${omission.page}${
            omission.rowIndex != null ? `/row:${omission.rowIndex}` : ''
          }${omission.columnIndex != null ? `/col:${omission.columnIndex}` : ''}`,
          category: 'money',
          requiredForCompleteness: false,
          rawValue: omission.rawText,
          evidenceIds: [],
        });
      }
      builder.addOmission({
        omissionId: omissionIdV1({
          peCode: omission.peCode ?? null,
          page: omission.page,
          rowIndex: omission.rowIndex ?? null,
          columnIndex: omission.columnIndex ?? null,
          reason: omission.reason,
          rawText: omission.rawText,
        }),
        sourceFactId: factId,
        reason: mapR2OmissionReason(omission.reason),
        severity: omission.reason === 'missing_unit' ? 'blocking' : 'review',
        message: `R-2 omission: ${omission.reason} at page ${omission.page}${
          omission.rowIndex != null ? ` row ${omission.rowIndex}` : ''
        }${omission.columnIndex != null ? ` col ${omission.columnIndex}` : ''}: ${omission.rawText}`,
      });
    }

    /* Unit resolution failure is blocking. */
    if (extraction.unitResolution.status !== 'resolved') {
      builder.addWarning({
        warningId: warningIdV1({
          kind: 'r2_unit_unresolved',
          peCode: extraction.peCode,
          status: extraction.unitResolution.status,
        }),
        code: 'r2_unit_unresolved',
        severity: 'blocking',
        message: `R-2 unit resolution ${extraction.unitResolution.status} for PE ${extraction.peCode}: ${
          extraction.unitResolution.status === 'missing'
            ? extraction.unitResolution.reason
            : extraction.unitResolution.reason
        }`,
        sourceFactIds: [],
        evidenceIds: [],
      });
    }

    /* Positional fallback requires review. */
    if (extraction.usedPositionalFallback) {
      builder.addWarning({
        warningId: warningIdV1({
          kind: 'r2_positional_fallback',
          peCode: extraction.peCode,
          policy: extraction.fallbackPolicyId ?? null,
        }),
        code: 'r2_positional_fallback_used',
        severity: 'review',
        message: `R-2 header used positional fallback for PE ${extraction.peCode} (policy ${extraction.fallbackPolicyId ?? 'unknown'})`,
        sourceFactIds: [],
        evidenceIds: [],
      });
    }
  }

  /* R-1/R-2 comparison requests: document_fact assertions that reference
   * the R-1 side by natural key only. The R-1 reference resolves through
   * Phase 2's independent reference index with its own source-document and
   * proof identity — never shared with this R-2 artifact. */
  for (const request of input.comparisonRequests ?? []) {
    const evidenceId = evidenceIdV1({
      kind: 'r2_r1_comparison_evidence',
      peCode: request.peCode,
      fiscalYear: request.fiscalYear,
      page: request.r2Evidence.page,
    });
    builder.addEvidence({
      evidenceId,
      sourcePdfSha256: source.sourcePdfSha256,
      parserRunId: defaultParserRunId,
      granularity: 'page_only',
      page: request.r2Evidence.page,
      ...(request.r2Evidence.printedPage != null
        ? { printedPage: request.r2Evidence.printedPage }
        : {}),
      tableLabel: `table_${request.r2Evidence.tableIndex}`,
      rowLabel: `row_${request.r2Evidence.rowIndex}`,
      columnLabel: request.r2Evidence.headerText,
    });

    const factId = factIdV1({
      kind: 'r2_r1_comparison_fact',
      peCode: request.peCode,
      fiscalYear: request.fiscalYear,
    });
    builder.addSourceFact({
      factId,
      sourcePath: `comparison:r1_r2/pe:${request.peCode}/fy:${request.fiscalYear}`,
      category: 'relationship',
      requiredForCompleteness: false,
      rawValue: request.r2ValueMillions,
      evidenceIds: [evidenceId],
    });

    builder.addAssertion({
      assertionKind: 'document_fact',
      assertionId: assertionIdV1({
        kind: 'r2_r1_comparison',
        peCode: request.peCode,
        fiscalYear: request.fiscalYear,
      }),
      sourceFactIds: [factId],
      evidenceIds: [evidenceId],
      confidence: 1,
      fieldName: 'r1_r2_pe_funding_agreement_request',
      value: {
        comparisonKind: request.comparisonKind,
        peCode: request.peCode,
        fiscalYear: request.fiscalYear,
        field: request.field,
        r2ValueMillions: request.r2ValueMillions,
        r2SourcePdfSha256: source.sourcePdfSha256,
        r2Evidence: {
          page: request.r2Evidence.page,
          printedPage: request.r2Evidence.printedPage ?? null,
          tableIndex: request.r2Evidence.tableIndex,
          rowIndex: request.r2Evidence.rowIndex,
          columnIndex: request.r2Evidence.columnIndex,
          headerText: request.r2Evidence.headerText,
        },
        /* The R-1 side is a natural key into the independent reference
         * artifact index. It must resolve to an artifact whose
         * sourceDocumentId/sourcePdfSha256 differs from this artifact. */
        r1ReferenceKey: request.r1ReferenceKey,
        independence: 'cross_document_independent_reference',
      },
    });
  }

  return builder.finalize();
}
