/**
 * Workstream H — adapter for the legacy R-3 performer artifact consumed by
 * apps/api/scripts/sync-jbook-performers.ts.
 *
 * Truthfulness rules:
 *   - performing activities stay PERFORMING_ACTIVITY unless the artifact
 *     explicitly declares PRIME_CONTRACTOR
 *   - totalCost maps only when the caller declares its unit; when the unit is
 *     unknown the money fact gets a blocking unsupported_unit omission
 *   - named-company classification is preserved as metadata, not inferred
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

export const r3PerformerRowV1Schema = z
  .object({
    peCode: z.string(),
    peName: z.string().nullable(),
    projectCode: z.string().nullable(),
    projectName: z.string().nullable(),
    costCategory: z.string().nullable(),
    performer: z.string(),
    performerNormalized: z.string(),
    location: z.string().nullable(),
    contractMethod: z.string().nullable(),
    totalCost: z.number().nullable(),
    fy: z.number().int(),
    page: z.number().int().positive(),
    performerRole: z.enum(['PERFORMING_ACTIVITY', 'PRIME_CONTRACTOR']).optional(),
  })
  .strict();

export const r3PerformerArtifactV1InputSchema = z
  .object({
    docType: z.string(),
    exhibitType: z.string(),
    fy: z.number().int(),
    sourceUrl: z.string(),
    volumeId: z.string(),
    publisher: z.string(),
    pageCount: z.number().int().positive(),
    performers: z.array(r3PerformerRowV1Schema),
    stats: z.record(z.number()),
    error: z.string().optional(),
  })
  .strict();

export type R3PerformerArtifactV1Input = z.infer<typeof r3PerformerArtifactV1InputSchema>;

export function adaptR3PerformerArtifactToArtifactV1(
  input: R3PerformerArtifactV1Input,
  context: ExtractionAdapterContextV1,
  options: { costUnit?: 'dollars' | 'thousands' | 'millions' } = {},
): DefenseBudgetExtractionArtifactV1 {
  const artifact = r3PerformerArtifactV1InputSchema.parse(input);
  const builder = new ArtifactBuilderV1(sourceFromContext(context));
  const parserRun = parserRunFromContext(context);
  builder.addParserRun(parserRun);

  const docEvidence = buildTruthfulEvidence(context, {
    parserRunId: parserRun.parserRunId,
    discriminator: 'document',
  });
  builder.addEvidence(docEvidence);

  artifact.performers.forEach((row, index) => {
    const rowPath = `performers[${index}]`;
    const rowEvidence = buildTruthfulEvidence(context, {
      parserRunId: parserRun.parserRunId,
      page: row.page,
      rowLabel: row.performer,
      discriminator: rowPath,
    });
    builder.addEvidence(rowEvidence);

    const performerFact = buildSourceFact({
      sourcePath: rowPath,
      category: 'performer',
      requiredForCompleteness: true,
      rawValue: {
        peCode: row.peCode,
        projectCode: row.projectCode,
        performer: row.performer,
        performerNormalized: row.performerNormalized,
        location: row.location,
        contractMethod: row.contractMethod,
        costCategory: row.costCategory,
        fy: row.fy,
      },
      evidenceIds: [rowEvidence.evidenceId],
    });
    builder.addSourceFact(performerFact);

    const peValid = isValidPeCode(row.peCode);
    if (!peValid) {
      builder.addOmission(
        buildOmission({
          sourceFactId: performerFact.factId,
          reason: 'invalid_identity',
          severity: 'blocking',
          message: `performer ${row.performer} has no valid parent PE code (${row.peCode})`,
        }),
      );
    }

    // Money: map only when the caller declares the unit; never guess millions.
    let totalCost: MoneyValueV1 | undefined;
    const costFactIds: string[] = [];
    if (row.totalCost != null) {
      const costFact = buildSourceFact({
        sourcePath: `${rowPath}.totalCost`,
        category: 'money',
        requiredForCompleteness: true,
        rawValue: { totalCost: row.totalCost, unit: options.costUnit ?? null },
        evidenceIds: [rowEvidence.evidenceId],
      });
      builder.addSourceFact(costFact);
      if (options.costUnit == null) {
        builder.addOmission(
          buildOmission({
            sourceFactId: costFact.factId,
            reason: 'unsupported_unit',
            severity: 'blocking',
            message:
              'legacy R-3 artifact does not declare the unit of totalCost; refusing to guess millions',
          }),
        );
      } else {
        try {
          const originalValue = parseCanonicalDecimalString(row.totalCost);
          totalCost = {
            originalValue,
            originalUnit: options.costUnit,
            valueMillions: moneyToMillionsString(originalValue, options.costUnit),
          };
          costFactIds.push(costFact.factId);
        } catch (cause) {
          builder.addOmission(
            buildOmission({
              sourceFactId: costFact.factId,
              reason: 'invalid_number',
              severity: 'blocking',
              message: `totalCost ${row.totalCost} is not finite: ${(cause as Error).message}`,
            }),
          );
        }
      }
      if (!peValid && costFactIds.length > 0) {
        // The performer assertion is blocked by the invalid identity, so a
        // successfully-scaled cost fact would be left uncovered. Omit it
        // explicitly rather than dropping it.
        builder.addOmission(
          buildOmission({
            sourceFactId: costFact.factId,
            reason: 'invalid_identity',
            severity: 'blocking',
            message: `totalCost cannot be asserted: parent PE code ${row.peCode} is invalid`,
          }),
        );
      }
    }

    if (peValid) {
      builder.addAssertion({
        assertionId: assertionIdV1({ sourcePath: rowPath, kind: 'performer' }),
        assertionKind: 'performer',
        parentPeCode: row.peCode,
        ...(row.projectCode != null ? { projectCode: row.projectCode } : {}),
        performerName: row.performer,
        performerNormalized: row.performerNormalized,
        performerRole: row.performerRole ?? 'PERFORMING_ACTIVITY',
        ...(row.location != null ? { location: row.location } : {}),
        ...(row.contractMethod != null ? { contractMethod: row.contractMethod } : {}),
        ...(row.costCategory != null ? { costCategory: row.costCategory } : {}),
        fiscalYear: row.fy,
        ...(totalCost != null ? { totalCost } : {}),
        sourceFactIds: [performerFact.factId, ...costFactIds],
        evidenceIds: [rowEvidence.evidenceId],
        confidence: 1,
        metadata: {
          peName: row.peName,
          projectName: row.projectName,
        },
      });
    }
  });

  if (artifact.error != null) {
    builder.addWarning(
      buildWarning({
        code: 'legacy_r3_artifact_error',
        severity: 'blocking',
        message: `legacy R-3 artifact carries an error: ${artifact.error}`,
        evidenceIds: [docEvidence.evidenceId],
      }),
    );
  }

  return builder.finalize();
}
