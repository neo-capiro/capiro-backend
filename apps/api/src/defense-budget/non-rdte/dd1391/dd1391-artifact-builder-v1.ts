/**
 * dd1391-artifact-builder-v1 — build a defense_budget_extraction_v1 artifact
 * from DD1391 extraction output.
 *
 * Pure module. Uses the Phase 1 ArtifactBuilderV1; no database, no parser,
 * no writer. No canonical writes. No ProgramElementWriterService.
 *
 * Identity rules:
 *   - DD1391 project numbers are MILCON_PROJECT, NEVER RDTE_PE or PROCUREMENT_BLIN.
 *   - Same project number at different installations/components remains distinct.
 *   - Project title is never a natural key.
 *   - Cost categories remain separate facts — never combined unless the source
 *     explicitly supplies a total.
 *   - All numeric values use exact decimal strings.
 *   - OCR-derived money requires corroboration/review per Phase 2 policy.
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
import type {
  Dd1391ExtractionResult,
  Dd1391ProjectIdentity,
  Dd1391CostValue,
} from './dd1391-extractor-v1.js';

export function buildDd1391Artifact(input: {
  source: ExtractionSourceV1;
  parserRuns: readonly ParserRunV1[];
  extraction: Dd1391ExtractionResult;
  cycleFiscalYear: number;
}): DefenseBudgetExtractionArtifactV1 {
  const { source, parserRuns, extraction } = input;
  const builder = new ArtifactBuilderV1(source);

  /* Register parser runs */
  const effectiveParserRuns: ParserRunV1[] =
    parserRuns.length > 0
      ? [...parserRuns]
      : [
          {
            parserRunId: parserRunIdV1({ source: source.sourcePdfSha256 }),
            method: 'manual',
            parserVersion: 'dd1391-extractor-v1',
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

  /* Identities — MILCON_PROJECT */
  for (const identity of extraction.identities) {
    addIdentityAssertion(builder, identity, source, defaultParserRunId);
  }

  const identityByKey = new Map(
    extraction.identities.map((id: Dd1391ProjectIdentity) => [
      id.identity.naturalKey,
      id,
    ]),
  );

  /* Cost values → document_fact assertions (each cost category is separate) */
  for (const cost of extraction.costs) {
    addCostAssertion(builder, cost, source, defaultParserRunId);
  }

  /* Funding values → funding assertions */
  for (const value of extraction.funding) {
    const matchedIdentity = identityByKey.get(value.identityNaturalKey);
    addFundingAssertion(
      builder,
      value,
      matchedIdentity,
      source,
      defaultParserRunId,
    );
  }

  /* Narrative sections → narrative assertions */
  for (const narrative of extraction.narratives) {
    addNarrativeAssertion(
      builder,
      narrative,
      identityByKey,
      source,
      defaultParserRunId,
    );
  }

  /* Schedule dates → document_fact assertions */
  for (const schedule of extraction.schedules) {
    addScheduleAssertion(builder, schedule, source, defaultParserRunId);
  }

  /* Omissions */
  for (const omission of extraction.omissions) {
    const factId = factIdV1({
      page: omission.page,
      kind: 'dd1391_omission',
    });
    builder.addSourceFact({
      factId,
      sourcePath: `page:${omission.page}`,
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
      reason: omission.reason.includes('identity')
        ? 'invalid_identity'
        : 'missing_value',
      severity: omission.severity,
      message: `DD1391 page ${omission.page}: ${omission.reason}`,
    });
  }

  /* Warning when total arithmetic check fails */
  if (
    extraction.totalArithmetic.applicable &&
    extraction.totalArithmetic.passed != null &&
    !extraction.totalArithmetic.passed
  ) {
    builder.addWarning({
      warningId: warningIdV1({
        code: 'dd1391_total_arithmetic_mismatch',
        message: 'cost category sum != total_request',
        sourceFactIds: [],
        evidenceIds: [],
      }),
      code: 'dd1391_total_arithmetic_mismatch',
      severity: 'review',
      message: `DD1391 total arithmetic check failed: expected ${extraction.totalArithmetic.expected ?? '?'}, got ${extraction.totalArithmetic.actual ?? '?'}`,
      sourceFactIds: [],
      evidenceIds: [],
    });
  }

  /* Warning when OCR confidence is below threshold */
  for (const ocr of extraction.ocrConfidence) {
    if (ocr.requiresReview) {
      builder.addWarning({
        warningId: warningIdV1({
          code: 'dd1391_ocr_low_confidence',
          message: `OCR confidence below threshold for ${ocr.identityNaturalKey}`,
          sourceFactIds: [],
          evidenceIds: [],
        }),
        code: 'dd1391_ocr_low_confidence',
        severity: 'review',
        message: `DD1391 OCR confidence ${ocr.minValueConfidence ?? '?'} below policy threshold for ${ocr.identityNaturalKey} — requires corroboration`,
        sourceFactIds: [],
        evidenceIds: [],
      });
    }
  }

  return builder.finalize();
}

/* ------------------------------------------------------------------ */
/* Assertion builders                                                  */
/* ------------------------------------------------------------------ */

function addIdentityAssertion(
  builder: ArtifactBuilderV1,
  identity: Dd1391ProjectIdentity,
  source: ExtractionSourceV1,
  parserRunId: string,
): void {
  const evidenceId = evidenceIdV1({
    code: identity.printedProjectCode,
    page: identity.page,
    kind: 'dd1391_identity',
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
    code: identity.printedProjectCode,
    page: identity.page,
    kind: 'dd1391_identity_fact',
  });
  builder.addSourceFact({
    factId,
    sourcePath: `page:${identity.page}/identity`,
    category: 'identity',
    requiredForCompleteness: true,
    rawValue: {
      printedProjectCode: identity.printedProjectCode,
      projectTitle: identity.projectTitle,
      ...(identity.installation != null
        ? { installation: identity.installation }
        : {}),
      ...(identity.location != null ? { location: identity.location } : {}),
      ...(identity.categoryCode != null
        ? { categoryCode: identity.categoryCode }
        : {}),
    },
    evidenceIds: [evidenceId],
  });

  builder.addAssertion({
    assertionKind: 'milcon_project',
    assertionId: assertionIdV1({
      code: identity.printedProjectCode,
      page: identity.page,
      kind: 'dd1391_identity',
    }),
    sourceFactIds: [factId],
    evidenceIds: [evidenceId],
    confidence: 1,
    identity: {
      lineKind: 'MILCON_PROJECT',
      projectCode: identity.identity.projectCode,
      component: identity.identity.component,
      ...(identity.identity.location != null
        ? { location: identity.identity.location }
        : {}),
    },
    title: identity.projectTitle,
    ...(identity.location != null ? { location: identity.location } : {}),
    metadata: {
      exhibit: 'DD1391',
      physicalPage: identity.page,
      ...(identity.printedPage != null
        ? { printedPage: identity.printedPage }
        : {}),
      ...(identity.installation != null
        ? { installation: identity.installation }
        : {}),
      ...(identity.categoryCode != null
        ? { categoryCode: identity.categoryCode }
        : {}),
    },
  });
}

function addCostAssertion(
  builder: ArtifactBuilderV1,
  cost: Dd1391CostValue,
  source: ExtractionSourceV1,
  parserRunId: string,
): void {
  const evidenceId = evidenceIdV1({
    key: cost.identityNaturalKey,
    cat: cost.costCategory,
    page: cost.page,
    kind: 'dd1391_cost',
  });
  builder.addEvidence({
    evidenceId,
    sourcePdfSha256: source.sourcePdfSha256,
    parserRunId,
    granularity: 'page_only',
    page: cost.page,
  });

  const factId = factIdV1({
    key: cost.identityNaturalKey,
    cat: cost.costCategory,
    page: cost.page,
    kind: 'dd1391_cost_fact',
  });
  builder.addSourceFact({
    factId,
    sourcePath: `milcon:${cost.identityNaturalKey}/cost:${cost.costCategory}/page:${cost.page}`,
    category: 'money',
    requiredForCompleteness: cost.costCategory === 'total_request' ||
      cost.costCategory === 'total_project_cost',
    rawValue: cost.originalValue,
    evidenceIds: [evidenceId],
  });

  const value: JsonValue = {
    amount: cost.originalValue,
    costCategory: cost.costCategory,
    unit: cost.originalUnit,
    valueMillions: cost.valueMillions,
  };

  builder.addAssertion({
    assertionKind: 'document_fact',
    assertionId: assertionIdV1({
      key: cost.identityNaturalKey,
      cat: cost.costCategory,
      page: cost.page,
      kind: 'dd1391_cost',
    }),
    sourceFactIds: [factId],
    evidenceIds: [evidenceId],
    confidence: 1,
    fieldName: cost.costCategory,
    value,
    metadata: {
      exhibit: 'DD1391',
      costCategory: cost.costCategory,
      page: cost.page,
      identityNaturalKey: cost.identityNaturalKey,
    },
  });
}

function addFundingAssertion(
  builder: ArtifactBuilderV1,
  value: Dd1391ExtractionResult['funding'][number],
  matchedIdentity: Dd1391ProjectIdentity | undefined,
  source: ExtractionSourceV1,
  parserRunId: string,
): void {
  const evidenceId = evidenceIdV1({
    key: value.identityNaturalKey,
    ft: value.fundingType,
    fy: value.fiscalYear,
    page: value.page,
    kind: 'dd1391_funding',
  });
  builder.addEvidence({
    evidenceId,
    sourcePdfSha256: source.sourcePdfSha256,
    parserRunId,
    granularity: 'page_only',
    page: value.page,
  });

  const factId = factIdV1({
    key: value.identityNaturalKey,
    ft: value.fundingType,
    fy: value.fiscalYear,
    page: value.page,
    kind: 'dd1391_funding_fact',
  });
  builder.addSourceFact({
    factId,
    sourcePath: `milcon:${value.identityNaturalKey}/fy:${value.fiscalYear}/${value.fundingType}`,
    category: 'money',
    requiredForCompleteness: true,
    rawValue: value.originalValue,
    evidenceIds: [evidenceId],
  });

  builder.addAssertion({
    assertionKind: 'funding',
    assertionId: assertionIdV1({
      key: value.identityNaturalKey,
      ft: value.fundingType,
      fy: value.fiscalYear,
      page: value.page,
      kind: 'dd1391_funding',
    }),
    sourceFactIds: [factId],
    evidenceIds: [evidenceId],
    confidence: 1,
    identity: {
      lineKind: 'MILCON_PROJECT',
      projectCode: matchedIdentity?.identity.projectCode ?? 'UNKNOWN',
      component: matchedIdentity?.identity.component ?? source.component,
      ...(matchedIdentity?.identity.location != null
        ? { location: matchedIdentity.identity.location }
        : {}),
    },
    fiscalYear: value.fiscalYear,
    field: value.fundingType === 'request' ? 'request' : 'enacted',
    money: {
      originalValue: value.originalValue,
      originalUnit: value.originalUnit,
      valueMillions: value.valueMillions,
    },
    metadata: {
      exhibit: 'DD1391',
      fundingType: value.fundingType,
      page: value.page,
    },
  });
}

function addNarrativeAssertion(
  builder: ArtifactBuilderV1,
  narrative: Dd1391ExtractionResult['narratives'][number],
  identityByKey: Map<string, Dd1391ProjectIdentity>,
  source: ExtractionSourceV1,
  parserRunId: string,
): void {
  const matchedIdentity = identityByKey.get(narrative.identityNaturalKey);
  const evidenceId = evidenceIdV1({
    key: narrative.identityNaturalKey,
    section: narrative.sectionType,
    page: narrative.page,
    kind: 'dd1391_narrative',
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
    kind: 'dd1391_narrative_fact',
  });
  builder.addSourceFact({
    factId,
    sourcePath: `milcon:${narrative.identityNaturalKey}/narrative:${narrative.sectionType}/page:${narrative.page}`,
    category: 'text',
    requiredForCompleteness: false,
    rawValue: narrative.text.slice(0, 500),
    evidenceIds: [evidenceId],
  });

  builder.addAssertion({
    assertionKind: 'narrative',
    assertionId: assertionIdV1({
      key: narrative.identityNaturalKey,
      section: narrative.sectionType,
      page: narrative.page,
      kind: 'dd1391_narrative',
    }),
    sourceFactIds: [factId],
    evidenceIds: [evidenceId],
    confidence: 1,
    identity: {
      lineKind: 'MILCON_PROJECT',
      projectCode: matchedIdentity?.identity.projectCode ?? 'UNKNOWN',
      component: matchedIdentity?.identity.component ?? source.component,
      ...(matchedIdentity?.identity.location != null
        ? { location: matchedIdentity.identity.location }
        : {}),
    },
    narrativeType: narrative.narrativeType,
    text: narrative.text,
    metadata: {
      exhibit: 'DD1391',
      sectionType: narrative.sectionType,
      page: narrative.page,
    },
  });
}

function addScheduleAssertion(
  builder: ArtifactBuilderV1,
  schedule: Dd1391ExtractionResult['schedules'][number],
  source: ExtractionSourceV1,
  parserRunId: string,
): void {
  const evidenceId = evidenceIdV1({
    key: schedule.identityNaturalKey,
    ms: schedule.milestone,
    page: schedule.page,
    kind: 'dd1391_schedule',
  });
  builder.addEvidence({
    evidenceId,
    sourcePdfSha256: source.sourcePdfSha256,
    parserRunId,
    granularity: 'page_only',
    page: schedule.page,
  });

  const factId = factIdV1({
    key: schedule.identityNaturalKey,
    ms: schedule.milestone,
    page: schedule.page,
    kind: 'dd1391_schedule_fact',
  });
  builder.addSourceFact({
    factId,
    sourcePath: `milcon:${schedule.identityNaturalKey}/schedule:${schedule.milestone}/page:${schedule.page}`,
    category: 'milestone',
    requiredForCompleteness: false,
    rawValue: schedule.date,
    evidenceIds: [evidenceId],
  });

  const value: JsonValue = {
    milestone: schedule.milestone,
    date: schedule.date,
  };

  builder.addAssertion({
    assertionKind: 'document_fact',
    assertionId: assertionIdV1({
      key: schedule.identityNaturalKey,
      ms: schedule.milestone,
      page: schedule.page,
      kind: 'dd1391_schedule',
    }),
    sourceFactIds: [factId],
    evidenceIds: [evidenceId],
    confidence: 1,
    fieldName: 'schedule',
    value,
    metadata: {
      exhibit: 'DD1391',
      milestone: schedule.milestone,
      date: schedule.date,
      page: schedule.page,
    },
  });
}
