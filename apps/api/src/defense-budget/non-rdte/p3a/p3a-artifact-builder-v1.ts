/**
 * p3a-artifact-builder-v1 — build a defense_budget_extraction_v1 artifact
 * from P-3A extraction output.
 *
 * Pure module. Uses the Phase 1 ArtifactBuilderV1; no database, no parser,
 * no writer. No canonical writes. No ProgramElementWriterService.
 *
 * Identity rules:
 *   - P-3A parent references are PROCUREMENT_BLIN, NEVER RDTE_PE.
 *   - Parent relationships are explicit in the exhibit or manifest, never
 *     fuzzy-title-matched.
 *   - Title is never a natural key.
 *   - No magnitude-based unit inference.
 *   - No fabricated funding amount from narrative text.
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
import type { P3aExtractionResult } from './p3a-extractor-v1.js';

export function buildP3aArtifact(input: {
  source: ExtractionSourceV1;
  parserRuns: readonly ParserRunV1[];
  extraction: P3aExtractionResult;
  cycleFiscalYear: number;
}): DefenseBudgetExtractionArtifactV1 {
  const { source, parserRuns, extraction } = input;
  const builder = new ArtifactBuilderV1(source);

  const effectiveParserRuns: ParserRunV1[] =
    parserRuns.length > 0
      ? [...parserRuns]
      : [
          {
            parserRunId: parserRunIdV1({ source: source.sourcePdfSha256 }),
            method: 'manual' as const,
            parserVersion: 'p3a-extractor-v1',
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

  const parentRef = extraction.parentReference;
  const parentCode = parentRef?.identity.code ?? 'UNKNOWN';
  const parentAccount = parentRef?.identity.account ?? 'UNKNOWN';

  /* Parent identity — PROCUREMENT_BLIN */
  if (parentRef != null) {
    const evidenceId = evidenceIdV1({
      code: parentRef.printedCode,
      page: parentRef.page,
      kind: 'p3a_parent_ref',
    });
    builder.addEvidence({
      evidenceId,
      sourcePdfSha256: source.sourcePdfSha256,
      parserRunId: defaultParserRunId,
      granularity: 'page_only',
      page: parentRef.page,
    });

    const factId = factIdV1({
      code: parentRef.printedCode,
      page: parentRef.page,
      kind: 'p3a_parent_ref_fact',
    });
    builder.addSourceFact({
      factId,
      sourcePath: `page:${parentRef.page}/parent_ref:${parentRef.printedCode}`,
      category: 'identity',
      requiredForCompleteness: true,
      rawValue: {
        printedCode: parentRef.printedCode,
        source: parentRef.source,
        ...(parentRef.exhibitSnippet != null
          ? { exhibitSnippet: parentRef.exhibitSnippet }
          : {}),
      },
      evidenceIds: [evidenceId],
    });

    builder.addAssertion({
      assertionKind: 'procurement_line',
      assertionId: assertionIdV1({
        code: parentRef.printedCode,
        page: parentRef.page,
        kind: 'p3a_parent_ref',
      }),
      sourceFactIds: [factId],
      evidenceIds: [evidenceId],
      confidence: 1,
      parentIdentity: {
        lineKind: 'PROCUREMENT_BLIN',
        code: parentRef.identity.code,
        account: parentRef.identity.account,
        component: parentRef.identity.component,
        advanceProcurement: parentRef.identity.advanceProcurement,
      },
      description: '(P-3A parent reference)',
      fiscalYear: input.cycleFiscalYear,
      metadata: {
        exhibit: 'P-3A',
        parentSource: parentRef.source,
        physicalPage: parentRef.page,
      },
    });

    /* Relationship assertion: P-3A is a detail_of the parent BLIN. */
    const relEvidenceId = evidenceIdV1({
      code: parentRef.printedCode,
      page: parentRef.page,
      kind: 'p3a_parent_rel',
    });
    builder.addEvidence({
      evidenceId: relEvidenceId,
      sourcePdfSha256: source.sourcePdfSha256,
      parserRunId: defaultParserRunId,
      granularity: 'page_only',
      page: parentRef.page,
    });
    const relFactId = factIdV1({
      code: parentRef.printedCode,
      page: parentRef.page,
      kind: 'p3a_parent_rel_fact',
    });
    builder.addSourceFact({
      factId: relFactId,
      sourcePath: `page:${parentRef.page}/parent_rel`,
      category: 'relationship',
      requiredForCompleteness: false,
      rawValue: parentRef.printedCode,
      evidenceIds: [relEvidenceId],
    });
    builder.addAssertion({
      assertionKind: 'relationship',
      assertionId: assertionIdV1({
        code: parentRef.printedCode,
        page: parentRef.page,
        kind: 'p3a_parent_rel',
      }),
      sourceFactIds: [relFactId],
      evidenceIds: [relEvidenceId],
      confidence: 1,
      from: {
        lineKind: 'PROCUREMENT_BLIN',
        code: parentRef.identity.code,
        account: parentRef.identity.account,
        component: parentRef.identity.component,
        advanceProcurement: parentRef.identity.advanceProcurement,
      },
      to: {
        lineKind: 'PROCUREMENT_BLIN',
        code: parentRef.identity.code,
        account: parentRef.identity.account,
        component: parentRef.identity.component,
        advanceProcurement: parentRef.identity.advanceProcurement,
      },
      relationshipType: 'other',
      explicitInSource: true,
    });
  }

  /* Funding values */
  for (const value of extraction.funding) {
    const evidenceId = evidenceIdV1({
      key: value.identityNaturalKey,
      row: value.rowLabel,
      fy: value.fiscalYear ?? null,
      col: value.columnIndex,
      kind: 'p3a_funding',
    });
    builder.addEvidence({
      evidenceId,
      sourcePdfSha256: source.sourcePdfSha256,
      parserRunId: defaultParserRunId,
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
      kind: 'p3a_funding_fact',
    });
    builder.addSourceFact({
      factId,
      sourcePath: `blin:${value.identityNaturalKey}/row:${value.rowLabel}/fy:${value.fiscalYear ?? 'none'}/col:${value.columnIndex}`,
      category: 'money',
      requiredForCompleteness: true,
      rawValue: value.originalValue,
      evidenceIds: [evidenceId],
    });

    builder.addAssertion({
      assertionKind: 'funding',
      assertionId: assertionIdV1({
        key: value.identityNaturalKey,
        row: value.rowLabel,
        fy: value.fiscalYear ?? null,
        kind: 'p3a_funding',
      }),
      sourceFactIds: [factId],
      evidenceIds: [evidenceId],
      confidence: 1,
      identity: {
        lineKind: 'PROCUREMENT_BLIN',
        code: parentCode,
        account: parentAccount,
        component: source.component,
      },
      fiscalYear: value.fiscalYear ?? input.cycleFiscalYear,
      field: 'request',
      money: {
        originalValue: value.originalValue,
        originalUnit: value.originalUnit,
        valueMillions: value.valueMillions,
      },
      metadata: {
        exhibit: 'P-3A',
        rowLabel: value.rowLabel,
        baseOcoStatus: value.columnBinding.baseOcoStatus,
        fundingStage: value.columnBinding.fundingStage,
        page: value.page,
      },
    });
  }

  /* Modification entries → narrative assertions */
  for (const mod of extraction.modifications) {
    const evidenceId = evidenceIdV1({
      key: mod.identityNaturalKey,
      label: mod.label,
      row: mod.rowIndex,
      kind: 'p3a_modification',
    });
    builder.addEvidence({
      evidenceId,
      sourcePdfSha256: source.sourcePdfSha256,
      parserRunId: defaultParserRunId,
      granularity: 'page_only',
      page: mod.page,
      rowLabel: mod.label,
    });

    const factId = factIdV1({
      key: mod.identityNaturalKey,
      label: mod.label,
      row: mod.rowIndex,
      kind: 'p3a_modification_fact',
    });
    builder.addSourceFact({
      factId,
      sourcePath: `page:${mod.page}/row:${mod.rowIndex}/label:${mod.label}`,
      category: 'text',
      requiredForCompleteness: true,
      rawValue: mod.description,
      evidenceIds: [evidenceId],
    });

    builder.addAssertion({
      assertionKind: 'narrative',
      assertionId: assertionIdV1({
        key: mod.identityNaturalKey,
        label: mod.label,
        row: mod.rowIndex,
        kind: 'p3a_modification',
      }),
      sourceFactIds: [factId],
      evidenceIds: [evidenceId],
      confidence: 1,
      identity: {
        lineKind: 'PROCUREMENT_BLIN',
        code: parentCode,
        account: parentAccount,
        component: source.component,
      },
      narrativeType: 'description',
      text: mod.description,
      metadata: {
        exhibit: 'P-3A',
        modification: true,
        label: mod.label,
        page: mod.page,
      },
    });
  }

  /* Narrative sections */
  for (const narrative of extraction.narratives) {
    const evidenceId = evidenceIdV1({
      key: narrative.identityNaturalKey,
      section: narrative.sectionType,
      page: narrative.page,
      kind: 'p3a_narrative',
    });
    builder.addEvidence({
      evidenceId,
      sourcePdfSha256: source.sourcePdfSha256,
      parserRunId: defaultParserRunId,
      granularity: 'page_only',
      page: narrative.page,
    });

    const factId = factIdV1({
      key: narrative.identityNaturalKey,
      section: narrative.sectionType,
      kind: 'p3a_narrative_fact',
    });
    builder.addSourceFact({
      factId,
      sourcePath: `page:${narrative.page}/narrative:${narrative.sectionType}`,
      category: 'text',
      requiredForCompleteness: false,
      rawValue: narrative.text,
      evidenceIds: [evidenceId],
    });

    const narrativeType = mapNarrativeType(narrative.sectionType);

    builder.addAssertion({
      assertionKind: 'narrative',
      assertionId: assertionIdV1({
        key: narrative.identityNaturalKey,
        section: narrative.sectionType,
        kind: 'p3a_narrative',
      }),
      sourceFactIds: [factId],
      evidenceIds: [evidenceId],
      confidence: 1,
      identity: {
        lineKind: 'PROCUREMENT_BLIN',
        code: parentCode,
        account: parentAccount,
        component: source.component,
      },
      narrativeType,
      text: narrative.text,
      metadata: {
        exhibit: 'P-3A',
        sectionType: narrative.sectionType,
        page: narrative.page,
      },
    });
  }

  /* Omissions */
  for (const omission of extraction.omissions) {
    const factId = factIdV1({
      page: omission.page,
      row: omission.rowIndex ?? null,
      col: omission.columnIndex ?? null,
      kind: 'p3a_omission',
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
      reason: mapOmissionReason(omission.reason),
      severity:
        omission.reason.includes('parent') || omission.reason.includes('layout')
          ? 'blocking'
          : omission.reason.includes('ambiguous')
            ? 'review'
            : 'blocking',
      message: `P-3A page ${omission.page}: ${omission.reason}`,
    });
  }

  /* Warnings for duplicate modification labels */
  for (const conflict of extraction.conflicts) {
    builder.addWarning({
      warningId: warningIdV1({
        code: 'duplicate_modification_label',
        message: conflict.reason,
        sourceFactIds: [],
        evidenceIds: [],
      }),
      code: 'duplicate_modification_label',
      severity: 'review',
      message: `P-3A duplicate modification label "${conflict.label}" on pages ${conflict.pages.join(', ')}`,
      sourceFactIds: [],
      evidenceIds: [],
    });
  }

  return builder.finalize();
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function mapNarrativeType(
  sectionType: string,
):
  | 'mission'
  | 'description'
  | 'accomplishments'
  | 'plans'
  | 'rationale'
  | 'schedule_notes'
  | 'other' {
  switch (sectionType) {
    case 'program_status':
      return 'accomplishments';
    case 'acquisition_status':
      return 'description';
    case 'rationale':
      return 'rationale';
    case 'modification_description':
      return 'description';
    default:
      return 'other';
  }
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
  if (reason.includes('parent')) return 'invalid_identity';
  if (reason.includes('layout')) return 'ambiguous_layout';
  if (reason.includes('unit')) return 'unsupported_unit';
  if (reason.includes('ambiguous')) return 'ambiguous_layout';
  if (reason.includes('identity')) return 'invalid_identity';
  return 'missing_value';
}