/**
 * Workstream F — adapter for the legacy R-1 artifact consumed by
 * apps/api/scripts/sync-comptroller-jbooks.ts.
 *
 * The adapter proves completeness relative to the legacy JSON artifact, NOT
 * relative to the original PDF. Known legacy gaps (missing fyColumns, unparsed
 * pages, artifact-level errors) become explicit warnings/omissions.
 */
import { z } from 'zod';
import { isValidPeCode } from '../../extractors/types.js';
import { ArtifactBuilderV1, assertionIdV1 } from '../artifact-builders.js';
import type { DefenseBudgetExtractionArtifactV1, MoneyValueV1 } from '../extraction-artifact-v1.js';
import { moneyToMillionsString, parseCanonicalDecimalString } from '../decimal-string.js';
import {
  parserRunFromContext,
  sourceFromContext,
  type ExtractionAdapterContextV1,
} from './adapter-context.js';
import {
  buildOmission,
  buildSourceFact,
  buildTruthfulEvidence,
  buildWarning,
} from './adapter-helpers.js';

/* Adapter-local strict input schema (no imports from the loader script). */
export const r1RowV1Schema = z
  .object({
    peCode: z.string(),
    title: z.string(),
    budgetActivity: z.string().nullable(),
    lineNumber: z.string().nullable(),
    page: z.number().int().positive(),
    fyColumns: z.record(z.number().nullable()).nullable().optional(),
  })
  .strict();

export const r1ToplineV1Schema = z
  .object({
    scope: z.string().optional(),
    amountMillions: z.number().optional(),
    units: z.string().optional(),
    stage: z.string().optional(),
    vehicleClass: z.string().optional(),
    sourcePage: z.number().nullable().optional(),
    excerpt: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    effectiveDate: z.string().nullable().optional(),
    vehicleLabel: z.string().nullable().optional(),
    billId: z.string().nullable().optional(),
  })
  .strict();

export const r1ArtifactV1InputSchema = z
  .object({
    docType: z.string(),
    pageCount: z.number().int().positive(),
    rows: z.array(r1RowV1Schema),
    unparsed_pages: z.array(z.number().int().positive()),
    stats: z.object({ rows: z.number(), pages_with_rows: z.number() }).strict().passthrough(),
    error: z.string().optional(),
    toplines: z.array(r1ToplineV1Schema).optional(),
  })
  .strict();

export type R1ArtifactV1Input = z.infer<typeof r1ArtifactV1InputSchema>;

/**
 * Convert a legacy R-1 artifact. `unit` declares the printed unit of fyColumns
 * values; it must come from the artifact contract/config, never from magnitude.
 */
export function adaptR1ArtifactToArtifactV1(
  input: R1ArtifactV1Input,
  context: ExtractionAdapterContextV1,
  options: { fundingUnit: 'dollars' | 'thousands' | 'millions' },
): DefenseBudgetExtractionArtifactV1 {
  const artifact = r1ArtifactV1InputSchema.parse(input);
  const builder = new ArtifactBuilderV1(sourceFromContext(context));
  const parserRun = parserRunFromContext(context);
  builder.addParserRun(parserRun);

  const docEvidence = buildTruthfulEvidence(context, {
    parserRunId: parserRun.parserRunId,
    discriminator: 'document',
  });
  builder.addEvidence(docEvidence);

  /* ---------------- rows ---------------- */
  artifact.rows.forEach((row, rowIndex) => {
    const rowPath = `rows[${rowIndex}]`;
    const rowEvidence = buildTruthfulEvidence(context, {
      parserRunId: parserRun.parserRunId,
      page: row.page,
      rowLabel: row.title,
      discriminator: rowPath,
    });
    builder.addEvidence(rowEvidence);

    const identityFact = buildSourceFact({
      sourcePath: `${rowPath}.identity`,
      category: 'identity',
      requiredForCompleteness: true,
      rawValue: {
        peCode: row.peCode,
        title: row.title,
        budgetActivity: row.budgetActivity,
        lineNumber: row.lineNumber,
      },
      evidenceIds: [rowEvidence.evidenceId],
    });
    builder.addSourceFact(identityFact);

    if (!isValidPeCode(row.peCode)) {
      builder.addOmission(
        buildOmission({
          sourceFactId: identityFact.factId,
          reason: 'invalid_identity',
          severity: 'blocking',
          message: `invalid R-1 PE code: ${row.peCode}`,
        }),
      );
    } else {
      builder.addAssertion({
        assertionId: assertionIdV1({ sourcePath: `${rowPath}.identity` }),
        assertionKind: 'program_element_identity',
        identity: { lineKind: 'RDTE_PE', peCode: row.peCode },
        title: row.title,
        component: context.component,
        ...(row.budgetActivity != null ? { budgetActivity: row.budgetActivity } : {}),
        ...(row.lineNumber != null ? { lineNumber: row.lineNumber } : {}),
        sourceFactIds: [identityFact.factId],
        evidenceIds: [rowEvidence.evidenceId],
        confidence: 1,
      });
    }

    // Every fyColumns entry with a non-null value becomes an independent
    // funding fact/assertion. Duplicate rows stay separate — no last-win.
    for (const [fyKey, rawValue] of Object.entries(row.fyColumns ?? {})) {
      if (rawValue == null) continue;
      const fy = Number.parseInt(fyKey, 10);
      const fyPath = `${rowPath}.fyColumns[${JSON.stringify(fyKey)}]`;
      const moneyFact = buildSourceFact({
        sourcePath: fyPath,
        category: 'money',
        requiredForCompleteness: true,
        rawValue: { fy: fyKey, value: rawValue, unit: options.fundingUnit },
        evidenceIds: [rowEvidence.evidenceId],
      });
      builder.addSourceFact(moneyFact);

      if (!Number.isInteger(fy) || fy < 1900 || fy > 2200) {
        builder.addOmission(
          buildOmission({
            sourceFactId: moneyFact.factId,
            reason: 'invalid_number',
            severity: 'blocking',
            message: `fyColumns key ${fyKey} is not a valid fiscal year`,
          }),
        );
        continue;
      }
      if (!isValidPeCode(row.peCode)) {
        builder.addOmission(
          buildOmission({
            sourceFactId: moneyFact.factId,
            reason: 'invalid_identity',
            severity: 'blocking',
            message: `fyColumns value sits under invalid PE code ${row.peCode}`,
          }),
        );
        continue;
      }
      let money: MoneyValueV1;
      try {
        const originalValue = parseCanonicalDecimalString(rawValue);
        money = {
          originalValue,
          originalUnit: options.fundingUnit,
          valueMillions: moneyToMillionsString(originalValue, options.fundingUnit),
        };
      } catch (cause) {
        builder.addOmission(
          buildOmission({
            sourceFactId: moneyFact.factId,
            reason: 'invalid_number',
            severity: 'blocking',
            message: `fyColumns value ${rawValue} is not a finite decimal: ${(cause as Error).message}`,
          }),
        );
        continue;
      }
      builder.addAssertion({
        assertionId: assertionIdV1({ sourcePath: fyPath, kind: 'funding' }),
        assertionKind: 'funding',
        identity: { lineKind: 'RDTE_PE', peCode: row.peCode },
        fiscalYear: fy,
        field: 'request',
        money,
        sourceFactIds: [moneyFact.factId],
        evidenceIds: [rowEvidence.evidenceId],
        confidence: 1,
        metadata: { fyColumnKey: fyKey },
      });
    }
  });

  /* ---------------- legacy gaps ---------------- */
  const hasAnyFyColumns = artifact.rows.some(
    (row) => row.fyColumns != null && Object.keys(row.fyColumns).length > 0,
  );
  if (!hasAnyFyColumns) {
    builder.addWarning(
      buildWarning({
        code: 'legacy_r1_artifact_missing_funding_columns',
        severity: 'review',
        message:
          'legacy R-1 artifact carries no fyColumns; R-1 funding completeness cannot be proven from this artifact',
        evidenceIds: [docEvidence.evidenceId],
      }),
    );
    const gapFact = buildSourceFact({
      sourcePath: 'fyColumns',
      category: 'money',
      requiredForCompleteness: true,
      rawValue: null,
      evidenceIds: [docEvidence.evidenceId],
    });
    builder.addSourceFact(gapFact);
    builder.addOmission(
      buildOmission({
        sourceFactId: gapFact.factId,
        reason: 'legacy_artifact_missing_detail',
        severity: 'review',
        message:
          'current legacy R-1 artifact cannot represent R-1 funding completeness (no fyColumns present)',
      }),
    );
  }

  for (const page of artifact.unparsed_pages) {
    const pageEvidence = buildTruthfulEvidence(context, {
      parserRunId: parserRun.parserRunId,
      page,
      discriminator: `unparsed_pages[${page}]`,
    });
    builder.addEvidence(pageEvidence);
    builder.addWarning(
      buildWarning({
        code: 'legacy_r1_unparsed_page',
        severity: 'review',
        message: `legacy R-1 extractor flagged page ${page} as unparsed`,
        evidenceIds: [pageEvidence.evidenceId],
        discriminator: `unparsed_pages[${page}]`,
      }),
    );
  }

  if (artifact.error != null) {
    builder.addWarning(
      buildWarning({
        code: 'legacy_r1_artifact_error',
        severity: 'blocking',
        message: `legacy R-1 artifact carries an error: ${artifact.error}`,
        evidenceIds: [docEvidence.evidenceId],
      }),
    );
    // Create a source fact at path 'error' so the error is explicitly
    // accounted for in the artifact's fact inventory.
    const errorFact = buildSourceFact({
      sourcePath: 'error',
      category: 'metadata',
      requiredForCompleteness: true,
      rawValue: artifact.error,
      evidenceIds: [docEvidence.evidenceId],
    });
    builder.addSourceFact(errorFact);
    // Add a blocking omission: the error fact carries no extractable detail
    // beyond the raw error string, so it cannot be asserted.
    builder.addOmission(
      buildOmission({
        sourceFactId: errorFact.factId,
        reason: 'legacy_artifact_missing_detail',
        severity: 'blocking',
        message: `artifact-level error: ${artifact.error}`,
      }),
    );
  }

  // Toplines are document facts only — never PE funding assertions in Phase 1.
  (artifact.toplines ?? []).forEach((topline, index) => {
    const toplinePath = `toplines[${index}]`;
    const toplineEvidence = buildTruthfulEvidence(context, {
      parserRunId: parserRun.parserRunId,
      page: topline.sourcePage ?? undefined,
      excerpt: topline.excerpt ?? undefined,
      discriminator: toplinePath,
    });
    builder.addEvidence(toplineEvidence);
    const toplineFact = buildSourceFact({
      sourcePath: toplinePath,
      category: 'metadata',
      requiredForCompleteness: true,
      rawValue: topline,
      evidenceIds: [toplineEvidence.evidenceId],
    });
    builder.addSourceFact(toplineFact);
    builder.addAssertion({
      assertionId: assertionIdV1({ sourcePath: toplinePath, kind: 'document_fact' }),
      assertionKind: 'document_fact',
      fieldName: 'r1_topline',
      value: topline,
      sourceFactIds: [toplineFact.factId],
      evidenceIds: [toplineEvidence.evidenceId],
      confidence: 1,
    });
  });

  return builder.finalize();
}
