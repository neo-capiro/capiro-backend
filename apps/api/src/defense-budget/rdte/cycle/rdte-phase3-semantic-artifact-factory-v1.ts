/** RDT&E semantic artifact factory for the Phase 3 parser-router seam. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ArtifactBuilderV1,
  factIdV1,
  omissionIdV1,
} from '../../contracts/artifact-builders.js';
import { sha256Bytes } from '../../contracts/canonical-json.js';
import type {
  BudgetCycleManifestDocumentV1,
} from '../../contracts/budget-cycle-manifest-v1.js';
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
import { segmentR2ExhibitPages } from '../r2/r2-exhibit-segmenter.js';
import { resolveR2Contexts } from '../r2/r2-context-resolver.js';
import { extractR2Identities } from '../r2/r2-identity-extractor-v1.js';
import { extractR2Narrative } from '../r2/r2-narrative-extractor-v1.js';
import { extractR2PeFunding } from '../r2/r2-cost-table-extractor-v1.js';
import { buildR2PeFundingArtifact } from '../r2/r2-pe-funding-builder.js';
import { buildCompleteR2Artifact } from '../r2/r2-complete-artifact-builder-v1.js';
import { extractR2aProjectsFromPages } from '../r2a/r2a-project-extractor-v1.js';
import { extractR2aProjectFunding } from '../r2a/r2a-project-funding-extractor-v1.js';
import type { R2aProjectPageGroup } from '../r2a/r2a-project-extractor-v1.js';
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
}): DefenseBudgetExtractionArtifactV1 {
  if (input.unresolvedPages.length === 0) return input.artifact;
  const builder = new ArtifactBuilderV1(input.artifact.source);
  for (const value of input.artifact.parserRuns) builder.addParserRun(value);
  for (const value of input.artifact.evidence) builder.addEvidence(value);
  for (const value of input.artifact.sourceFacts) builder.addSourceFact(value);
  for (const value of input.artifact.assertions) builder.addAssertion(value);
  for (const value of input.artifact.warnings) builder.addWarning(value);
  for (const value of input.artifact.omissions) builder.addOmission(value);
  for (const page of [...new Set(input.unresolvedPages)].sort((a, b) => a - b)) {
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

function r2aGroups(pages: RdteCycleDocumentInputV1['pages']): R2aProjectPageGroup[] {
  const marker = /\bR-2A\b|RDT&E\s+Project\s+Justification/i;
  const pe = /\bPE\s+([0-9]{7}[A-Z][A-Z0-9]*)\b/i;
  const project = /\bproject\s+code\s*[:.\-]?\s*(\S+(?:\s+\S+)*)/i;
  const groups: R2aProjectPageGroup[] = [];
  let activeKey: string | null = null;
  let activePe = '';
  let activeProject = '';
  let activePages: RdteCycleDocumentInputV1['pages'][number][] = [];
  const flush = () => {
    if (!activeKey) return;
    groups.push({ parentPeCode: activePe, projectCode: activeProject, pages: activePages });
    activeKey = null;
    activePages = [];
  };
  for (const page of pages) {
    const texts = [page.text ?? '', ...page.blocks.map((block) => block.text)];
    if (!texts.some((text) => marker.test(text))) continue;
    const peCode = texts.map((text) => pe.exec(text)?.[1]).find(Boolean) ?? '';
    const projectCode = texts.map((text) => project.exec(text)?.[1]?.trim()).find(Boolean) ?? '';
    const key = `${peCode}|${projectCode}`;
    if (key === activeKey) activePages.push(page);
    else {
      flush();
      activeKey = key;
      activePe = peCode;
      activeProject = projectCode;
      activePages = [page];
    }
  }
  flush();
  return groups;
}

function buildSemanticArtifact(input: {
  documentInput: RdteCycleDocumentInputV1;
  fiscalYear: number;
}): DefenseBudgetExtractionArtifactV1 {
  const value = input.documentInput;
  const exhibit = value.document.exhibit;

  if (exhibit === 'R-1') {
    return buildR1Artifact({
      source: value.source,
      parserRuns: value.parserRuns,
      extraction: extractR1FromPages({ pages: value.pages, cycleFiscalYear: input.fiscalYear }),
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

    const projects = extractR2aProjectsFromPages({ pages: value.pages });
    const projectFunding = r2aGroups(value.pages).map((group) =>
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
    const funding = r2aGroups(value.pages).map((group) =>
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
