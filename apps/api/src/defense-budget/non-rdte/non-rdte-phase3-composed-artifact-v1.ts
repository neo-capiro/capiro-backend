/**
 * Phase 3 composed-output -> Phase 5 semantic artifact boundary.
 *
 * This is the multi-parser companion to the complete-single-result replay
 * factory. It accepts the exact Phase 3 composition record, derives only the
 * parser runs that contributed selected pages, builds family semantics from
 * those selected pages, records unresolved pages as blocking omissions, and
 * verifies every contributing run against independently loaded result bytes.
 */
import { z } from 'zod';
import { ArtifactBuilderV1, factIdV1, omissionIdV1 } from '../contracts/artifact-builders.js';
import type { BudgetCycleManifestDocumentV1 } from '../contracts/budget-cycle-manifest-v1.js';
import {
  extractionMethodV1Schema,
  sha256Schema,
  type DefenseBudgetExtractionArtifactV1,
  type ExtractionSourceV1,
} from '../contracts/extraction-artifact-v1.js';
import { buildContributingParserRuns } from '../parser-router/extraction-artifact-bridge.js';
import {
  validatePageCompleteness,
  verifyComposedContentSha,
  type ComposedPageOutputV1,
} from '../parser-router/page-result-compositor.js';
import {
  parserPageFailureV1Schema,
  parserPageResultV1Schema,
} from '../parser-router/parser-runtime-contract-v1.js';
import {
  buildNonRdteSemanticArtifactFromPages,
  Phase5SemanticArtifactError,
} from './non-rdte-semantic-artifact-factory-v1.js';
import {
  assertPhase5ArtifactProofBound,
  type Phase5ParserResultProofV1,
} from './non-rdte-proof-bound-artifact-v1.js';

const nonblankString = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: 'must be nonblank',
  });

const pageLineageEntryV1Schema = z
  .object({
    parserRunId: nonblankString,
    method: extractionMethodV1Schema,
    parserVersion: nonblankString,
    parserConfigSha256: sha256Schema,
    sourceSha256: sha256Schema,
    page: z.number().int().positive(),
    outputArtifactSha256: sha256Schema,
  })
  .strict();

const selectedPageResultV1Schema = z
  .object({
    page: z.number().int().positive(),
    selectedParserRunId: nonblankString.nullable(),
    selectionReasonCodes: z.array(nonblankString).min(1),
    selectedResult: parserPageResultV1Schema.nullable(),
    alternativeParserRunIds: z.array(nonblankString),
    failures: z.array(parserPageFailureV1Schema),
  })
  .strict();

export const phase5ComposedPageOutputV1Schema = z
  .object({
    schemaVersion: z.literal('defense_budget_composed_output_v1'),
    executionId: nonblankString,
    sourceSha256: sha256Schema,
    pages: z.array(selectedPageResultV1Schema).min(1),
    lineages: z.array(pageLineageEntryV1Schema),
    contentSha256: sha256Schema,
  })
  .strict()
  .superRefine((output, ctx) => {
    const pageNumbers = output.pages.map((page) => page.page);
    const sorted = [...pageNumbers].sort((left, right) => left - right);
    if (new Set(pageNumbers).size !== pageNumbers.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pages'],
        message: 'page entries must be unique',
      });
    }
    if (!pageNumbers.every((page, index) => page === sorted[index])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pages'],
        message: 'page entries must be sorted ascending',
      });
    }

    const lineageKeys = new Set<string>();
    for (const [index, lineage] of output.lineages.entries()) {
      const key = `${lineage.parserRunId}::${lineage.page}`;
      if (lineageKeys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lineages', index],
          message: `duplicate parser-run/page lineage ${key}`,
        });
      }
      lineageKeys.add(key);
      if (lineage.sourceSha256 !== output.sourceSha256) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lineages', index, 'sourceSha256'],
          message: 'lineage source SHA must equal composed source SHA',
        });
      }
    }

    for (const [index, page] of output.pages.entries()) {
      if ((page.selectedResult == null) !== (page.selectedParserRunId == null)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pages', index],
          message: 'selectedResult and selectedParserRunId must both be present or both be null',
        });
      }
      if (page.selectedResult != null && page.selectedResult.page !== page.page) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pages', index, 'selectedResult', 'page'],
          message: 'selected result page must equal selected page envelope',
        });
      }
      if (
        page.selectedParserRunId != null &&
        !lineageKeys.has(`${page.selectedParserRunId}::${page.page}`)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pages', index, 'selectedParserRunId'],
          message: 'selected parser run has no exact page lineage',
        });
      }
      const alternatives = new Set<string>();
      for (const [alternativeIndex, runId] of page.alternativeParserRunIds.entries()) {
        if (alternatives.has(runId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['pages', index, 'alternativeParserRunIds', alternativeIndex],
            message: `duplicate alternative parser run ${runId}`,
          });
        }
        alternatives.add(runId);
        if (!lineageKeys.has(`${runId}::${page.page}`)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['pages', index, 'alternativeParserRunIds', alternativeIndex],
            message: 'alternative parser run has no exact page lineage',
          });
        }
      }
    }
  });

export type Phase5ComposedPageOutputV1 = z.infer<typeof phase5ComposedPageOutputV1Schema>;

function parseComposedOutput(input: unknown): ComposedPageOutputV1 {
  const output = phase5ComposedPageOutputV1Schema.parse(input) as ComposedPageOutputV1;
  if (!verifyComposedContentSha(output)) {
    throw new Phase5SemanticArtifactError(
      `composed output ${output.executionId} has an invalid content SHA`,
      'composed_output_content_sha_mismatch',
    );
  }
  if (!validatePageCompleteness(output.pages)) {
    throw new Phase5SemanticArtifactError(
      `composed output ${output.executionId} has an invalid page-completeness ledger`,
      'composed_output_page_ledger_invalid',
    );
  }
  return output;
}

function appendUnresolvedPages(input: {
  artifact: DefenseBudgetExtractionArtifactV1;
  composedOutput: ComposedPageOutputV1;
}): DefenseBudgetExtractionArtifactV1 {
  const unresolved = input.composedOutput.pages.filter(
    (page) => page.selectedResult == null || page.selectedParserRunId == null,
  );
  if (unresolved.length === 0) return input.artifact;

  const builder = new ArtifactBuilderV1(input.artifact.source);
  for (const value of input.artifact.parserRuns) builder.addParserRun(value);
  for (const value of input.artifact.evidence) builder.addEvidence(value);
  for (const value of input.artifact.sourceFacts) builder.addSourceFact(value);
  for (const value of input.artifact.assertions) builder.addAssertion(value);
  for (const value of input.artifact.warnings) builder.addWarning(value);
  for (const value of input.artifact.omissions) builder.addOmission(value);

  for (const page of unresolved) {
    const factId = factIdV1({
      kind: 'non_rdte_unresolved_phase3_page',
      documentKey: input.artifact.source.manifestDocumentKey,
      page: page.page,
      selectionReasonCodes: page.selectionReasonCodes,
      failures: page.failures,
    });
    builder.addSourceFact({
      factId,
      sourcePath: `phase3/composed/unresolved/page:${page.page}`,
      category: 'metadata',
      requiredForCompleteness: true,
      rawValue: {
        page: page.page,
        selectionReasonCodes: page.selectionReasonCodes,
        failures: page.failures,
      },
      evidenceIds: [],
    });
    builder.addOmission({
      omissionId: omissionIdV1({
        kind: 'non_rdte_unresolved_phase3_page',
        documentKey: input.artifact.source.manifestDocumentKey,
        page: page.page,
      }),
      sourceFactId: factId,
      reason: 'missing_evidence',
      severity: 'blocking',
      message: `Phase 3 did not select a parser result for physical page ${page.page}`,
    });
  }
  return builder.finalize();
}

function exactContributingProofs(input: {
  parserRuns: readonly { parserRunId: string }[];
  parserResultProofs: readonly Phase5ParserResultProofV1[];
}): Phase5ParserResultProofV1[] {
  const proofByRunId = new Map<string, Phase5ParserResultProofV1>();
  for (const proof of input.parserResultProofs) {
    if (proofByRunId.has(proof.parserRunId)) {
      throw new Phase5SemanticArtifactError(
        `duplicate parser-result proof ${proof.parserRunId}`,
        'parser_result_proof_duplicate',
      );
    }
    proofByRunId.set(proof.parserRunId, proof);
  }
  return input.parserRuns.map((run) => {
    const proof = proofByRunId.get(run.parserRunId);
    if (proof == null) {
      throw new Phase5SemanticArtifactError(
        `missing persisted parser-result proof ${run.parserRunId}`,
        'parser_result_proof_missing',
      );
    }
    return proof;
  });
}

export function buildProofBoundNonRdteArtifactFromComposedOutput(input: {
  document: BudgetCycleManifestDocumentV1;
  source: ExtractionSourceV1;
  composedOutput: unknown;
  parserResultProofs: readonly Phase5ParserResultProofV1[];
}): DefenseBudgetExtractionArtifactV1 {
  const composedOutput = parseComposedOutput(input.composedOutput);
  if (composedOutput.sourceSha256 !== input.source.sourcePdfSha256) {
    throw new Phase5SemanticArtifactError(
      `composed output source SHA does not match ${input.document.documentKey}`,
      'composed_output_source_sha_mismatch',
    );
  }

  const parserRuns = buildContributingParserRuns(composedOutput.lineages, composedOutput.pages);
  const selectedPages = composedOutput.pages.flatMap((page) =>
    page.selectedResult == null ? [] : [page.selectedResult],
  );
  if (selectedPages.length === 0 || parserRuns.length === 0) {
    throw new Phase5SemanticArtifactError(
      `composed output ${composedOutput.executionId} has no selected semantic pages with contributing lineage`,
      'composed_output_no_selected_pages',
    );
  }

  const semanticArtifact = buildNonRdteSemanticArtifactFromPages({
    document: input.document,
    source: input.source,
    pages: selectedPages,
    parserRuns,
  });
  const artifact = appendUnresolvedPages({ artifact: semanticArtifact, composedOutput });
  const contributingProofs = exactContributingProofs({
    parserRuns: artifact.parserRuns,
    parserResultProofs: input.parserResultProofs,
  });
  assertPhase5ArtifactProofBound({
    artifact,
    parserResultProofs: contributingProofs,
    requireResultByteSha256: true,
  });
  return artifact;
}
