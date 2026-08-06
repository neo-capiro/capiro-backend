/**
 * r3-artifact-builder-v1 — build a defense_budget_extraction_v1 artifact
 * from R-3 performer extraction output.
 *
 * Workstream J (Phase 4 plan §15), builder added in WS M/N so a full cycle
 * can be built end-to-end. Rules:
 *   - role-honest: PERFORMING_ACTIVITY default; PRIME_CONTRACTOR only with
 *     explicit source evidence (roleExplicit metadata);
 *   - totalCost is a cost-analysis fact — never request/enacted/executed or
 *     annual funding;
 *   - raw performerName + performerNormalized are both preserved;
 *   - duplicate natural-key conflicts become blocking warnings (no
 *     last-wins).
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
import type { R3ExtractionResult } from './r3-table-extractor-v1.js';

export function buildR3PerformerArtifact(input: {
  source: ExtractionSourceV1;
  parserRuns: readonly ParserRunV1[];
  extractions: readonly R3ExtractionResult[];
  cycleFiscalYear: number;
}): DefenseBudgetExtractionArtifactV1 {
  const { source, parserRuns, cycleFiscalYear } = input;
  const builder = new ArtifactBuilderV1(source);

  /* Synthetic run for callers supplying none; registered after evidence
   * collection so it declares the pages that evidence cites. */
  const syntheticParserRun: Omit<ParserRunV1, 'pageRanges'> = {
    parserRunId: parserRunIdV1({ source: source.sourcePdfSha256 }),
    method: 'manual',
    parserVersion: 'r3-artifact-builder-v1',
    parserConfigSha256: source.sourcePdfSha256,
    inputSourceSha256: source.sourcePdfSha256,
    outputArtifactSha256: source.sourcePdfSha256,
  };
  for (const run of parserRuns) {
    builder.addParserRun(run);
  }
  const defaultParserRunId = parserRuns[0]?.parserRunId ?? syntheticParserRun.parserRunId;

  for (const result of input.extractions) {
    for (const performer of result.performers) {
      const evidenceId = evidenceIdV1({
        peCode: performer.parentPeCode,
        naturalKey: performer.naturalKey,
        page: performer.page,
        kind: 'r3_performer',
      });
      builder.addEvidence({
        evidenceId,
        sourcePdfSha256: source.sourcePdfSha256,
        parserRunId: defaultParserRunId,
        granularity: 'page_only',
        page: performer.page,
        ...(performer.printedPage != null ? { printedPage: performer.printedPage } : {}),
        tableLabel: `table_${performer.tableIndex}`,
        rowLabel: `row_${performer.rowIndex}`,
      });
      const factId = factIdV1({
        peCode: performer.parentPeCode,
        naturalKey: performer.naturalKey,
        page: performer.page,
        kind: 'r3_performer_fact',
      });
      builder.addSourceFact({
        factId,
        sourcePath: `pe:${performer.parentPeCode}/performer:${performer.naturalKey}/page:${performer.page}`,
        category: 'performer',
        requiredForCompleteness: true,
        rawValue: performer.performerName,
        evidenceIds: [evidenceId],
      });

      builder.addAssertion({
        assertionKind: 'performer',
        assertionId: assertionIdV1({
          peCode: performer.parentPeCode,
          naturalKey: performer.naturalKey,
          kind: 'r3_performer',
        }),
        sourceFactIds: [factId],
        evidenceIds: [evidenceId],
        confidence: 1,
        parentPeCode: performer.parentPeCode,
        ...(performer.projectCode != null ? { projectCode: performer.projectCode } : {}),
        performerName: performer.performerName,
        performerNormalized: performer.performerNormalized,
        performerRole: performer.performerRole,
        ...(performer.location != null ? { location: performer.location } : {}),
        ...(performer.contractMethod != null ? { contractMethod: performer.contractMethod } : {}),
        ...(performer.costCategory != null ? { costCategory: performer.costCategory } : {}),
        ...(performer.fiscalYear != null ? { fiscalYear: performer.fiscalYear } : {}),
        ...(performer.totalCost != null
          ? {
              totalCost: {
                originalValue: performer.totalCost.originalValue,
                originalUnit: performer.totalCost.originalUnit,
                valueMillions: performer.totalCost.valueMillions,
              },
            }
          : {}),
        metadata: {
          exhibit: 'R-3',
          roleExplicit: performer.roleExplicit,
          naturalKey: performer.naturalKey,
          physicalPage: performer.page,
          tableIndex: performer.tableIndex,
          rowIndex: performer.rowIndex,
          cycleFiscalYear,
        },
      });
    }

    /* Conflicting rows: blocking warnings, never last-wins. */
    for (const conflict of result.conflicts) {
      builder.addWarning({
        warningId: warningIdV1({
          kind: 'r3_duplicate_conflict',
          naturalKey: conflict.naturalKey,
        }),
        code: 'r3_duplicate_natural_key_conflict',
        severity: 'blocking',
        message: `R-3 conflict for natural key ${conflict.naturalKey}: distinct names ${conflict.performerNames.join(' | ')} on pages ${conflict.pages.join(', ')} (${conflict.reason})`,
        sourceFactIds: [],
        evidenceIds: [],
      });
    }

    /* Omissions. */
    for (const omission of result.omissions) {
      const factId = factIdV1({
        peCode: omission.peCode ?? null,
        page: omission.page,
        rowIndex: omission.rowIndex ?? null,
        reason: omission.reason,
        kind: 'r3_omission_fact',
      });
      builder.addSourceFact({
        factId,
        sourcePath: `omitted:${omission.reason}/page:${omission.page}`,
        category: 'performer',
        requiredForCompleteness: false,
        rawValue: omission.rawText,
        evidenceIds: [],
      });
      builder.addOmission({
        omissionId: omissionIdV1({
          peCode: omission.peCode ?? null,
          page: omission.page,
          rowIndex: omission.rowIndex ?? null,
          reason: omission.reason,
          rawText: omission.rawText,
        }),
        sourceFactId: factId,
        reason: mapR3OmissionReason(omission.reason),
        severity: omission.reason === 'missing_unit' ? 'blocking' : 'review',
        message: `R-3 omission: ${omission.reason} at page ${omission.page}: ${omission.rawText}`,
      });
    }

    if (result.unitResolution.status !== 'resolved') {
      builder.addWarning({
        warningId: warningIdV1({
          kind: 'r3_unit_unresolved',
          peCode: result.peCode,
          status: result.unitResolution.status,
        }),
        code: 'r3_unit_unresolved',
        severity: 'blocking',
        message: `R-3 unit resolution ${result.unitResolution.status} for PE ${result.peCode}: ${result.unitResolution.reason}`,
        sourceFactIds: [],
        evidenceIds: [],
      });
    }
  }

  if (parserRuns.length === 0) {
    builder.addParserRunCoveringAddedEvidence(syntheticParserRun);
  }

  return builder.finalize();
}

function mapR3OmissionReason(
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
    case 'repeated_header':
      return 'ambiguous_layout';
    default:
      return 'other';
  }
}
