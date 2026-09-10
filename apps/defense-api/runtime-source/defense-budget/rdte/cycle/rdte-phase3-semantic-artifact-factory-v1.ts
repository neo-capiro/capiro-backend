/** RDT&E semantic artifact factory for the Phase 3 parser-router seam. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArtifactBuilderV1, factIdV1, omissionIdV1 } from '../../contracts/artifact-builders.js';
import { sha256Bytes } from '../../contracts/canonical-json.js';
import type { BudgetCycleManifestDocumentV1 } from '../../contracts/budget-cycle-manifest-v1.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
} from '../../contracts/extraction-artifact-v1.js';
import type {
  ExtractionArtifactBridgeInput,
  ExtractionArtifactBridgeOutput,
} from '../../parser-router/extraction-artifact-bridge.js';
import { extractR1FromPages } from '../r1/r1-extractor-v1.js';
import { buildR1Artifact } from '../r1/r1-artifact-builder-v1.js';
import { applyR1TextReconstructionV1 } from '../r1/r1-text-row-reconstructor-v1.js';
import { segmentR2ExhibitPages } from '../r2/r2-exhibit-segmenter.js';
import { resolveR2Contexts } from '../r2/r2-context-resolver.js';
import { extractR2Identities } from '../r2/r2-identity-extractor-v1.js';
import { extractR2Narrative } from '../r2/r2-narrative-extractor-v1.js';
import { extractR2PeFunding } from '../r2/r2-cost-table-extractor-v1.js';
import { buildR2PeFundingArtifact } from '../r2/r2-pe-funding-builder.js';
import { buildCompleteR2Artifact } from '../r2/r2-complete-artifact-builder-v1.js';
import { extractR2aProjectsFromPages } from '../r2a/r2a-project-extractor-v1.js';
import { extractR2aProjectFunding } from '../r2a/r2a-project-funding-extractor-v1.js';
import { groupR2aPagesByStructuralIdentityV1 } from '../r2a/r2a-structural-project-header-parser-v1.js';
import { buildR2aProjectArtifact } from '../r2a/r2a-artifact-builder-v1.js';
import { extractR3PerformersFromPages } from '../r3/r3-table-extractor-v1.js';
import { buildR3PerformerArtifact } from '../r3/r3-artifact-builder-v1.js';
import { extractR4MilestonesFromPages } from '../r4/r4-extractor-v1.js';
import { buildR4MilestoneArtifact } from '../r4/r4-artifact-builder-v1.js';
import { mergeRdteArtifactsV1 } from './merge-rdte-artifacts-v1.js';
import {
  rdteDocumentInputFromPhase3,
  type RdteCycleDocumentInputV1,
} from './rdte-phase3-document-input-v1.js';

export interface RdteSemanticArtifactCaptureV1 {
  documentInput: RdteCycleDocumentInputV1 | null;
  artifact: DefenseBudgetExtractionArtifactV1 | null;
  artifactLocator: string | null;
  serializedArtifact: string | null;
}

function appendUnresolvedPageOmissions(input: {
  artifact: DefenseBudgetExtractionArtifactV1;
  unresolvedPages: readonly number[];
  /** Phase 10B-21 (3rd independent review, Area 8): pages where every
   * attempted parser engine agreed there was no content to extract at all
   * (`no_embedded_text`, every engine, unanimously) -- provably blank
   * separator pages, not a genuine extraction defect. These produce NO
   * source fact and NO omission, the identical "no required R-2 identity
   * source fact" treatment the segmenter already gives a blank page it CAN
   * see; a page with even one differently-coded failure is never included
   * here and keeps blocking below exactly as before. */
  provablyBlankPages?: readonly number[];
}): DefenseBudgetExtractionArtifactV1 {
  const blankPageSet = new Set(input.provablyBlankPages ?? []);
  const blockingUnresolvedPages = [...new Set(input.unresolvedPages)]
    .filter((page) => !blankPageSet.has(page))
    .sort((a, b) => a - b);
  if (blockingUnresolvedPages.length === 0) return input.artifact;
  const builder = new ArtifactBuilderV1(input.artifact.source);
  for (const value of input.artifact.parserRuns) builder.addParserRun(value);
  for (const value of input.artifact.evidence) builder.addEvidence(value);
  for (const value of input.artifact.sourceFacts) builder.addSourceFact(value);
  for (const value of input.artifact.assertions) builder.addAssertion(value);
  for (const value of input.artifact.warnings) builder.addWarning(value);
  for (const value of input.artifact.omissions) builder.addOmission(value);
  for (const page of blockingUnresolvedPages) {
    const factId = factIdV1({
      kind: 'rdte_unresolved_phase3_page',
      documentKey: input.artifact.source.manifestDocumentKey,
      page,
    });
    builder.addSourceFact({
      factId,
      sourcePath: `phase3/unresolved/page:${page}`,
      category: 'metadata',
      requiredForCompleteness: true,
      rawValue: { page, state: 'unresolved' },
      evidenceIds: [],
    });
    builder.addOmission({
      omissionId: omissionIdV1({
        kind: 'rdte_unresolved_phase3_page',
        documentKey: input.artifact.source.manifestDocumentKey,
        page,
      }),
      sourceFactId: factId,
      reason: 'missing_evidence',
      severity: 'blocking',
      message: `Phase 3 did not select a parser result for physical page ${page}`,
    });
  }
  return builder.finalize();
}

/**
 * Phase 10B-23A Part E: preserve an Exhibit R-1 (document-wide summary,
 * "Total Obligational Authority") page's OCR text and page-level provenance
 * as an explicit, non-blocking, informational source fact -- distinct from
 * both a genuine R-2/R-2A/R-3/R-4 exhibit (which produces real assertions)
 * and a genuinely blank/front-matter page (which is silently dropped as
 * `non_semantic`, correctly, since it carries no content at all). This page
 * DOES carry real government budget data; it is simply not the single-PE
 * exhibit this pipeline projects R-2 funding assertions from.
 * `requiredForCompleteness: false` is the one field that matters most here --
 * it is what keeps this fact from ever being treated as an omission, unlike
 * the blocking `rdte_unresolved_phase3_page` fact `appendUnresolvedPageOmissions`
 * emits for a page that never got a selected parser result at all.
 */
function buildR1SummaryAcknowledgmentArtifact(input: {
  source: ExtractionSourceV1;
  parserRuns: RdteCycleDocumentInputV1['parserRuns'];
  pages: RdteCycleDocumentInputV1['pages'];
  resolvedR1SummaryPages: readonly { page: number; printedPage?: string; segmentId: string }[];
}): DefenseBudgetExtractionArtifactV1 | null {
  if (input.resolvedR1SummaryPages.length === 0) return null;
  const pageMap = new Map(input.pages.map((p) => [p.page, p]));
  const builder = new ArtifactBuilderV1(input.source);
  for (const run of input.parserRuns) builder.addParserRun(run);
  for (const resolved of input.resolvedR1SummaryPages) {
    const parserPage = pageMap.get(resolved.page);
    const factId = factIdV1({
      kind: 'rdte_r1_summary_page',
      documentKey: input.source.manifestDocumentKey,
      page: resolved.page,
    });
    builder.addSourceFact({
      factId,
      sourcePath: `phase3/r1_summary/page:${resolved.page}`,
      category: 'metadata',
      requiredForCompleteness: false,
      rawValue: {
        page: resolved.page,
        ...(resolved.printedPage != null ? { printedPage: resolved.printedPage } : {}),
        segmentId: resolved.segmentId,
        state: 'r1_summary_embedded',
        note:
          'Exhibit R-1 (Total Obligational Authority) document-wide summary table -- ' +
          'real government budget data, preserved for provenance, not projected as R-2 ' +
          'PE-attributed funding by this pipeline.',
        text: parserPage?.text ?? null,
      },
      evidenceIds: [],
    });
  }
  return builder.finalize();
}

/* Phase 10B-25: R-2A project-page grouping used to be independently
 * re-implemented here against an inline-text "project code:" regex that
 * never matches the real government layout (identity lives in self-labeled
 * TABLE CELLS -- see r2a-structural-project-header-parser-v1.ts for the
 * full root-cause writeup). Grouping is now delegated entirely to the one
 * shared structural grouper; this file must never re-derive its own
 * grouping logic again. */

function buildSemanticArtifact(input: {
  documentInput: RdteCycleDocumentInputV1;
  fiscalYear: number;
}): DefenseBudgetExtractionArtifactV1 {
  const value = input.documentInput;
  const exhibit = value.document.exhibit;

  if (exhibit === 'R-1') {
    // Phase 10B-11: the real production deterministic_pdfplumber run for
    // the FY2024 R-1 canary emits every page's tabular data as positioned/
    // plain text -- pdfplumber's structural table detection finds zero
    // tables on all 114 real pages. `applyR1TextReconstructionV1` backfills
    // `page.tables` ONLY for pages where that is true and a canonical R-1
    // header is recognized; a page that already has real structural tables
    // (or no recognizable header at all) passes through unchanged, so
    // `extractR1FromPages` and `buildR1Artifact` below are exactly the
    // existing, unmodified R1 semantics either way -- this seam only ever
    // supplies input they didn't already have.
    const reconstruction = applyR1TextReconstructionV1(value.pages, input.fiscalYear);
    const extraction = extractR1FromPages({
      pages: reconstruction.pages,
      cycleFiscalYear: input.fiscalYear,
      rowContextByPage: reconstruction.rowContextByPage,
    });
    return buildR1Artifact({
      source: value.source,
      parserRuns: value.parserRuns,
      extraction: { ...extraction, omissions: [...extraction.omissions, ...reconstruction.omissions] },
      cycleFiscalYear: input.fiscalYear,
    });
  }

  if (exhibit === 'R-2') {
    const parts: DefenseBudgetExtractionArtifactV1[] = [];
    const resolution = resolveR2Contexts(segmentR2ExhibitPages(value.pages));
    const identities = extractR2Identities({ pages: value.pages, contextResolution: resolution });
    const narrative = extractR2Narrative({ pages: value.pages, contextResolution: resolution });
    const contexts = new Map<string, { pageStart: number; pageEnd: number }>();
    for (const page of resolution.pages) {
      if (page.kind !== 'r2_pe_summary' && page.kind !== 'r2_continuation') continue;
      if (!page.peCode) continue;
      const current = contexts.get(page.peCode);
      if (current) {
        current.pageStart = Math.min(current.pageStart, page.page);
        current.pageEnd = Math.max(current.pageEnd, page.page);
      } else contexts.set(page.peCode, { pageStart: page.page, pageEnd: page.page });
    }
    const funding = [...contexts.entries()].map(([peCode, range]) =>
      extractR2PeFunding({
        pages: value.pages,
        peContext: { peCode, ...range },
        cycleFiscalYear: input.fiscalYear,
      }),
    );
    const fundingArtifact = buildR2PeFundingArtifact({
      source: value.source,
      parserRuns: value.parserRuns,
      extractions: funding,
      comparisonRequests: [],
      cycleFiscalYear: input.fiscalYear,
    });
    parts.push(
      buildCompleteR2Artifact({
        fundingArtifact,
        parserRuns: value.parserRuns,
        identities,
        narrative,
      }),
    );

    const r1SummaryAcknowledgment = buildR1SummaryAcknowledgmentArtifact({
      source: value.source,
      parserRuns: value.parserRuns,
      pages: value.pages,
      resolvedR1SummaryPages: resolution.pages
        .filter((p) => p.kind === 'r1_summary')
        .map((p) => ({
          page: p.page,
          ...(p.printedPage != null ? { printedPage: p.printedPage } : {}),
          segmentId: p.segmentId,
        })),
    });
    if (r1SummaryAcknowledgment != null) parts.push(r1SummaryAcknowledgment);

    const projects = extractR2aProjectsFromPages({ pages: value.pages });
    const projectFunding = groupR2aPagesByStructuralIdentityV1(value.pages).groups.map((group) =>
      extractR2aProjectFunding({ group, cycleFiscalYear: input.fiscalYear }),
    );
    if (
      projects.identities.length > 0 ||
      projects.omissions.length > 0 ||
      projectFunding.some((result) => result.values.length > 0 || result.omissions.length > 0)
    ) {
      parts.push(
        buildR2aProjectArtifact({
          source: value.source,
          parserRuns: value.parserRuns,
          projects: [projects],
          funding: projectFunding,
          cycleFiscalYear: input.fiscalYear,
        }),
      );
    }
    const r3 = extractR3PerformersFromPages({
      pages: value.pages,
      cycleFiscalYear: input.fiscalYear,
    });
    if (r3.length > 0) {
      parts.push(
        buildR3PerformerArtifact({
          source: value.source,
          parserRuns: value.parserRuns,
          extractions: r3,
          cycleFiscalYear: input.fiscalYear,
        }),
      );
    }
    const r4 = extractR4MilestonesFromPages({ pages: value.pages });
    if (r4.length > 0) {
      parts.push(
        buildR4MilestoneArtifact({
          source: value.source,
          parserRuns: value.parserRuns,
          extractions: r4,
        }),
      );
    }
    return mergeRdteArtifactsV1(parts);
  }

  if (exhibit === 'R-2A') {
    const projects = extractR2aProjectsFromPages({ pages: value.pages });
    const funding = groupR2aPagesByStructuralIdentityV1(value.pages).groups.map((group) =>
      extractR2aProjectFunding({ group, cycleFiscalYear: input.fiscalYear }),
    );
    return buildR2aProjectArtifact({
      source: value.source,
      parserRuns: value.parserRuns,
      projects: [projects],
      funding,
      cycleFiscalYear: input.fiscalYear,
    });
  }

  if (exhibit === 'R-3') {
    return buildR3PerformerArtifact({
      source: value.source,
      parserRuns: value.parserRuns,
      extractions: extractR3PerformersFromPages({
        pages: value.pages,
        cycleFiscalYear: input.fiscalYear,
      }),
      cycleFiscalYear: input.fiscalYear,
    });
  }

  if (exhibit === 'R-4' || exhibit === 'R-4A') {
    return buildR4MilestoneArtifact({
      source: value.source,
      parserRuns: value.parserRuns,
      extractions: extractR4MilestonesFromPages({ pages: value.pages }),
    });
  }

  throw new Error(`unsupported RDT&E exhibit for semantic artifact: ${exhibit}`);
}

export function createRdteSemanticArtifactFactory(input: {
  document: BudgetCycleManifestDocumentV1;
  source: ExtractionSourceV1 & { sourceDocumentId: string };
  fiscalYear: number;
}): {
  capture: RdteSemanticArtifactCaptureV1;
  factory: (
    bridgeInput: ExtractionArtifactBridgeInput,
    outputDir: string,
  ) => ExtractionArtifactBridgeOutput;
} {
  const capture: RdteSemanticArtifactCaptureV1 = {
    documentInput: null,
    artifact: null,
    artifactLocator: null,
    serializedArtifact: null,
  };

  return {
    capture,
    factory(bridgeInput, outputDir) {
      if (bridgeInput.manifestDocumentKey !== input.document.documentKey) {
        throw new Error('RDT&E semantic artifact factory document-key mismatch');
      }
      if (bridgeInput.sourceSha256 !== input.source.sourcePdfSha256) {
        throw new Error('RDT&E semantic artifact factory source-SHA mismatch');
      }
      const documentInput = rdteDocumentInputFromPhase3({
        document: input.document,
        source: input.source,
        composedOutput: bridgeInput.composedOutput,
        providerJobIdsByParserRunId: bridgeInput.providerJobIdsByParserRunId,
      });
      const artifact = appendUnresolvedPageOmissions({
        artifact: buildSemanticArtifact({ documentInput, fiscalYear: input.fiscalYear }),
        unresolvedPages: documentInput.unresolvedPages,
        provablyBlankPages: documentInput.provablyBlankPages,
      });
      const serializedArtifact = `${JSON.stringify(artifact, null, 2)}\n`;
      const artifactDirectory = join(outputDir, 'artifacts');
      mkdirSync(artifactDirectory, { recursive: true });
      const artifactLocator = join(
        artifactDirectory,
        `${artifact.artifactId}.rdte-extraction-v1.json`,
      );
      writeFileSync(artifactLocator, serializedArtifact, 'utf8');
      capture.documentInput = documentInput;
      capture.artifact = artifact;
      capture.artifactLocator = artifactLocator;
      capture.serializedArtifact = serializedArtifact;
      return {
        artifact,
        artifactId: artifact.artifactId,
        artifactContentSha256: artifact.contentSha256,
        artifactByteSha256: sha256Bytes(Buffer.from(serializedArtifact, 'utf8')),
        artifactLocator,
        parserRuns: artifact.parserRuns,
        sourceFactCount: artifact.sourceFacts.length,
        assertionCount: artifact.assertions.length,
        evidenceCount: artifact.evidence.length,
        warningCount: artifact.warnings.length,
      };
    },
  };
}
