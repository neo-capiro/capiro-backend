/**
 * r4-artifact-builder-v1 — build a defense_budget_extraction_v1 artifact
 * from R-4/R-4A milestone extraction output.
 *
 * Workstream K (Phase 4 plan §16), builder added in WS M/N so a full cycle
 * can be built end-to-end. Rules:
 *   - exact plannedDate/actualDate only when the source prints an exact
 *     date; quarter/month/year periods keep structured metadata and never
 *     fabricate calendar dates;
 *   - every milestone row is a required source fact (asserted or omitted);
 *   - blocked/omitted rows become explicit omissions, never silent drops.
 *
 * Pure module. Uses the Phase 1 ArtifactBuilderV1; no database, no parser,
 * no writer.
 */
import {
  ArtifactBuilderV1,
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
import { buildR4MilestoneAssertions } from './r4-extractor-v1.js';
import type { R4ExtractionResult } from './r4-extractor-v1.js';

export function buildR4MilestoneArtifact(input: {
  source: ExtractionSourceV1;
  parserRuns: readonly ParserRunV1[];
  extractions: readonly R4ExtractionResult[];
}): DefenseBudgetExtractionArtifactV1 {
  const { source, parserRuns } = input;
  const builder = new ArtifactBuilderV1(source);

  const effectiveParserRuns: ParserRunV1[] =
    parserRuns.length > 0
      ? [...parserRuns]
      : [
          {
            parserRunId: parserRunIdV1({ source: source.sourcePdfSha256 }),
            method: 'manual',
            parserVersion: 'r4-artifact-builder-v1',
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

  let seq = 0;
  for (const result of input.extractions) {
    const assertions = buildR4MilestoneAssertions({
      milestones: result.milestones,
      assertionIdPrefix: `assert_r4_${result.peCode}`,
      sourceFactIdPrefix: `fact_r4_${result.peCode}`,
      evidenceIdPrefix: `ev_r4_${result.peCode}`,
    });

    for (const assertion of assertions) {
      seq += 1;
      const milestone = result.milestones[seq - 1];
      const page = milestone?.page ?? 1;
      const evidenceId = assertion.evidenceIds[0] ?? evidenceIdV1({
        peCode: result.peCode,
        milestoneType: assertion.milestoneType,
        page,
        kind: 'r4_milestone',
      });
      builder.addEvidence({
        evidenceId,
        sourcePdfSha256: source.sourcePdfSha256,
        parserRunId: defaultParserRunId,
        granularity: 'page_only',
        page,
        ...(milestone?.printedPage != null ? { printedPage: milestone.printedPage } : {}),
        tableLabel: `table_${milestone?.tableIndex ?? 0}`,
        rowLabel: `row_${milestone?.rowIndex ?? 0}`,
      });

      const factId =
        assertion.sourceFactIds[0] ??
        factIdV1({
          peCode: result.peCode,
          milestoneType: assertion.milestoneType,
          page,
          kind: 'r4_milestone_fact',
        });
      builder.addSourceFact({
        factId,
        sourcePath: `pe:${result.peCode}/milestone:${assertion.milestoneType}/page:${page}`,
        category: 'milestone',
        requiredForCompleteness: true,
        rawValue: assertion.milestoneType,
        evidenceIds: [evidenceId],
      });

      /* The strict milestone schema has no top-level projectCode field:
       * project scope travels in assertion metadata only. */
      const metadata = (assertion.metadata ?? {}) as Record<string, unknown>;
      builder.addAssertion({
        assertionKind: 'milestone',
        assertionId: assertion.assertionId,
        sourceFactIds: [factId],
        evidenceIds: [evidenceId],
        confidence: assertion.confidence,
        parentPeCode: assertion.parentPeCode,
        milestoneType: assertion.milestoneType,
        ...(assertion.plannedDate != null ? { plannedDate: assertion.plannedDate } : {}),
        ...(assertion.actualDate != null ? { actualDate: assertion.actualDate } : {}),
        ...(assertion.status != null ? { status: assertion.status } : {}),
        ...(assertion.notes != null ? { notes: assertion.notes } : {}),
        metadata: {
          ...metadata,
          exhibit: 'R-4',
        },
      });
    }

    /* Omissions. */
    for (const omission of result.omissions) {
      const factId = factIdV1({
        peCode: omission.peCode ?? null,
        page: omission.page,
        rowIndex: omission.rowIndex ?? null,
        reason: omission.reason,
        kind: 'r4_omission_fact',
      });
      builder.addSourceFact({
        factId,
        sourcePath: `omitted:${omission.reason}/page:${omission.page}`,
        category: 'milestone',
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
        reason: omission.reason === 'missing_unit' ? 'unsupported_unit' : 'other',
        severity: 'review',
        message: `R-4 omission: ${omission.reason} at page ${omission.page}: ${omission.rawText}`,
      });
    }
  }

  return builder.finalize();
}
