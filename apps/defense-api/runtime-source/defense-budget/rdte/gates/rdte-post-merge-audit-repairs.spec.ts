import { describe, expect, it, jest } from '@jest/globals';
import { ArtifactBuilderV1 } from '../../contracts/artifact-builders.js';
import type {
  DefenseBudgetAssertionV1,
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
  ParserRunV1,
} from '../../contracts/extraction-artifact-v1.js';
import { mergeRdteArtifactsV1 } from '../cycle/merge-rdte-artifacts-v1.js';
import { buildR1Artifact } from '../r1/r1-artifact-builder-v1.js';
import type { R1ExtractionResult } from '../r1/r1-extractor-v1.js';
import { buildR4MilestoneArtifact } from '../r4/r4-artifact-builder-v1.js';
import type { R4ExtractionResult } from '../r4/r4-extractor-v1.js';
import { proofBoundRdteCanonicalProjectionPlanV1Schema } from '../projection/rdte-canonical-projection-plan-v1.js';
import { normalizeMilestoneProjection } from '../projection/rdte-proof-bound-projection-planner-v1.js';
import { parseParserProfileJobV1 } from '../../parser-router/profile-runtime-contract-v1.js';
import { CumulativePaidPageLlamaParseClient } from '../../parser-router/cumulative-paid-parse-client-v1.js';
import type { FetchLike } from '../../llamaparse.client.js';

const SOURCE_SHA = 'a'.repeat(64);
const CONFIG_SHA = 'b'.repeat(64);
const OUTPUT_SHA = 'c'.repeat(64);

const source: ExtractionSourceV1 = {
  manifestDocumentKey: 'audit-rdte',
  sourceDocumentId: 'source-document-audit',
  sourcePdfSha256: SOURCE_SHA,
  sourceLocator: '/tmp/audit.pdf',
  fiscalYear: 2027,
  family: 'rdte',
  exhibit: 'R-1',
  authority: 'dod-comptroller',
  component: 'ARMY',
  budgetCycle: 'pb_fy2027',
  documentType: 'R-1',
};

function parserRun(id: string, startPage: number, endPage: number): ParserRunV1 {
  return {
    parserRunId: id,
    method: 'deterministic_pdfplumber',
    parserVersion: 'audit-v1',
    parserConfigSha256: CONFIG_SHA,
    inputSourceSha256: SOURCE_SHA,
    outputArtifactSha256: OUTPUT_SHA,
    pageRanges: [{ startPage, endPage }],
  };
}

function artifactWithExcerpt(excerpt: string): DefenseBudgetExtractionArtifactV1 {
  const builder = new ArtifactBuilderV1(source);
  builder.addParserRun(parserRun('run-shared', 1, 1));
  builder.addEvidence({
    evidenceId: 'evidence-shared',
    sourcePdfSha256: SOURCE_SHA,
    parserRunId: 'run-shared',
    granularity: 'page_only',
    page: 1,
    excerpt,
  });
  builder.addSourceFact({
    factId: `fact-${excerpt}`,
    sourcePath: `page:1/${excerpt}`,
    category: 'metadata',
    requiredForCompleteness: true,
    rawValue: excerpt,
    evidenceIds: ['evidence-shared'],
  });
  builder.addAssertion({
    assertionKind: 'document_fact',
    assertionId: `assertion-${excerpt}`,
    sourceFactIds: [`fact-${excerpt}`],
    evidenceIds: ['evidence-shared'],
    confidence: 1,
    fieldName: 'audit',
    value: excerpt,
  });
  return builder.finalize();
}

describe('post-merge Phase 1-4 audit repairs', () => {
  it('binds evidence to the unique parser run covering its physical page', () => {
    const builder = new ArtifactBuilderV1(source);
    builder.addParserRun(parserRun('run-page-1', 1, 1));
    builder.addParserRun(parserRun('run-page-2', 2, 2));
    builder.addEvidence({
      evidenceId: 'evidence-page-2',
      sourcePdfSha256: SOURCE_SHA,
      parserRunId: 'run-page-1',
      granularity: 'page_only',
      page: 2,
    });
    builder.addSourceFact({
      factId: 'fact-page-2',
      sourcePath: 'page:2',
      category: 'metadata',
      requiredForCompleteness: true,
      rawValue: 'page 2',
      evidenceIds: ['evidence-page-2'],
    });
    builder.addAssertion({
      assertionKind: 'document_fact',
      assertionId: 'assertion-page-2',
      sourceFactIds: ['fact-page-2'],
      evidenceIds: ['evidence-page-2'],
      confidence: 1,
      fieldName: 'page',
      value: 2,
    });

    const artifact = builder.finalize();
    expect(artifact.evidence[0]?.parserRunId).toBe('run-page-2');
  });

  it('registers a real R-1 source fact for every omission', () => {
    const extraction: R1ExtractionResult = {
      identities: [],
      funding: [],
      omissions: [
        {
          peCode: '0600000A',
          page: 1,
          rowIndex: 2,
          columnIndex: 4,
          reason: 'invalid_number',
          rawText: 'not-a-number',
        },
      ],
      conflicts: [],
      unitResolution: {
        status: 'resolved',
        unit: 'thousands',
        evidence: [],
      },
      usedPositionalFallback: false,
    } as unknown as R1ExtractionResult;

    const artifact = buildR1Artifact({
      source,
      parserRuns: [parserRun('run-r1', 1, 1)],
      extraction,
      cycleFiscalYear: 2027,
    });
    expect(artifact.omissions).toHaveLength(1);
    expect(
      artifact.sourceFacts.some((fact) => fact.factId === artifact.omissions[0]?.sourceFactId),
    ).toBe(true);
  });

  it('keeps repeated R-1 values from different source cells independently addressable', () => {
    const extraction: R1ExtractionResult = {
      identities: [
        {
          peCode: '0600000A',
          title: 'Audit PE',
          page: 1,
          tableIndex: 0,
          rowIndex: 1,
        },
      ],
      funding: [
        {
          peCode: '0600000A',
          fiscalYear: 2027,
          columnRole: 'budget_year_request',
          disposition: 'canonical_request_candidate',
          originalValue: '1000',
          originalUnit: 'thousands',
          valueMillions: '1',
          page: 1,
          tableIndex: 0,
          rowIndex: 1,
          columnIndex: 2,
          headerText: 'FY 2027 Request',
          direct: true,
        },
        {
          peCode: '0600000A',
          fiscalYear: 2027,
          columnRole: 'budget_year_request',
          disposition: 'canonical_request_candidate',
          originalValue: '1000',
          originalUnit: 'thousands',
          valueMillions: '1',
          page: 2,
          tableIndex: 0,
          rowIndex: 3,
          columnIndex: 2,
          headerText: 'FY 2027 Request',
          direct: true,
        },
      ],
      omissions: [],
      conflicts: [],
      unitResolution: {
        status: 'resolved',
        unit: 'thousands',
        evidence: [],
      },
      usedPositionalFallback: false,
    } as unknown as R1ExtractionResult;

    const artifact = buildR1Artifact({
      source,
      parserRuns: [parserRun('run-r1-pages', 1, 2)],
      extraction,
      cycleFiscalYear: 2027,
    });
    expect(artifact.assertions.filter((value) => value.assertionKind === 'funding')).toHaveLength(
      2,
    );
  });

  it('does not leak R-4 milestone indexing across PE extraction groups', () => {
    const extraction = (peCode: string, page: number): R4ExtractionResult => ({
      peCode,
      milestones: [
        {
          parentPeCode: peCode,
          milestoneType: `Milestone ${page}`,
          plannedPeriod: {
            kind: 'fiscal_year',
            rawText: 'FY2028',
            fiscalYear: 2028,
            confidence: 0.9,
          },
          page,
          tableIndex: 0,
          rowIndex: 1,
          rawCells: [{ columnIndex: 0, text: `Milestone ${page}` }],
        },
      ],
      omissions: [],
      tableDetected: true,
    });

    const artifact = buildR4MilestoneArtifact({
      source: { ...source, exhibit: 'R-4', documentType: 'R-4' },
      parserRuns: [parserRun('run-r4', 2, 5)],
      extractions: [extraction('0600000A', 2), extraction('0600001A', 5)],
    });
    expect(artifact.evidence.map((value) => value.page).sort()).toEqual([2, 5]);
  });

  it('rejects same-ID merge payloads that are not byte-identical', () => {
    expect(() =>
      mergeRdteArtifactsV1([artifactWithExcerpt('left'), artifactWithExcerpt('right')]),
    ).toThrow(/merge conflict.*evidenceId/i);
  });

  it('requires nonempty assertion-level proof bindings on production projection plans', () => {
    expect(() =>
      proofBoundRdteCanonicalProjectionPlanV1Schema.parse({
        schemaVersion: 'rdte_canonical_projection_plan_v1',
        cycleId: 'cycle',
        cycleBundleContentSha256: SOURCE_SHA,
        cycleCertification: 'CERTIFIED_RDTE_READY_FOR_PROJECTION',
        fiscalYear: 2027,
        positionCycle: 'pb_fy2027',
        candidates: [
          {
            candidateId: 'candidate',
            target: 'ProgramElementSource',
            naturalKey: 'key',
            operation: 'insert',
            reason: 'audit',
            artifactId: 'artifact',
            artifactContentSha256: SOURCE_SHA,
            verificationCandidateId: 'verification-candidate',
            verificationRunId: 'verification-run',
            verificationDecisionId: 'verification-run',
            sourceDocumentKey: 'document',
            sourcePdfSha256: SOURCE_SHA,
            assertionIds: [],
            evidenceIds: [],
            values: { peCode: '0600000A' },
            verificationDecision: 'PASS',
            verificationStatus: 'VERIFICATION_PASSED',
            verificationPolicySha256: CONFIG_SHA,
            sourceDocumentId: 'source-document',
            assertionBindings: [],
          },
        ],
        exclusions: [],
        diffSummary: [],
        diffedAgainstCanonicalRows: false,
        contentSha256: OUTPUT_SHA,
      }),
    ).toThrow();
  });

  it('routes project-scoped milestones to the additive project projection tables', () => {
    const assertion = {
      assertionKind: 'milestone',
      assertionId: 'assertion-project-milestone',
      sourceFactIds: ['fact-project-milestone'],
      evidenceIds: ['evidence-project-milestone'],
      confidence: 1,
      parentPeCode: '0600000A',
      milestoneType: 'Flight Test',
      metadata: {
        projectCode: 'AA1',
        plannedPeriod: {
          kind: 'fiscal_year',
          rawText: 'FY2028',
          fiscalYear: 2028,
        },
      },
    } as unknown as DefenseBudgetAssertionV1;

    const milestone = normalizeMilestoneProjection({
      target: 'ProgramElementMilestone',
      naturalKey: 'legacy-milestone',
      values: { peCode: '0600000A', milestoneType: 'Flight Test' },
      assertion,
    });
    expect(milestone.target).toBe('ProgramElementProjectMilestone');
    expect(milestone.naturalKey).toBe('0600000A|AA1|Flight Test');

    const period = normalizeMilestoneProjection({
      target: 'ProgramElementMilestoneSchedulePeriod',
      naturalKey: 'legacy-period',
      values: {
        peCode: '0600000A',
        milestoneType: 'Flight Test',
        periodRole: 'planned',
        rawText: 'FY2028',
        periodKind: 'fiscal_year',
        fiscalYear: 2028,
      },
      assertion,
    });
    expect(period.target).toBe('ProgramElementProjectMilestoneSchedulePeriod');
    expect(period.naturalKey).toBe('0600000A|AA1|Flight Test|planned|FY2028');
  });

  it('uses an explicit all-pages profile contract instead of an empty run job', () => {
    const parsed = parseParserProfileJobV1({
      schemaVersion: 'defense_budget_profile_job_v1',
      jobId: 'profile-audit',
      sourcePath: '/tmp/audit.pdf',
      sourceSha256: SOURCE_SHA,
      engine: 'deterministic_pdfplumber',
      allPages: true,
      requestedPages: [],
      parserVersion: 'audit-v1',
      parserConfig: {},
      parserConfigSha256: CONFIG_SHA,
      outputDirectory: '/tmp/out',
      includeDebugArtifacts: false,
    });
    expect(parsed.allPages).toBe(true);
    expect(() => parseParserProfileJobV1({ ...parsed, allPages: false })).toThrow();
  });

  it('refuses a command-wide paid request above the cap before constructing a call', async () => {
    const fetch = jest.fn<FetchLike>();
    const client = new CumulativePaidPageLlamaParseClient(
      { apiKey: 'secret', baseUrl: 'https://example.invalid' },
      fetch,
      1,
    );
    await expect(
      client.parse({
        file: Buffer.from('pdf'),
        filename: 'audit.pdf',
        mode: 'pdf_fast',
        resultType: 'both',
        targetPages: [0, 1],
      }),
    ).rejects.toThrow(/command-wide paid page cap exceeded/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
