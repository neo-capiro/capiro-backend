/**
 * p40-artifact-builder-v1 — build a defense_budget_extraction_v1 artifact
 * from P-40 extraction output.
 *
 * Pure module. Uses the Phase 1 ArtifactBuilderV1; no database, no parser,
 * no writer. No canonical writes. No ProgramElementWriterService.
 *
 * Identity rules:
 *   - P-40 line codes are PROCUREMENT_BLIN, NEVER RDTE_PE.
 *   - PE references in narrative are relationship assertions, not identity.
 *   - Base/AP identities are distinct.
 *   - Title is never a natural key.
 *   - Quantity and money remain distinct.
 *   - No magnitude-based unit inference.
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
import type { P40ExtractionResult } from './p40-extractor-v1.js';

export function buildP40Artifact(input: {
  source: ExtractionSourceV1;
  parserRuns: readonly ParserRunV1[];
  extraction: P40ExtractionResult;
  cycleFiscalYear: number;
}): DefenseBudgetExtractionArtifactV1 {
  const { source, parserRuns, extraction } = input;
  const builder = new ArtifactBuilderV1(source);

  const syntheticParserRun: Omit<ParserRunV1, 'pageRanges'> = {
    parserRunId: parserRunIdV1({ source: source.sourcePdfSha256 }),
    method: 'manual' as const,
    parserVersion: 'p40-extractor-v1',
    parserConfigSha256: source.sourcePdfSha256,
    inputSourceSha256: source.sourcePdfSha256,
    outputArtifactSha256: source.sourcePdfSha256,
  };

  for (const run of parserRuns) {
    builder.addParserRun(run);
  }
  const defaultParserRunId = parserRuns[0]?.parserRunId ?? syntheticParserRun.parserRunId;

  const parentId = extraction.parentIdentity;
  const parentCode = parentId?.identity.code ?? 'UNKNOWN';
  const parentAccount = parentId?.identity.account ?? 'UNKNOWN';

  /* Parent identity — PROCUREMENT_BLIN */
  if (parentId != null) {
    const evidenceId = evidenceIdV1({
      code: parentId.printedCode,
      page: parentId.page,
      kind: 'p40_identity',
    });
    builder.addEvidence({
      evidenceId,
      sourcePdfSha256: source.sourcePdfSha256,
      parserRunId: defaultParserRunId,
      granularity: 'page_only',
      page: parentId.page,
      ...(parentId.printedPage != null ? { printedPage: parentId.printedPage } : {}),
    });
    const factId = factIdV1({
      code: parentId.printedCode,
      page: parentId.page,
      kind: 'p40_identity_fact',
    });
    builder.addSourceFact({
      factId,
      sourcePath: `page:${parentId.page}/identity`,
      category: 'identity',
      requiredForCompleteness: true,
      rawValue: {
        printedCode: parentId.printedCode,
        title: parentId.title,
        advanceProcurement: parentId.advanceProcurement,
        referencedPeCodes: parentId.referencedPeCodes,
      },
      evidenceIds: [evidenceId],
    });
    builder.addAssertion({
      assertionKind: 'procurement_line',
      assertionId: assertionIdV1({
        code: parentId.printedCode,
        page: parentId.page,
        kind: 'p40_identity',
      }),
      sourceFactIds: [factId],
      evidenceIds: [evidenceId],
      confidence: 1,
      parentIdentity: {
        lineKind: 'PROCUREMENT_BLIN',
        code: parentId.identity.code,
        account: parentId.identity.account,
        component: parentId.identity.component,
        advanceProcurement: parentId.advanceProcurement,
      },
      description: parentId.title,
      fiscalYear: input.cycleFiscalYear,
      metadata: {
        exhibit: 'P-40',
        physicalPage: parentId.page,
        ...(parentId.printedPage != null ? { printedPage: parentId.printedPage } : {}),
        ...(parentId.budgetActivity != null ? { budgetActivity: parentId.budgetActivity } : {}),
        ...(parentId.budgetSubActivity != null
          ? { budgetSubActivity: parentId.budgetSubActivity }
          : {}),
        advanceProcurement: parentId.advanceProcurement,
      },
    });

    /* PE references → relationship assertions */
    for (const peRef of parentId.referencedPeCodes) {
      const relEvidenceId = evidenceIdV1({
        code: parentId.printedCode,
        peRef,
        page: parentId.page,
        kind: 'p40_pe_ref',
      });
      builder.addEvidence({
        evidenceId: relEvidenceId,
        sourcePdfSha256: source.sourcePdfSha256,
        parserRunId: defaultParserRunId,
        granularity: 'page_only',
        page: parentId.page,
      });
      const relFactId = factIdV1({ code: parentId.printedCode, peRef, kind: 'p40_pe_ref_fact' });
      builder.addSourceFact({
        factId: relFactId,
        sourcePath: `page:${parentId.page}/pe_ref:${peRef}`,
        category: 'relationship',
        requiredForCompleteness: false,
        rawValue: peRef,
        evidenceIds: [relEvidenceId],
      });
      builder.addAssertion({
        assertionKind: 'relationship',
        assertionId: assertionIdV1({ code: parentId.printedCode, peRef, kind: 'p40_pe_ref' }),
        sourceFactIds: [relFactId],
        evidenceIds: [relEvidenceId],
        confidence: 1,
        from: {
          lineKind: 'PROCUREMENT_BLIN',
          code: parentId.identity.code,
          account: parentId.identity.account,
          component: parentId.identity.component,
          advanceProcurement: parentId.advanceProcurement,
        },
        to: { lineKind: 'RDTE_PE' as const, peCode: peRef },
        relationshipType: 'references' as const,
        explicitInSource: true,
      });
    }
  }

  /* Resource summary values */
  for (const value of extraction.resourceSummary) {
    const evidenceId = evidenceIdV1({
      key: value.identityNaturalKey,
      row: value.rowLabel,
      fy: value.fiscalYear ?? null,
      col: value.columnIndex,
      kind: 'p40_resource',
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
      kind: 'p40_resource_fact',
    });
    builder.addSourceFact({
      factId,
      sourcePath: `blin:${value.identityNaturalKey}/row:${value.rowLabel}/fy:${value.fiscalYear ?? 'none'}/col:${value.columnIndex}`,
      category: 'money',
      requiredForCompleteness: true,
      rawValue: value.originalValue,
      evidenceIds: [evidenceId],
    });

    const isUnitCost = /gross|unit\s*cost/i.test(value.rowLabel);
    const isQuantity = /quantity|qty/i.test(value.rowLabel);

    if (isUnitCost) {
      builder.addAssertion({
        assertionKind: 'unit_cost',
        assertionId: assertionIdV1({
          key: value.identityNaturalKey,
          row: value.rowLabel,
          fy: value.fiscalYear ?? null,
          kind: 'p40_unit_cost',
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
        unitCostDollars: value.originalValue,
        metadata: {
          exhibit: 'P-40',
          rowLabel: value.rowLabel,
          originalUnit: value.originalUnit,
          page: value.page,
        },
      });
    } else if (isQuantity) {
      builder.addAssertion({
        assertionKind: 'quantity',
        assertionId: assertionIdV1({
          key: value.identityNaturalKey,
          row: value.rowLabel,
          fy: value.fiscalYear ?? null,
          kind: 'p40_quantity',
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
        quantity: value.originalValue,
        metadata: { exhibit: 'P-40', rowLabel: value.rowLabel, page: value.page },
      });
    } else {
      builder.addAssertion({
        assertionKind: 'funding',
        assertionId: assertionIdV1({
          key: value.identityNaturalKey,
          row: value.rowLabel,
          fy: value.fiscalYear ?? null,
          kind: 'p40_funding',
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
        field: 'request' as const,
        money: {
          originalValue: value.originalValue,
          originalUnit: value.originalUnit,
          valueMillions: value.valueMillions,
        },
        metadata: {
          exhibit: 'P-40',
          rowLabel: value.rowLabel,
          baseOcoStatus: value.columnBinding.baseOcoStatus,
          fundingStage: value.columnBinding.fundingStage,
          page: value.page,
        },
      });
    }
  }

  /* Narrative sections */
  for (const narrative of extraction.narratives) {
    const evidenceId = evidenceIdV1({
      key: narrative.identityNaturalKey,
      section: narrative.sectionType,
      page: narrative.page,
      kind: 'p40_narrative',
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
      kind: 'p40_narrative_fact',
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
        kind: 'p40_narrative',
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
      narrativeType: 'description' as const,
      text: narrative.text,
      metadata: { exhibit: 'P-40', sectionType: narrative.sectionType, page: narrative.page },
    });
  }

  /* Secondary distribution lines */
  for (const dist of extraction.secondaryDistribution) {
    const evidenceId = evidenceIdV1({
      key: dist.identityNaturalKey,
      recipient: dist.recipient,
      row: dist.rowIndex,
      kind: 'p40_secondary_dist',
    });
    builder.addEvidence({
      evidenceId,
      sourcePdfSha256: source.sourcePdfSha256,
      parserRunId: defaultParserRunId,
      granularity: 'page_only',
      page: dist.page,
      rowLabel: dist.recipient,
    });
    const factId = factIdV1({
      key: dist.identityNaturalKey,
      recipient: dist.recipient,
      row: dist.rowIndex,
      kind: 'p40_secondary_dist_fact',
    });
    builder.addSourceFact({
      factId,
      sourcePath: `page:${dist.page}/row:${dist.rowIndex}/recipient:${dist.recipient}`,
      category: 'money',
      requiredForCompleteness: false,
      rawValue: {
        recipient: dist.recipient,
        ...(dist.description != null ? { description: dist.description } : {}),
        ...(dist.fiscalYear != null ? { fiscalYear: dist.fiscalYear } : {}),
        ...(dist.quantity != null ? { quantity: dist.quantity } : {}),
        ...(dist.funding != null ? { funding: dist.funding } : {}),
        ...(dist.fundingUnit != null ? { fundingUnit: dist.fundingUnit } : {}),
      },
      evidenceIds: [evidenceId],
    });
    builder.addAssertion({
      assertionKind: 'procurement_line',
      assertionId: assertionIdV1({
        key: dist.identityNaturalKey,
        recipient: dist.recipient,
        row: dist.rowIndex,
        kind: 'p40_secondary_dist',
      }),
      sourceFactIds: [factId],
      evidenceIds: [evidenceId],
      confidence: 1,
      parentIdentity: {
        lineKind: 'PROCUREMENT_BLIN',
        code: parentCode,
        account: parentAccount,
        component: source.component,
      },
      description: dist.recipient,
      fiscalYear: dist.fiscalYear ?? input.cycleFiscalYear,
      ...(dist.quantity != null ? { quantity: dist.quantity } : {}),
      ...(dist.funding != null
        ? {
            dollars: {
              originalValue: dist.funding,
              originalUnit: dist.fundingUnit ?? 'dollars',
              valueMillions: dist.funding,
            },
          }
        : {}),
      metadata: {
        exhibit: 'P-40',
        secondaryDistribution: true,
        page: dist.page,
        rowIndex: dist.rowIndex,
      },
    });
  }

  /* Omissions */
  for (const omission of extraction.omissions) {
    const factId = factIdV1({
      page: omission.page,
      row: omission.rowIndex ?? null,
      col: omission.columnIndex ?? null,
      kind: 'p40_omission',
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
        ? ('unsupported_unit' as const)
        : omission.reason.includes('ambiguous')
          ? ('ambiguous_layout' as const)
          : ('missing_value' as const),
      severity: omission.reason.includes('ambiguous') ? ('review' as const) : ('blocking' as const),
      message: `P-40 page ${omission.page}: ${omission.reason}`,
    });
  }

  /* Warning when arithmetic check fails */
  if (
    extraction.arithmeticCheckApplicable &&
    extraction.arithmeticCheckResult != null &&
    !extraction.arithmeticCheckResult.passed
  ) {
    builder.addWarning({
      warningId: warningIdV1({
        code: 'arithmetic_mismatch',
        message: 'quantity * unit_cost != net procurement',
        sourceFactIds: [],
        evidenceIds: [],
      }),
      code: 'arithmetic_mismatch',
      severity: 'review' as const,
      message: `P-40 arithmetic check failed: expected ${extraction.arithmeticCheckResult.expected}, got ${extraction.arithmeticCheckResult.actual}`,
      sourceFactIds: [],
      evidenceIds: [],
    });
  }

  if (parserRuns.length === 0) {
    builder.addParserRunCoveringAddedEvidence(syntheticParserRun);
  }

  return builder.finalize();
}
