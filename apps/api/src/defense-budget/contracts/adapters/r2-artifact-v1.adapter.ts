/**
 * Workstream G — adapter for the legacy R-2/R-2A artifact consumed by
 * apps/api/scripts/sync-jbook-r2.ts.
 *
 * Page provenance is truthful: PE-level fields use page_only evidence at
 * pageStart; project fields use the project page. Cell boxes are never
 * invented. Optional future fields (fyData, accomplishments, plans) are
 * modeled explicitly as strict optional structures.
 */
import { z } from 'zod';
import { isValidPeCode } from '../../extractors/types.js';
import { ArtifactBuilderV1, assertionIdV1 } from '../artifact-builders.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  FundingFieldV1,
  MoneyValueV1,
} from '../extraction-artifact-v1.js';
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

const moneyUnitSchema = z.enum(['dollars', 'thousands', 'millions']);

/** Future optional per-FY funding row (modeled now, strict). */
export const r2FyDataRowV1Schema = z
  .object({
    fy: z.number().int().min(1900).max(2200),
    field: z.enum(['request', 'enacted', 'executed', 'reprogrammed']),
    value: z.number(),
    unit: moneyUnitSchema,
    page: z.number().int().positive().optional(),
  })
  .strict();

export const r2ProjectV1Schema = z
  .object({
    projectCode: z.string(),
    title: z.string(),
    mission: z.string(),
    page: z.number().int().positive(),
    fyData: z.array(r2FyDataRowV1Schema).optional(),
  })
  .strict();

export const r2ProgramElementV1Schema = z
  .object({
    peCode: z.string(),
    peName: z.string(),
    budgetActivity: z.string().nullable(),
    appropriation: z.string().nullable(),
    pageStart: z.number().int().positive().nullable(),
    pageEnd: z.number().int().positive().nullable(),
    mission: z.string(),
    projects: z.array(r2ProjectV1Schema),
    fyData: z.array(r2FyDataRowV1Schema).optional(),
    accomplishments: z.string().optional(),
    plans: z.string().optional(),
  })
  .strict();

export const r2ArtifactV1InputSchema = z
  .object({
    docType: z.string(),
    exhibitType: z.string(),
    fy: z.number().int(),
    sourceUrl: z.string(),
    volumeId: z.string(),
    pageCount: z.number().int().positive(),
    programElements: z.array(r2ProgramElementV1Schema),
    stats: z
      .object({
        program_elements: z.number(),
        projects: z.number(),
        pages_with_exhibits: z.number(),
      })
      .strict()
      .passthrough(),
    error: z.string().optional(),
  })
  .strict();

export type R2ArtifactV1Input = z.infer<typeof r2ArtifactV1InputSchema>;

const PE_FIELD_MAP: Record<string, FundingFieldV1> = {
  request: 'request',
  enacted: 'enacted',
  executed: 'executed',
  reprogrammed: 'reprogrammed',
};

export function adaptR2ArtifactToArtifactV1(
  input: R2ArtifactV1Input,
  context: ExtractionAdapterContextV1,
): DefenseBudgetExtractionArtifactV1 {
  const artifact = r2ArtifactV1InputSchema.parse(input);
  const builder = new ArtifactBuilderV1(sourceFromContext(context));
  const parserRun = parserRunFromContext(context);
  builder.addParserRun(parserRun);

  const docEvidence = buildTruthfulEvidence(context, {
    parserRunId: parserRun.parserRunId,
    discriminator: 'document',
  });
  builder.addEvidence(docEvidence);

  artifact.programElements.forEach((pe, peIndex) => {
    const pePath = `programElements[${peIndex}]`;
    const peEvidence = buildTruthfulEvidence(context, {
      parserRunId: parserRun.parserRunId,
      page: pe.pageStart ?? undefined,
      rowLabel: pe.peName,
      discriminator: pePath,
    });
    builder.addEvidence(peEvidence);

    const peValid = isValidPeCode(pe.peCode);

    // Identity
    const identityFact = buildSourceFact({
      sourcePath: `${pePath}.identity`,
      category: 'identity',
      requiredForCompleteness: true,
      rawValue: {
        peCode: pe.peCode,
        peName: pe.peName,
        budgetActivity: pe.budgetActivity,
        appropriation: pe.appropriation,
      },
      evidenceIds: [peEvidence.evidenceId],
    });
    builder.addSourceFact(identityFact);
    if (!peValid) {
      builder.addOmission(
        buildOmission({
          sourceFactId: identityFact.factId,
          reason: 'invalid_identity',
          severity: 'blocking',
          message: `invalid R-2 PE code: ${pe.peCode}`,
        }),
      );
    } else {
      builder.addAssertion({
        assertionId: assertionIdV1({ sourcePath: `${pePath}.identity` }),
        assertionKind: 'program_element_identity',
        identity: { lineKind: 'RDTE_PE', peCode: pe.peCode },
        title: pe.peName,
        component: context.component,
        ...(pe.appropriation != null ? { appropriation: pe.appropriation } : {}),
        ...(pe.budgetActivity != null ? { budgetActivity: pe.budgetActivity } : {}),
        sourceFactIds: [identityFact.factId],
        evidenceIds: [peEvidence.evidenceId],
        confidence: 1,
      });
    }

    // Mission narrative
    if (pe.mission.trim() !== '') {
      const missionFact = buildSourceFact({
        sourcePath: `${pePath}.mission`,
        category: 'text',
        requiredForCompleteness: true,
        rawValue: pe.mission,
        evidenceIds: [peEvidence.evidenceId],
      });
      builder.addSourceFact(missionFact);
      if (peValid) {
        builder.addAssertion({
          assertionId: assertionIdV1({ sourcePath: `${pePath}.mission`, kind: 'narrative' }),
          assertionKind: 'narrative',
          identity: { lineKind: 'RDTE_PE', peCode: pe.peCode },
          narrativeType: 'mission',
          text: pe.mission,
          sourceFactIds: [missionFact.factId],
          evidenceIds: [peEvidence.evidenceId],
          confidence: 1,
        });
      } else {
        builder.addOmission(
          buildOmission({
            sourceFactId: missionFact.factId,
            reason: 'invalid_identity',
            severity: 'blocking',
            message: `mission sits under invalid PE code ${pe.peCode}`,
          }),
        );
      }
    }

    // Optional accomplishments / plans narratives
    for (const [field, narrativeType] of [
      ['accomplishments', 'accomplishments'],
      ['plans', 'plans'],
    ] as const) {
      const text = pe[field];
      if (text == null || text.trim() === '') continue;
      const textFact = buildSourceFact({
        sourcePath: `${pePath}.${field}`,
        category: 'text',
        requiredForCompleteness: true,
        rawValue: text,
        evidenceIds: [peEvidence.evidenceId],
      });
      builder.addSourceFact(textFact);
      if (peValid) {
        builder.addAssertion({
          assertionId: assertionIdV1({ sourcePath: `${pePath}.${field}`, kind: 'narrative' }),
          assertionKind: 'narrative',
          identity: { lineKind: 'RDTE_PE', peCode: pe.peCode },
          narrativeType,
          text,
          sourceFactIds: [textFact.factId],
          evidenceIds: [peEvidence.evidenceId],
          confidence: 1,
        });
      } else {
        builder.addOmission(
          buildOmission({
            sourceFactId: textFact.factId,
            reason: 'invalid_identity',
            severity: 'blocking',
            message: `${field} sits under invalid PE code ${pe.peCode}`,
          }),
        );
      }
    }

    // Optional PE funding rows
    (pe.fyData ?? []).forEach((row, rowIndex) => {
      const rowPath = `${pePath}.fyData[${rowIndex}]`;
      const rowEvidence = buildTruthfulEvidence(context, {
        parserRunId: parserRun.parserRunId,
        page: row.page ?? pe.pageStart ?? undefined,
        discriminator: rowPath,
      });
      builder.addEvidence(rowEvidence);
      const moneyFact = buildSourceFact({
        sourcePath: rowPath,
        category: 'money',
        requiredForCompleteness: true,
        rawValue: row,
        evidenceIds: [rowEvidence.evidenceId],
      });
      builder.addSourceFact(moneyFact);
      if (!peValid) {
        builder.addOmission(
          buildOmission({
            sourceFactId: moneyFact.factId,
            reason: 'invalid_identity',
            severity: 'blocking',
            message: `PE fyData sits under invalid PE code ${pe.peCode}`,
          }),
        );
        return;
      }
      let money: MoneyValueV1;
      try {
        const originalValue = parseCanonicalDecimalString(row.value);
        money = {
          originalValue,
          originalUnit: row.unit,
          valueMillions: moneyToMillionsString(originalValue, row.unit),
        };
      } catch (cause) {
        builder.addOmission(
          buildOmission({
            sourceFactId: moneyFact.factId,
            reason: 'invalid_number',
            severity: 'blocking',
            message: `PE fyData value ${row.value} is not finite: ${(cause as Error).message}`,
          }),
        );
        return;
      }
      builder.addAssertion({
        assertionId: assertionIdV1({ sourcePath: rowPath, kind: 'funding' }),
        assertionKind: 'funding',
        identity: { lineKind: 'RDTE_PE', peCode: pe.peCode },
        fiscalYear: row.fy,
        field: PE_FIELD_MAP[row.field] ?? 'request',
        money,
        sourceFactIds: [moneyFact.factId],
        evidenceIds: [rowEvidence.evidenceId],
        confidence: 1,
      });
    });

    // Projects — duplicates remain duplicate assertions, no last-win collapse.
    pe.projects.forEach((project, projectIndex) => {
      const projectPath = `${pePath}.projects[${projectIndex}]`;
      const projectEvidence = buildTruthfulEvidence(context, {
        parserRunId: parserRun.parserRunId,
        page: project.page,
        rowLabel: project.title,
        discriminator: projectPath,
      });
      builder.addEvidence(projectEvidence);

      const projectFact = buildSourceFact({
        sourcePath: projectPath,
        category: 'project',
        requiredForCompleteness: true,
        rawValue: {
          projectCode: project.projectCode,
          title: project.title,
          mission: project.mission,
          parentPeCode: pe.peCode,
        },
        evidenceIds: [projectEvidence.evidenceId],
      });
      builder.addSourceFact(projectFact);

      if (!peValid) {
        builder.addOmission(
          buildOmission({
            sourceFactId: projectFact.factId,
            reason: 'invalid_identity',
            severity: 'blocking',
            message: `project ${project.projectCode} has no valid parent PE code (${pe.peCode})`,
          }),
        );
      } else {
        builder.addAssertion({
          assertionId: assertionIdV1({ sourcePath: projectPath, kind: 'project' }),
          assertionKind: 'project',
          parentPeCode: pe.peCode,
          projectCode: project.projectCode,
          title: project.title,
          ...(project.mission.trim() !== '' ? { mission: project.mission } : {}),
          ...(pe.budgetActivity != null ? { budgetActivity: pe.budgetActivity } : {}),
          sourceFactIds: [projectFact.factId],
          evidenceIds: [projectEvidence.evidenceId],
          confidence: 1,
        });
      }

      // Optional project funding rows
      (project.fyData ?? []).forEach((row, rowIndex) => {
        const rowPath = `${projectPath}.fyData[${rowIndex}]`;
        const rowEvidence = buildTruthfulEvidence(context, {
          parserRunId: parserRun.parserRunId,
          page: row.page ?? project.page,
          discriminator: rowPath,
        });
        builder.addEvidence(rowEvidence);
        const moneyFact = buildSourceFact({
          sourcePath: rowPath,
          category: 'money',
          requiredForCompleteness: true,
          rawValue: row,
          evidenceIds: [rowEvidence.evidenceId],
        });
        builder.addSourceFact(moneyFact);
        if (!peValid) {
          builder.addOmission(
            buildOmission({
              sourceFactId: moneyFact.factId,
              reason: 'invalid_identity',
              severity: 'blocking',
              message: `project fyData sits under invalid parent PE code ${pe.peCode}`,
            }),
          );
          return;
        }
        let money: MoneyValueV1;
        try {
          const originalValue = parseCanonicalDecimalString(row.value);
          money = {
            originalValue,
            originalUnit: row.unit,
            valueMillions: moneyToMillionsString(originalValue, row.unit),
          };
        } catch (cause) {
          builder.addOmission(
            buildOmission({
              sourceFactId: moneyFact.factId,
              reason: 'invalid_number',
              severity: 'blocking',
              message: `project fyData value ${row.value} is not finite: ${(cause as Error).message}`,
            }),
          );
          return;
        }
        builder.addAssertion({
          assertionId: assertionIdV1({ sourcePath: rowPath, kind: 'project_funding' }),
          assertionKind: 'project_funding',
          parentPeCode: pe.peCode,
          projectCode: project.projectCode,
          fiscalYear: row.fy,
          field: PE_FIELD_MAP[row.field] as 'request' | 'enacted' | 'executed' | 'reprogrammed',
          money,
          sourceFactIds: [moneyFact.factId],
          evidenceIds: [rowEvidence.evidenceId],
          confidence: 1,
        });
      });
    });
  });

  // Legacy gap: projects exist but no project funding fields anywhere.
  const hasProjects = artifact.programElements.some((pe) => pe.projects.length > 0);
  const hasAnyProjectFunding = artifact.programElements.some((pe) =>
    pe.projects.some((project) => (project.fyData ?? []).length > 0),
  );
  if (hasProjects && !hasAnyProjectFunding) {
    builder.addWarning(
      buildWarning({
        code: 'legacy_r2a_artifact_missing_project_funding',
        severity: 'review',
        message:
          'legacy R-2/R-2A artifact carries projects but no project funding fields; project funding completeness cannot be proven from this artifact',
        evidenceIds: [docEvidence.evidenceId],
      }),
    );
  }

  if (artifact.error != null) {
    builder.addWarning(
      buildWarning({
        code: 'legacy_r2_artifact_error',
        severity: 'blocking',
        message: `legacy R-2 artifact carries an error: ${artifact.error}`,
        evidenceIds: [docEvidence.evidenceId],
      }),
    );
  }

  return builder.finalize();
}
