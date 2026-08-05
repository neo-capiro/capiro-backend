import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ArtifactBuilderV1,
  assertionIdV1,
  evidenceIdV1,
  factIdV1,
  parserRunIdV1,
} from '../../contracts/artifact-builders.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
} from '../../contracts/extraction-artifact-v1.js';
import { sha256Bytes } from '../../contracts/canonical-json.js';
import {
  computeRdteCycleBundleContentSha256,
  rdteCycleBundleV1Schema,
} from '../rdte-cycle-bundle-v1.js';
import { planProofBoundRdteCanonicalProjection } from '../projection/rdte-proof-bound-projection-planner-v1.js';
import { buildR2aProjectArtifact } from '../r2a/r2a-artifact-builder-v1.js';
import { extractR2aProjectsFromPages } from '../r2a/r2a-project-extractor-v1.js';
import type { R2aProjectExtractionResult } from '../r2a/r2a-project-extractor-v1.js';
import type { R2aProjectFundingExtractionResult } from '../r2a/r2a-project-funding-extractor-v1.js';
import { buildR3PerformerArtifact } from '../r3/r3-artifact-builder-v1.js';
import type { R3ExtractionResult } from '../r3/r3-table-extractor-v1.js';
import type { ParserPageResultV1 } from '../../parser-router/parser-runtime-contract-v1.js';

const SHA = 'f'.repeat(64);
const MANIFEST_SHA = 'a'.repeat(64);
const POLICY_SHA = 'b'.repeat(64);
const PE = '0601101A';
const FY = 2027;

function source(exhibit: ExtractionSourceV1['exhibit'], key: string): ExtractionSourceV1 {
  return {
    manifestDocumentKey: key,
    sourceDocumentId: `source-${key}`,
    sourcePdfSha256: SHA,
    sourceLocator: `/fixtures/${key}.pdf`,
    fiscalYear: FY,
    family: 'rdte',
    exhibit,
    authority: 'dod-comptroller',
    component: 'DW',
    budgetCycle: `pb_fy${FY}`,
    documentType: 'pb_exhibit',
  };
}

function artifactByteSha(artifact: DefenseBudgetExtractionArtifactV1): string {
  return sha256Bytes(Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8'));
}

function certifiedBundle(artifact: DefenseBudgetExtractionArtifactV1) {
  const artifactByteSha256 = artifactByteSha(artifact);
  const candidateId = `candidate-${artifact.source.manifestDocumentKey}`;
  const runId = `run-${artifact.source.manifestDocumentKey}`;
  const withoutHash = {
    schemaVersion: 'rdte_cycle_bundle_v1' as const,
    cycleId: 'negative-control-cycle',
    fiscalYear: FY,
    manifestContentSha256: MANIFEST_SHA,
    sourceDocuments: [
      {
        manifestDocumentKey: artifact.source.manifestDocumentKey,
        sourceDocumentId: artifact.source.sourceDocumentId!,
        exhibitRole: 'r1_catalog' as const,
        required: true,
        sourcePdfSha256: SHA,
        sourceLocator: artifact.source.sourceLocator,
        pageCount: 1,
        parserRunIds: artifact.parserRuns.map((run) => run.parserRunId),
        unresolvedPages: [],
      },
    ],
    artifacts: [
      {
        manifestDocumentKey: artifact.source.manifestDocumentKey,
        artifactId: artifact.artifactId,
        artifactContentSha256: artifact.contentSha256,
        artifactByteSha256,
      },
    ],
    verifications: [
      {
        manifestDocumentKey: artifact.source.manifestDocumentKey,
        manifestContentSha256: MANIFEST_SHA,
        artifactId: artifact.artifactId,
        artifactContentSha256: artifact.contentSha256,
        artifactByteSha256,
        candidateId,
        verificationRunId: runId,
        policySha256: POLICY_SHA,
        sourceDocumentId: artifact.source.sourceDocumentId!,
        sourcePdfSha256: SHA,
        phase2Decision: 'PASS' as const,
        status: 'VERIFICATION_PASSED' as const,
        acceptedAssertionIds: artifact.assertions.map((value) => value.assertionId),
        rejectedAssertionIds: [],
        verificationCandidateId: candidateId,
        decision: 'VERIFICATION_PASSED' as const,
        decisionId: runId,
      },
    ],
    comparisons: [],
    coverage: [],
    projectionPlanContentSha256: 'c'.repeat(64),
    certification: 'CERTIFIED_RDTE_READY_FOR_PROJECTION' as const,
    blockingFindings: [],
    nonBlockingFindings: [],
  };
  return rdteCycleBundleV1Schema.parse({
    ...withoutHash,
    contentSha256: computeRdteCycleBundleContentSha256(withoutHash),
  });
}

describe('Phase 4 negative-control probes', () => {
  it('NC4: historical context never maps to a canonical stage', () => {
    const value = source('R-1', 'nc4');
    const builder = new ArtifactBuilderV1(value);
    const runId = parserRunIdV1({ key: 'nc4' });
    builder.addParserRun({
      parserRunId: runId,
      method: 'deterministic_pdfplumber',
      parserVersion: 'test',
      parserConfigSha256: 'd'.repeat(64),
      inputSourceSha256: SHA,
      outputArtifactSha256: 'e'.repeat(64),
      pageRanges: [{ startPage: 1, endPage: 1 }],
    });
    const evidenceId = evidenceIdV1({ key: 'nc4' });
    const factId = factIdV1({ key: 'nc4' });
    builder.addEvidence({
      evidenceId,
      sourcePdfSha256: SHA,
      parserRunId: runId,
      granularity: 'page_only',
      page: 1,
    });
    builder.addSourceFact({
      factId,
      sourcePath: 'nc4/prior-actual',
      category: 'money',
      requiredForCompleteness: true,
      rawValue: '90',
      evidenceIds: [evidenceId],
    });
    builder.addAssertion({
      assertionKind: 'document_fact',
      assertionId: assertionIdV1({ key: 'nc4' }),
      sourceFactIds: [factId],
      evidenceIds: [evidenceId],
      confidence: 1,
      fieldName: 'r1_prior_actual_context',
      value: {
        peCode: PE,
        fiscalYear: 2026,
        columnRole: 'prior_actual_context',
        disposition: 'contextual_only',
        originalValue: '90',
        originalUnit: 'millions',
        valueMillions: '90',
        positionCycle: `pb_fy${FY}`,
        direct: true,
      },
    });
    const artifact = builder.finalize();
    const { plan } = planProofBoundRdteCanonicalProjection({
      bundle: certifiedBundle(artifact),
      artifacts: [artifact],
    });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.exclusions.some((entry) => entry.reason === 'contextual_only_value')).toBe(true);
  });

  it('NC8: every printed R-2A project money fact is required', () => {
    const projects: R2aProjectExtractionResult[] = [
      {
        identities: [
          {
            parentPeCode: PE,
            projectCode: 'A1',
            title: 'Advanced Radar',
            pages: [5],
            printedPages: ['5'],
            aliases: [],
          },
        ],
        narratives: [],
        conflicts: [],
        omissions: [],
        blocked: [],
      },
    ];
    const funding: R2aProjectFundingExtractionResult[] = [
      {
        parentPeCode: PE,
        projectCode: 'A1',
        values: [
          {
            parentPeCode: PE,
            projectCode: 'A1',
            rowKind: 'project',
            fiscalYear: FY,
            columnRole: 'budget_year_request',
            disposition: 'project_budget_position',
            originalValue: '7',
            originalUnit: 'millions',
            valueMillions: '7',
            page: 6,
            tableIndex: 0,
            rowIndex: 1,
            columnIndex: 1,
            headerText: 'FY 2027 Request',
            direct: true,
            positionCycle: `pb_fy${FY}`,
          },
        ],
        omissions: [],
        unitResolution: { status: 'resolved', unit: 'millions', reason: 'caption' } as never,
        usedPositionalFallback: false,
      },
    ];
    const artifact = buildR2aProjectArtifact({
      source: source('R-2A', 'nc8'),
      parserRuns: [],
      projects,
      funding,
      cycleFiscalYear: FY,
    });
    const moneyFacts = artifact.sourceFacts.filter((fact) => fact.category === 'money');
    expect(moneyFacts.length).toBeGreaterThan(0);
    expect(moneyFacts.every((fact) => fact.requiredForCompleteness)).toBe(true);
    expect(artifact.summary.uncoveredRequiredSourceFactCount).toBe(0);
  });

  it('NC12: R-3 total cost never becomes annual funding', () => {
    const extractions: R3ExtractionResult[] = [
      {
        peCode: PE,
        performers: [
          {
            parentPeCode: PE,
            performerName: 'Lockheed Martin',
            performerNormalized: 'LOCKHEED MARTIN',
            performerRole: 'PERFORMING_ACTIVITY',
            roleExplicit: false,
            location: 'Bethesda, MD',
            contractMethod: 'C/CPFF',
            costCategory: 'Radar Development',
            fiscalYear: FY,
            totalCost: {
              originalValue: '250',
              originalUnit: 'millions',
              valueMillions: '250',
            },
            page: 8,
            tableIndex: 0,
            rowIndex: 1,
            naturalKey: `${PE}|LOCKHEED MARTIN|Bethesda, MD|C/CPFF|Radar Development|${FY}`,
            rawCells: [],
          },
        ],
        omissions: [],
        conflicts: [],
        unitResolution: { status: 'resolved', unit: 'millions', reason: 'caption' } as never,
        tableDetected: true,
      },
    ];
    const artifact = buildR3PerformerArtifact({
      source: source('R-3', 'nc12'),
      parserRuns: [],
      extractions,
      cycleFiscalYear: FY,
    });
    expect(artifact.assertions.some((value) => value.assertionKind === 'funding')).toBe(false);
    expect(artifact.assertions.some((value) => value.assertionKind === 'project_funding')).toBe(
      false,
    );
  });

  it('NC19: a source-faithful project code is never truncated', () => {
    const projectCode = 'AB-12.34';
    const page: ParserPageResultV1 = {
      page: 1,
      text: 'RDT&E Project Justification',
      blocks: [
        { blockIndex: 0, blockType: 'header', text: 'RDT&E Project Justification' },
        { blockIndex: 1, blockType: 'heading', text: `PE ${PE}` },
        { blockIndex: 2, blockType: 'text', text: `Project Code: ${projectCode}` },
        { blockIndex: 3, blockType: 'text', text: 'Project Title: Long Code Project' },
      ],
      tables: [],
      images: [],
      evidencePrecision: 'page_only',
      warnings: [],
    };
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities[0]?.projectCode).toBe(projectCode);
    expect(result.blocked).toHaveLength(0);
  });

  it('NC20: the reviewed migration retains project-position uniqueness', () => {
    const migration = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../../prisma/migrations/20260817010000_rdte_phase4_projection_schema/migration.sql',
      ),
      'utf8',
    );
    // Strip SQL line/block comments before destructive-op scans so prose like
    // "truncated" / "no data deleted" in comments cannot false-positive TRUNCATE/DELETE.
    const sqlBody = migration.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n\r]*/g, ' ');
    expect(migration).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+"program_element_project_budget_position_natural_key"/i,
    );
    expect(sqlBody).not.toMatch(/\bDROP\s+TABLE\b|\bDELETE\s+FROM\b|\bTRUNCATE\b/i);
  });
});
