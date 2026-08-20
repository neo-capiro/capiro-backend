/**
 * Artifact builder smoke specs for the WS M/N cycle builders:
 *   - r2a-artifact-builder-v1 (project identity + funding dispositions);
 *   - r3-artifact-builder-v1 (role-honest performers, totalCost fact);
 *   - r4-artifact-builder-v1 (exact dates only, period metadata preserved).
 */
import { describe, it, expect } from '@jest/globals';
import type { ExtractionSourceV1 } from '../../contracts/extraction-artifact-v1.js';
import { buildR2aProjectArtifact } from './r2a-artifact-builder-v1.js';
import { buildR3PerformerArtifact } from '../r3/r3-artifact-builder-v1.js';
import { buildR4MilestoneArtifact } from '../r4/r4-artifact-builder-v1.js';
import type { R2aProjectExtractionResult } from './r2a-project-extractor-v1.js';
import type { R2aProjectFundingExtractionResult } from './r2a-project-funding-extractor-v1.js';
import type { R3ExtractionResult } from '../r3/r3-table-extractor-v1.js';
import type { R4ExtractionResult } from '../r4/r4-extractor-v1.js';

const SHA = 'c'.repeat(64);
const PE1 = '0601101A';
const CYCLE_FY = 2027;

function makeSource(exhibit: ExtractionSourceV1['exhibit'], key: string): ExtractionSourceV1 {
  return {
    manifestDocumentKey: key,
    sourcePdfSha256: SHA,
    sourceLocator: `s3://bucket/${key}.pdf`,
    sourceUrl: `https://example.com/${key}.pdf`,
    fiscalYear: CYCLE_FY,
    family: 'rdte',
    exhibit,
    authority: 'dod-comptroller',
    component: 'AF',
    budgetCycle: 'pb',
    documentType: 'rdte_exhibit',
  };
}

/* ------------------------------------------------------------------ */
/* R-2A builder                                                        */
/* ------------------------------------------------------------------ */

describe('buildR2aProjectArtifact', () => {
  const projects: R2aProjectExtractionResult[] = [
    {
      identities: [
        {
          parentPeCode: PE1,
          projectCode: 'A1',
          title: 'Advanced Radar',
          pages: [5, 6],
          printedPages: ['5', '6'],
          budgetActivity: '3',
          aliases: ['Advanced Radar (Updated)'],
        },
      ],
      narratives: [
        { parentPeCode: PE1, projectCode: 'A1', kind: 'mission', text: 'Develop radar.', page: 5 },
        {
          parentPeCode: PE1,
          projectCode: 'A1',
          kind: 'accomplishments',
          text: 'Built prototype.',
          page: 6,
        },
      ],
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
          originalValue: '60',
          originalUnit: 'millions',
          valueMillions: '60',
          page: 6,
          tableIndex: 0,
          rowIndex: 2,
          columnIndex: 1,
          headerText: 'FY 2027',
          direct: true,
          positionCycle: `pb_fy${CYCLE_FY}`,
        },
        {
          parentPeCode: PE1,
          projectCode: 'A1',
          rowKind: 'project',
          fiscalYear: CYCLE_FY - 1,
          columnRole: 'prior_actual_context',
          disposition: 'contextual_only',
          originalValue: '55',
          originalUnit: 'millions',
          valueMillions: '55',
          page: 6,
          tableIndex: 0,
          rowIndex: 2,
          columnIndex: 0,
          headerText: 'FY 2026 Actual',
          direct: true,
          positionCycle: `pb_fy${CYCLE_FY}`,
        },
      ],
      omissions: [],
      unitResolution: { status: 'resolved', unit: 'millions', reason: 'caption' } as never,
      usedPositionalFallback: false,
    },
  ];

  it('projects identity + mission, and maps funding dispositions truthfully', () => {
    const artifact = buildR2aProjectArtifact({
      source: makeSource('R-2A', 'r2a'),
      parserRuns: [],
      projects,
      funding,
      cycleFiscalYear: CYCLE_FY,
    });

    const projectAssertions = artifact.assertions.filter((a) => a.assertionKind === 'project');
    expect(projectAssertions).toHaveLength(1);
    expect(projectAssertions[0]).toMatchObject({
      parentPeCode: PE1,
      projectCode: 'A1',
      title: 'Advanced Radar',
      mission: 'Develop radar.',
    });

    const projectFunding = artifact.assertions.filter((a) => a.assertionKind === 'project_funding');
    expect(projectFunding).toHaveLength(1);
    expect(projectFunding[0]).toMatchObject({
      assertionKind: 'project_funding',
      parentPeCode: PE1,
      projectCode: 'A1',
      fiscalYear: CYCLE_FY,
      field: 'request',
    });
    expect((projectFunding[0] as { metadata?: Record<string, unknown> }).metadata).toMatchObject({
      disposition: 'project_budget_position',
      positionCycle: `pb_fy${CYCLE_FY}`,
    });

    /* Contextual value preserved as document fact, never project_funding. */
    const docFacts = artifact.assertions.filter((a) => a.assertionKind === 'document_fact');
    expect(
      docFacts.some((f) => (f as { fieldName?: string }).fieldName === 'r2a_prior_actual_context'),
    ).toBe(true);

    /* Accomplishments narrative preserved as a document fact. */
    expect(
      docFacts.some(
        (f) => (f as { fieldName?: string }).fieldName === 'r2a_project_narrative_accomplishments',
      ),
    ).toBe(true);

    /* Title alias preserved. */
    expect(
      docFacts.some((f) => (f as { fieldName?: string }).fieldName === 'r2a_project_title_alias'),
    ).toBe(true);

    /* Determinism. */
    const again = buildR2aProjectArtifact({
      source: makeSource('R-2A', 'r2a'),
      parserRuns: [],
      projects,
      funding,
      cycleFiscalYear: CYCLE_FY,
    });
    expect(again.artifactId).toBe(artifact.artifactId);
    expect(again.contentSha256).toBe(artifact.contentSha256);
  });

  it('blocked projects become blocking omissions', () => {
    const blockedProjects: R2aProjectExtractionResult[] = [
      {
        identities: [],
        narratives: [],
        conflicts: [],
        omissions: [],
        blocked: [{ projectCode: 'ZZ', page: 7, reason: 'missing_parent_pe' }],
      },
    ];
    const artifact = buildR2aProjectArtifact({
      source: makeSource('R-2A', 'r2a'),
      parserRuns: [],
      projects: blockedProjects,
      cycleFiscalYear: CYCLE_FY,
    });
    expect(artifact.omissions).toHaveLength(1);
    expect(artifact.omissions[0]?.severity).toBe('blocking');
  });
});

/* ------------------------------------------------------------------ */
/* R-3 builder                                                         */
/* ------------------------------------------------------------------ */

describe('buildR3PerformerArtifact', () => {
  it('emits role-honest performer assertions with cost-analysis semantics', () => {
    const extractions: R3ExtractionResult[] = [
      {
        peCode: PE1,
        performers: [
          {
            parentPeCode: PE1,
            performerName: 'LOCKHEED MARTIN CORPORATION',
            performerNormalized: 'LOCKHEED MARTIN',
            performerRole: 'PERFORMING_ACTIVITY',
            roleExplicit: false,
            isNamedCompany: true,
            location: 'AL',
            contractMethod: 'C/CPAF',
            costCategory: 'Radar Development',
            fiscalYear: CYCLE_FY,
            totalCost: { originalValue: '250', originalUnit: 'millions', valueMillions: '250' },
            page: 8,
            tableIndex: 0,
            rowIndex: 1,
            naturalKey: `${PE1}|LOCKHEED MARTIN|AL|C/CPAF|Radar Development|${CYCLE_FY}`,
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
      source: makeSource('R-3', 'r3'),
      parserRuns: [],
      extractions,
      cycleFiscalYear: CYCLE_FY,
    });

    const performers = artifact.assertions.filter((a) => a.assertionKind === 'performer');
    expect(performers).toHaveLength(1);
    expect(performers[0]).toMatchObject({
      performerRole: 'PERFORMING_ACTIVITY',
      performerName: 'LOCKHEED MARTIN CORPORATION',
      fiscalYear: CYCLE_FY,
    });
    const metadata = (performers[0] as { metadata?: Record<string, unknown> }).metadata;
    expect(metadata).toMatchObject({ roleExplicit: false, exhibit: 'R-3' });

    /* totalCost rides on the performer assertion as a cost-analysis fact —
     * no funding/document_fact annual-value assertion exists. */
    expect(artifact.assertions.filter((a) => a.assertionKind === 'funding')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* R-4 builder                                                         */
/* ------------------------------------------------------------------ */

describe('buildR4MilestoneArtifact', () => {
  it('carries exact dates only and preserves structured periods in metadata', () => {
    const extractions: R4ExtractionResult[] = [
      {
        peCode: PE1,
        milestones: [
          {
            parentPeCode: PE1,
            milestoneType: 'CDR',
            plannedPeriod: {
              kind: 'exact_date',
              rawText: 'Jan 15, 2027',
              exactDate: '2027-01-15',
              year: 2027,
              month: 1,
              confidence: 1,
            },
            page: 10,
            tableIndex: 0,
            rowIndex: 1,
            rawCells: [],
          },
          {
            parentPeCode: PE1,
            milestoneType: 'IOC',
            plannedPeriod: {
              kind: 'fiscal_quarter',
              rawText: '3Q FY2028',
              fiscalYear: 2028,
              fiscalQuarter: 3,
              confidence: 1,
            },
            page: 10,
            tableIndex: 0,
            rowIndex: 2,
            rawCells: [],
          },
        ],
        omissions: [],
        tableDetected: true,
      },
    ];
    const artifact = buildR4MilestoneArtifact({
      source: makeSource('R-4', 'r4'),
      parserRuns: [],
      extractions,
    });

    const milestones = artifact.assertions.filter((a) => a.assertionKind === 'milestone');
    expect(milestones).toHaveLength(2);

    const cdr = milestones.find((m) => m.milestoneType === 'CDR');
    expect(cdr?.plannedDate).toBe('2027-01-15');

    const ioc = milestones.find((m) => m.milestoneType === 'IOC');
    expect(ioc?.plannedDate).toBeUndefined();
    const metadata = (ioc as { metadata?: Record<string, unknown> }).metadata;
    expect(metadata?.plannedPeriod).toMatchObject({
      kind: 'fiscal_quarter',
      rawText: '3Q FY2028',
      fiscalYear: 2028,
      fiscalQuarter: 3,
    });

    /* All milestone rows are required source facts (asserted). */
    expect(
      artifact.sourceFacts.filter((f) => f.category === 'milestone' && f.requiredForCompleteness),
    ).toHaveLength(2);
  });
});
