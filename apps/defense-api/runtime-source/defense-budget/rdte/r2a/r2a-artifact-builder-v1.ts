/**
 * r2a-artifact-builder-v1 — build a defense_budget_extraction_v1 artifact
 * from R-2A project identity/narrative and project funding extraction output.
 *
 * Workstreams H/I (Phase 4 plan §13/§14), builder added in WS M/N so a full
 * cycle can be built end-to-end. Rules:
 *   - project identity assertions carry parent PE + bounded project code;
 *   - project narratives ride on the project assertion's mission field and
 *     as document facts (never PE-level narrative);
 *   - project funding assertions carry position-cycle metadata; every
 *     year-bearing value is a `project_budget_position` of the printing PB
 *     cycle (WS I doctrine), contextual/non-annual values become
 *     document_fact assertions;
 *   - blocked projects (missing/invalid parent PE) become blocking
 *     omissions — never silently dropped;
 *   - duplicate conflicts become blocking warnings (never last-wins).
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
import type { R2aProjectExtractionResult } from './r2a-project-extractor-v1.js';
import type { R2aProjectFundingExtractionResult } from './r2a-project-funding-extractor-v1.js';

function mapR2aOmissionReason(
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
    case 'missing_parent_pe':
    case 'invalid_project_code':
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
    case 'no_lawful_disposition':
      return 'missing_value';
    default:
      return 'other';
  }
}

export function buildR2aProjectArtifact(input: {
  source: ExtractionSourceV1;
  parserRuns: readonly ParserRunV1[];
  projects: readonly R2aProjectExtractionResult[];
  funding?: readonly R2aProjectFundingExtractionResult[];
  cycleFiscalYear: number;
}): DefenseBudgetExtractionArtifactV1 {
  const { source, parserRuns, cycleFiscalYear } = input;
  const builder = new ArtifactBuilderV1(source);

  /* Synthetic run for callers supplying none; registered after evidence
   * collection so it declares the pages that evidence cites. */
  const syntheticParserRun: Omit<ParserRunV1, 'pageRanges'> = {
    parserRunId: parserRunIdV1({ source: source.sourcePdfSha256 }),
    method: 'manual',
    parserVersion: 'r2a-artifact-builder-v1',
    parserConfigSha256: source.sourcePdfSha256,
    inputSourceSha256: source.sourcePdfSha256,
    outputArtifactSha256: source.sourcePdfSha256,
  };
  for (const run of parserRuns) {
    builder.addParserRun(run);
  }
  const defaultParserRunId = parserRuns[0]?.parserRunId ?? syntheticParserRun.parserRunId;

  /* ---------------- Project identities + narratives ---------------- */
  for (const result of input.projects) {
    for (const identity of result.identities) {
      const pageStart = Math.min(...identity.pages, identity.pages[0] ?? 1);
      const pageEnd = Math.max(...identity.pages, identity.pages[0] ?? 1);
      const evidenceId = evidenceIdV1({
        parentPeCode: identity.parentPeCode,
        projectCode: identity.projectCode,
        page: pageStart,
        kind: 'r2a_project_identity',
      });
      builder.addEvidence({
        evidenceId,
        sourcePdfSha256: source.sourcePdfSha256,
        parserRunId: defaultParserRunId,
        granularity: 'page_only',
        page: pageStart,
        tableLabel: `pages_${pageStart}_${pageEnd}`,
      });
      const factId = factIdV1({
        parentPeCode: identity.parentPeCode,
        projectCode: identity.projectCode,
        kind: 'r2a_project_identity_fact',
      });
      builder.addSourceFact({
        factId,
        sourcePath: `pe:${identity.parentPeCode}/project:${identity.projectCode}`,
        category: 'project',
        requiredForCompleteness: true,
        rawValue: identity.title,
        evidenceIds: [evidenceId],
      });

      const missionNarratives = result.narratives.filter(
        (n) =>
          n.parentPeCode === identity.parentPeCode &&
          n.projectCode === identity.projectCode &&
          (n.kind === 'mission' || n.kind === 'description'),
      );
      const mission = missionNarratives.map((n) => n.text).join('\n\n');

      builder.addAssertion({
        assertionKind: 'project',
        assertionId: assertionIdV1({
          parentPeCode: identity.parentPeCode,
          projectCode: identity.projectCode,
          kind: 'r2a_project',
        }),
        sourceFactIds: [factId],
        evidenceIds: [evidenceId],
        confidence: 1,
        parentPeCode: identity.parentPeCode,
        projectCode: identity.projectCode,
        title: identity.title,
        ...(mission !== '' ? { mission } : {}),
        ...(identity.budgetActivity != null ? { budgetActivity: identity.budgetActivity } : {}),
        metadata: {
          exhibit: 'R-2A',
          pageStart,
          pageEnd,
          printedPages: identity.printedPages,
        },
      });

      /* Narrative sections beyond mission are preserved as document facts —
       * source-faithful, never merged into PE-level narrative. */
      for (const narrative of result.narratives) {
        if (
          narrative.parentPeCode !== identity.parentPeCode ||
          narrative.projectCode !== identity.projectCode
        ) {
          continue;
        }
        builder.addAssertion({
          assertionKind: 'document_fact',
          assertionId: assertionIdV1({
            parentPeCode: narrative.parentPeCode,
            projectCode: narrative.projectCode,
            narrativeKind: narrative.kind,
            page: narrative.page,
            kind: 'r2a_project_narrative',
          }),
          sourceFactIds: [factId],
          evidenceIds: [evidenceId],
          confidence: 1,
          fieldName: `r2a_project_narrative_${narrative.kind}`,
          value: {
            peCode: narrative.parentPeCode,
            projectCode: narrative.projectCode,
            narrativeKind: narrative.kind,
            text: narrative.text,
            page: narrative.page,
            ...(narrative.printedPage != null ? { printedPage: narrative.printedPage } : {}),
          },
        });
      }

      /* Title aliases (later-page variants) are document facts. */
      for (const alias of identity.aliases) {
        builder.addAssertion({
          assertionKind: 'document_fact',
          assertionId: assertionIdV1({
            parentPeCode: identity.parentPeCode,
            projectCode: identity.projectCode,
            alias,
            kind: 'r2a_project_title_alias',
          }),
          sourceFactIds: [factId],
          evidenceIds: [evidenceId],
          confidence: 1,
          fieldName: 'r2a_project_title_alias',
          value: {
            peCode: identity.parentPeCode,
            projectCode: identity.projectCode,
            aliasTitle: alias,
          },
        });
      }
    }

    /* Conflicting titles/narratives: blocking warnings, never last-wins. */
    for (const conflict of result.conflicts) {
      builder.addWarning({
        warningId: warningIdV1({
          kind: 'r2a_duplicate_conflict',
          parentPeCode: conflict.parentPeCode,
          projectCode: conflict.projectCode,
          field: conflict.field,
        }),
        code: 'r2a_duplicate_natural_key_conflict',
        severity: 'blocking',
        message: `R-2A conflict for ${conflict.parentPeCode}/${conflict.projectCode} ${conflict.field}: ${conflict.values.length} distinct values on pages ${conflict.pages.join(', ')}`,
        sourceFactIds: [],
        evidenceIds: [],
      });
    }

    /* Blocked projects (missing mandatory parent) are blocking omissions. */
    for (const blocked of result.blocked) {
      const factId = factIdV1({
        projectCode: blocked.projectCode,
        page: blocked.page,
        reason: blocked.reason,
        kind: 'r2a_blocked_project_fact',
      });
      builder.addSourceFact({
        factId,
        sourcePath: `blocked:${blocked.reason}/project:${blocked.projectCode}/page:${blocked.page}`,
        category: 'project',
        requiredForCompleteness: false,
        rawValue: blocked.projectCode,
        evidenceIds: [],
      });
      builder.addOmission({
        omissionId: omissionIdV1({
          projectCode: blocked.projectCode,
          page: blocked.page,
          reason: blocked.reason,
        }),
        sourceFactId: factId,
        reason: 'invalid_identity',
        severity: 'blocking',
        message: `R-2A project ${blocked.projectCode} blocked at page ${blocked.page}: ${blocked.reason}`,
      });
    }

    /* Project-level omissions. */
    for (const omission of result.omissions) {
      const factId = factIdV1({
        parentPeCode: omission.parentPeCode ?? null,
        projectCode: omission.projectCode ?? null,
        page: omission.page,
        reason: omission.reason,
        kind: 'r2a_project_omission_fact',
      });
      builder.addSourceFact({
        factId,
        sourcePath: `omitted:${omission.reason}/page:${omission.page}`,
        category: 'project',
        requiredForCompleteness: false,
        rawValue: omission.rawText,
        evidenceIds: [],
      });
      builder.addOmission({
        omissionId: omissionIdV1({
          parentPeCode: omission.parentPeCode ?? null,
          projectCode: omission.projectCode ?? null,
          page: omission.page,
          reason: omission.reason,
          rawText: omission.rawText,
        }),
        sourceFactId: factId,
        reason: mapR2aOmissionReason(omission.reason),
        severity: omission.reason === 'missing_unit' ? 'blocking' : 'review',
        message: `R-2A omission: ${omission.reason} at page ${omission.page}: ${omission.rawText}`,
      });
    }
  }

  /* ---------------- Project funding ---------------- */
  for (const result of input.funding ?? []) {
    for (const value of result.values) {
      const evidenceId = evidenceIdV1({
        parentPeCode: value.parentPeCode,
        projectCode: value.projectCode,
        fiscalYear: value.fiscalYear ?? null,
        columnIndex: value.columnIndex,
        page: value.page,
        kind: 'r2a_project_funding',
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
        parentPeCode: value.parentPeCode,
        projectCode: value.projectCode,
        fiscalYear: value.fiscalYear ?? null,
        columnRole: value.columnRole,
        columnIndex: value.columnIndex,
        page: value.page,
        kind: 'r2a_project_funding_fact',
      });
      builder.addSourceFact({
        factId,
        sourcePath: `pe:${value.parentPeCode}/project:${value.projectCode}/fy:${value.fiscalYear ?? 'non_annual'}/page:${value.page}/col:${value.columnIndex}`,
        category: 'money',
        requiredForCompleteness: true,
        rawValue: value.originalValue,
        evidenceIds: [evidenceId],
      });

      const fundingMetadata: Record<string, string | number | boolean | null> = {
        exhibit: 'R-2A',
        rowKind: value.rowKind,
        columnRole: value.columnRole,
        disposition: value.disposition,
        positionCycle: value.positionCycle,
        headerText: value.headerText,
        cycleFiscalYear,
        direct: value.direct,
        physicalPage: value.page,
        tableIndex: value.tableIndex,
        rowIndex: value.rowIndex,
        columnIndex: value.columnIndex,
      };

      /* Year-bearing project positions (budget-year request AND outyears of
       * the printing cycle) become project_funding assertions with
       * project_budget_position disposition metadata. Contextual and
       * non-annual values become document_fact assertions. */
      if (value.disposition === 'project_budget_position' && value.fiscalYear != null) {
        builder.addAssertion({
          assertionKind: 'project_funding',
          assertionId: assertionIdV1({
            parentPeCode: value.parentPeCode,
            projectCode: value.projectCode,
            fiscalYear: value.fiscalYear,
            columnRole: value.columnRole,
            page: value.page,
            columnIndex: value.columnIndex,
            kind: 'r2a_project_funding',
          }),
          sourceFactIds: [factId],
          evidenceIds: [evidenceId],
          confidence: 1,
          parentPeCode: value.parentPeCode,
          projectCode: value.projectCode,
          fiscalYear: value.fiscalYear,
          field: 'request',
          money: {
            originalValue: value.originalValue,
            originalUnit: value.originalUnit,
            valueMillions: value.valueMillions,
          },
          metadata: fundingMetadata,
        });
      } else {
        builder.addAssertion({
          assertionKind: 'document_fact',
          assertionId: assertionIdV1({
            parentPeCode: value.parentPeCode,
            projectCode: value.projectCode,
            fiscalYear: value.fiscalYear ?? null,
            columnRole: value.columnRole,
            rowKind: value.rowKind,
            columnIndex: value.columnIndex,
            page: value.page,
            kind: 'r2a_project_document_fact',
          }),
          sourceFactIds: [factId],
          evidenceIds: [evidenceId],
          confidence: 1,
          fieldName: `r2a_${value.columnRole}`,
          value: {
            peCode: value.parentPeCode,
            projectCode: value.projectCode,
            rowKind: value.rowKind,
            fiscalYear: value.fiscalYear ?? null,
            columnRole: value.columnRole,
            disposition: value.disposition,
            originalValue: value.originalValue,
            originalUnit: value.originalUnit,
            valueMillions: value.valueMillions,
            positionCycle: value.positionCycle,
            headerText: value.headerText,
            direct: value.direct,
          },
        });
      }
    }

    for (const omission of result.omissions) {
      const factId = factIdV1({
        parentPeCode: omission.parentPeCode ?? null,
        projectCode: omission.projectCode ?? null,
        page: omission.page,
        rowIndex: omission.rowIndex ?? null,
        columnIndex: omission.columnIndex ?? null,
        reason: omission.reason,
        kind: 'r2a_funding_omission_fact',
      });
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
      builder.addOmission({
        omissionId: omissionIdV1({
          parentPeCode: omission.parentPeCode ?? null,
          projectCode: omission.projectCode ?? null,
          page: omission.page,
          rowIndex: omission.rowIndex ?? null,
          columnIndex: omission.columnIndex ?? null,
          reason: omission.reason,
          rawText: omission.rawText,
        }),
        sourceFactId: factId,
        reason: mapR2aOmissionReason(omission.reason),
        severity: omission.reason === 'missing_unit' ? 'blocking' : 'review',
        message: `R-2A funding omission: ${omission.reason} at page ${omission.page}: ${omission.rawText}`,
      });
    }

    if (result.unitResolution.status !== 'resolved') {
      builder.addWarning({
        warningId: warningIdV1({
          kind: 'r2a_unit_unresolved',
          parentPeCode: result.parentPeCode,
          projectCode: result.projectCode,
          status: result.unitResolution.status,
        }),
        code: 'r2a_unit_unresolved',
        severity: 'blocking',
        message: `R-2A unit resolution ${result.unitResolution.status} for ${result.parentPeCode}/${result.projectCode}: ${result.unitResolution.reason}`,
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
