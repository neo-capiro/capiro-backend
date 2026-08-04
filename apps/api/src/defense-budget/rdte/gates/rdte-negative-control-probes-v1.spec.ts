/**
 * rdte-negative-control-probes-v1.spec — invariant probes referenced by the
 * Phase 4 negative-control runner (verify-pe-budget-phase-4-negative-
 * controls.ts). Each probe is a REAL test over production modules; the
 * runner injects a defect, confirms the probe fails, reverts, and confirms
 * green.
 *
 * Probes:
 *   NC4  historical enacted context never maps to a canonical stage;
 *   NC8  R-2A project funding facts are required for completeness (a
 *        silently dropped fact must fail artifact finalization);
 *   NC12 R-3 total cost never becomes annual funding;
 *   NC19 long project codes are never truncated;
 *   NC20 the project-position natural-key constraint exists in the
 *        reviewed migration.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { planRdteCanonicalProjection } from '../projection/rdte-projection-planner-v1.js';
import type { RdteCycleVerificationRefV1 } from '../rdte-cycle-bundle-v1.js';
import { reconcileRdteCycle } from '../reconciliation/rdte-cycle-reconciler-v1.js';
import { certifyRdteCycle } from '../reconciliation/rdte-cycle-certifier-v1.js';
import {
  ArtifactBuilderV1,
  assertionIdV1,
  evidenceIdV1,
  factIdV1,
  parserRunIdV1,
} from '../../contracts/artifact-builders.js';
import type { ExtractionSourceV1 } from '../../contracts/extraction-artifact-v1.js';
import { buildR2aProjectArtifact } from '../r2a/r2a-artifact-builder-v1.js';
import { buildR3PerformerArtifact } from '../r3/r3-artifact-builder-v1.js';
import type { R2aProjectExtractionResult } from '../r2a/r2a-project-extractor-v1.js';
import type { R2aProjectFundingExtractionResult } from '../r2a/r2a-project-funding-extractor-v1.js';
import type { R3ExtractionResult } from '../r3/r3-table-extractor-v1.js';
import { extractR2aProjectsFromPages } from '../r2a/r2a-project-extractor-v1.js';
import type { ParserPageResultV1 } from '../../parser-router/parser-runtime-contract-v1.js';

const SHA = 'f'.repeat(64);
const PE1 = '0601101A';
const CYCLE_FY = 2027;

function makeSource(exhibit: ExtractionSourceV1['exhibit'], key: string): ExtractionSourceV1 {
  return {
    manifestDocumentKey: key,
    sourcePdfSha256: SHA,
    sourceLocator: `fixture://${key}.pdf`,
    fiscalYear: CYCLE_FY,
    family: 'rdte',
    exhibit,
    authority: 'dod-comptroller',
    component: 'DW',
    budgetCycle: 'pb',
    documentType: 'pb_exhibit',
  };
}

/* ------------------------------------------------------------------ */
/* NC4 — historical context never becomes a canonical stage            */
/* ------------------------------------------------------------------ */

function certifiedBundleWithArtifact(artifact: {
  artifactId: string;
  contentSha256: string;
  source: ExtractionSourceV1;
}) {
  const reconciliation = reconcileRdteCycle({
    identity: { r1PeCodes: [PE1], otherExhibitPeCodes: [PE1] },
    fundingComparisons: [],
    projectSumReconciliations: [],
    projectRelationships: { projects: [], projectFundingKeys: [] },
    coverageInputs: [],
  });
  const verifications: RdteCycleVerificationRefV1[] = [
    {
      manifestDocumentKey: artifact.source.manifestDocumentKey,
      artifactId: artifact.artifactId,
      verificationCandidateId: 'cand',
      verificationRunId: 'run',
      decision: 'VERIFICATION_PASSED',
      decisionId: 'dec',
    },
  ];
  return certifyRdteCycle({
    cycleIdIdentity: { fy: CYCLE_FY },
    fiscalYear: CYCLE_FY,
    manifestContentSha256: SHA,
    sourceDocuments: [
      {
        manifestDocumentKey: artifact.source.manifestDocumentKey,
        exhibitRole: 'r1_catalog',
        required: true,
        sourcePdfSha256: SHA,
        sourceLocator: artifact.source.sourceLocator,
      },
    ],
    artifacts: [
      {
        manifestDocumentKey: artifact.source.manifestDocumentKey,
        artifactId: artifact.artifactId,
        artifactContentSha256: artifact.contentSha256,
      },
    ],
    verifications,
    comparisons: [],
    reconciliation,
  });
}

describe('negative-control probes', () => {
  it('NC4: historical prior-actual context never maps to a canonical stage', () => {
    const source = makeSource('R-1', 'nc4');
    const builder = new ArtifactBuilderV1(source);
    builder.addParserRun({
      parserRunId: parserRunIdV1({ source: SHA, key: 'nc4' }),
      method: 'manual',
      parserVersion: 'nc4',
      parserConfigSha256: SHA,
      inputSourceSha256: SHA,
      outputArtifactSha256: SHA,
      pageRanges: [],
    });
    const evidenceId = evidenceIdV1({ peCode: PE1, kind: 'nc4' });
    builder.addEvidence({
      evidenceId,
      sourcePdfSha256: SHA,
      parserRunId: parserRunIdV1({ source: SHA, key: 'nc4' }),
      granularity: 'page_only',
      page: 1,
    });
    const factId = factIdV1({ peCode: PE1, kind: 'nc4_fact' });
    builder.addSourceFact({
      factId,
      sourcePath: `pe:${PE1}/fy:2026/nc4`,
      category: 'money',
      requiredForCompleteness: true,
      rawValue: '90',
      evidenceIds: [evidenceId],
    });
    builder.addAssertion({
      assertionKind: 'document_fact',
      assertionId: assertionIdV1({ peCode: PE1, kind: 'nc4_prior_actual' }),
      sourceFactIds: [factId],
      evidenceIds: [evidenceId],
      confidence: 1,
      fieldName: 'r1_prior_actual_context',
      value: {
        peCode: PE1,
        fiscalYear: 2026,
        columnRole: 'prior_actual_context',
        disposition: 'contextual_only',
        originalValue: '90',
        originalUnit: 'millions',
        valueMillions: '90',
        positionCycle: `pb_fy${CYCLE_FY}`,
        headerText: 'FY 2026 Actual',
        direct: true,
      },
    });
    const artifact = builder.finalize();

    const certified = certifiedBundleWithArtifact(artifact);
    expect(certified.certification).toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');

    const { plan } = planRdteCanonicalProjection({
      bundle: certified.bundle,
      artifacts: [artifact],
    });

    /* No ProgramElementYear candidate may carry the historical value, and no
     * candidate of any target may adopt field enacted/executed from it. */
    for (const candidate of plan.candidates) {
      expect(candidate.values.enacted).toBeUndefined();
      expect(candidate.values.executed).toBeUndefined();
      if (candidate.target === 'ProgramElementYear') {
        expect(candidate.values.request ?? null).toBeNull();
      }
    }
    expect(
      plan.exclusions.some(
        (e) => e.reason === 'contextual_only_value' && e.artifactId === artifact.artifactId,
      ),
    ).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /* NC8 — a dropped project money fact must fail completeness           */
  /* ------------------------------------------------------------------ */

  it('NC8: R-2A project funding facts are required for completeness', () => {
    const projects: R2aProjectExtractionResult[] = [
      {
        identities: [
          {
            parentPeCode: PE1,
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
        parentPeCode: PE1,
        projectCode: 'A1',
        values: [
          {
            parentPeCode: PE1,
            projectCode: 'A1',
            rowKind: 'project',
            fiscalYear: CYCLE_FY,
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
            positionCycle: `pb_fy${CYCLE_FY}`,
          },
        ],
        omissions: [],
        unitResolution: { status: 'resolved', unit: 'millions', reason: 'caption' } as never,
        usedPositionalFallback: false,
      },
    ];
    const artifact = buildR2aProjectArtifact({
      source: makeSource('R-2A', 'nc8'),
      parserRuns: [],
      projects,
      funding,
      cycleFiscalYear: CYCLE_FY,
    });

    const moneyFacts = artifact.sourceFacts.filter((f) => f.category === 'money');
    expect(moneyFacts.length).toBeGreaterThan(0);
    /* Every printed project money value is REQUIRED for completeness: if the
     * extractor dropped one silently, the artifact's completeness ledger
     * (required - covered - omitted) would show an uncovered fact and
     * finalize() would reject it. */
    for (const fact of moneyFacts) {
      expect(fact.requiredForCompleteness).toBe(true);
    }
    expect(artifact.summary.uncoveredRequiredSourceFactCount).toBe(0);
  });

  /* ------------------------------------------------------------------ */
  /* NC12 — R-3 total cost never becomes annual funding                  */
  /* ------------------------------------------------------------------ */

  it('NC12: R-3 total cost never becomes PE/project annual funding', () => {
    const extractions: R3ExtractionResult[] = [
      {
        peCode: PE1,
        performers: [
          {
            parentPeCode: PE1,
            performerName: 'Lockheed Martin',
            performerNormalized: 'LOCKHEED MARTIN',
            performerRole: 'PERFORMING_ACTIVITY',
            roleExplicit: false,
            location: 'Bethesda, MD',
            contractMethod: 'C/CPFF',
            costCategory: 'Radar Development',
            fiscalYear: CYCLE_FY,
            totalCost: { originalValue: '250', originalUnit: 'millions', valueMillions: '250' },
            page: 8,
            tableIndex: 0,
            rowIndex: 1,
            naturalKey: `${PE1}|LOCKHEED MARTIN|Bethesda, MD|C/CPFF|Radar Development|${CYCLE_FY}`,
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
      source: makeSource('R-3', 'nc12'),
      parserRuns: [],
      extractions,
      cycleFiscalYear: CYCLE_FY,
    });

    /* No funding assertion and no annual money document fact may carry the
     * R-3 total cost — it is a cost-analysis fact on the performer row. */
    expect(artifact.assertions.filter((a) => a.assertionKind === 'funding')).toHaveLength(0);
    expect(artifact.assertions.filter((a) => a.assertionKind === 'project_funding')).toHaveLength(
      0,
    );
    for (const assertion of artifact.assertions) {
      if (assertion.assertionKind === 'document_fact') {
        const value = assertion.value as Record<string, unknown>;
        expect(value.valueMillions ?? null).toBeNull();
      }
    }
  });

  /* ------------------------------------------------------------------ */
  /* NC19 — long project codes are never truncated                       */
  /* ------------------------------------------------------------------ */

  it('NC19: a long source-faithful project code is preserved verbatim', () => {
    const longCode = 'AB-12.34';
    const page: ParserPageResultV1 = {
      page: 1,
      text: 'RDT&E Project Justification',
      blocks: [
        { blockIndex: 0, blockType: 'header', text: 'RDT&E Project Justification' },
        { blockIndex: 1, blockType: 'heading', text: `PE ${PE1}` },
        { blockIndex: 2, blockType: 'text', text: `Project Code: ${longCode}` },
        { blockIndex: 3, blockType: 'text', text: 'Project Title: Long Code Project' },
      ],
      tables: [],
      images: [],
      evidencePrecision: 'page_only',
      warnings: [],
    };
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities).toHaveLength(1);
    /* Verbatim — never truncated to fit a legacy column width. */
    expect(result.identities[0]?.projectCode).toBe(longCode);
    expect(result.blocked).toHaveLength(0);
  });

  /* ------------------------------------------------------------------ */
  /* NC20 — project-position natural-key constraint in the migration     */
  /* ------------------------------------------------------------------ */

  it('NC20: the reviewed migration keeps the project-position natural key', () => {
    const migrationPath = path.resolve(
      __dirname,
      '../../../../prisma/migrations/20260817010000_rdte_phase4_projection_schema/migration.sql',
    );
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toContain('program_element_project_budget_position_natural_key');
    expect(sql).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+"program_element_project_budget_position_natural_key"\s+ON\s+"program_element_project_budget_position"\s*\(\s*"pe_code",\s*"project_code",\s*"position_cycle",\s*"asserted_fy",\s*"value_kind"\s*\)/i,
    );
    /* The widening must be expansive only. */
    expect(sql).toMatch(/ALTER\s+COLUMN\s+"project_code"\s+TYPE\s+VARCHAR\s*\(\s*32\s*\)/i);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
  });
});
