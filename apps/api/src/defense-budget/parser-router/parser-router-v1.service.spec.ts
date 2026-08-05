import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { VerificationRequestV1, DefenseBudgetVerificationResultV1 } from '../verification/verification-contract-v1.js';
import type { BudgetVerificationV1Service } from '../verification/services/budget-verification-v1.service.js';
import { FilesystemParserArtifactStore } from './parser-artifact-store.js';
import { getDefaultParserConfig } from './parser-engine-defaults.js';
import type { LocalParserRuntimeClient } from './local-parser-runtime-client.js';
import type { PageProfileV1 } from './page-profiler.js';
import {
  computeParserConfigSha256,
  sealParserRuntimeResult,
  type ParserRuntimeJobV1,
} from './parser-runtime-contract-v1.js';
import {
  ParserRouterV1Service,
  type ParserRouterConfigV1,
} from './parser-router-v1.service.js';

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'phase3-router-'));
});
afterEach(() => rmSync(workDir, { recursive: true, force: true }));

const SOURCE_SHA = 'a'.repeat(64);
const POLICY_SHA = 'b'.repeat(64);
const MANIFEST_SHA = 'c'.repeat(64);

const profile: PageProfileV1 = {
  page: 1,
  width: '612',
  height: '792',
  rotation: 0,
  embeddedTextCharacters: 100,
  alphanumericCharacters: 80,
  wordCount: 20,
  imageCount: 0,
  imageAreaRatio: '0',
  vectorLineCount: 10,
  horizontalLineCount: 5,
  verticalLineCount: 5,
  tableLikeTextLineCount: 3,
  hasEmbeddedTextLayer: true,
  likelyImageOnly: false,
  likelyRotated: false,
  likelyTablePage: true,
  likelyMixedLayout: false,
  profileWarnings: [],
};

const versions = {
  deterministic_pdfplumber: 'pdfplumber-0.11.0',
  camelot: 'camelot-0.11.0',
  docling: 'docling-2-test-cpu',
  paddleocr: 'paddleocr-pp-structure-v3-cpu',
};

function config(): ParserRouterConfigV1 {
  return {
    executionId: 'execution-1',
    cycleId: 'fy2027-pb',
    manifestDocumentKey: 'r1-army',
    manifestLocator: '/manifests/fy2027.json',
    sourceDocumentId: 'source-document-1',
    sourcePath: '/sources/r1.pdf',
    sourceSha256: SOURCE_SHA,
    sourceLocator: '/sources/r1.pdf',
    parserPolicy: 'deterministic_table',
    exhibitType: 'R-1',
    budgetFamily: 'rdte',
    fiscalYear: 2027,
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb',
    documentType: 'r1',
    maxEscalationRounds: 4,
    allowPaidParse: false,
    maxPaidPages: 0,
    persistVerificationAudit: false,
    workDir,
    parserVersions: versions,
  };
}

function parserResult(job: ParserRuntimeJobV1) {
  return sealParserRuntimeResult({
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId: job.jobId,
    engine: job.engine,
    parserVersion: job.parserVersion,
    parserConfigSha256: job.parserConfigSha256,
    inputSourceSha256: job.sourceSha256,
    requestedPages: [...job.requestedPages],
    succeededPages: [...job.requestedPages],
    failedPages: [],
    pages: job.requestedPages.map((page) => ({
      page,
      text: `${job.engine} page ${page}`,
      blocks: [],
      tables: [],
      images: [],
      evidencePrecision: 'text_span' as const,
      warnings: [],
    })),
    warnings: [],
    metrics: {
      durationMillis: 1,
      pagesProcessed: job.requestedPages.length,
      pagesSucceeded: job.requestedPages.length,
      pagesFailed: 0,
      engineVersion: job.parserVersion,
    },
  });
}

function runtime() {
  return {
    executeJob: jest.fn(async ({ job }: { job: ParserRuntimeJobV1 }) => ({
      result: parserResult(job),
      exitCode: 0,
      stderr: '',
    })),
  } as unknown as LocalParserRuntimeClient;
}

function result(
  request: VerificationRequestV1,
  decision: 'PASS' | 'REVIEW' | 'REJECT',
  checks: DefenseBudgetVerificationResultV1['checks'] = [],
): DefenseBudgetVerificationResultV1 {
  return {
    verifierVersion: 'defense_budget_verifier_v1',
    policyVersion: 'defense_budget_verification_policy_v1',
    policySha256: POLICY_SHA,
    verificationRunId: 'verification-run-1',
    candidateId: 'candidate-1',
    cycleId: 'fy2027-pb',
    manifestContentSha256: MANIFEST_SHA,
    manifestDocumentKey: request.manifestDocumentKey,
    extractionArtifactId: 'artifact-1',
    extractionArtifactSha256: request.expectedExtractionArtifactSha256!,
    sourceDocumentId: request.sourceDocumentId,
    sourcePdfSha256: SOURCE_SHA,
    decision,
    status:
      decision === 'PASS'
        ? 'VERIFICATION_PASSED'
        : decision === 'REVIEW'
          ? 'NEEDS_REVIEW'
          : 'REJECTED',
    route: decision === 'REVIEW' ? 'targeted_local_reextraction' : 'none',
    riskScore: decision === 'PASS' ? 0 : decision === 'REVIEW' ? 30 : 100,
    checks,
    discrepancies: [],
    acceptedAssertionIds: [],
    rejectedAssertionIds: [],
    referenceArtifactIds: [],
    startedAt: '2026-08-04T00:00:00Z',
    completedAt: '2026-08-04T00:00:01Z',
  };
}

function verification(
  implementation: (request: VerificationRequestV1) => Promise<DefenseBudgetVerificationResultV1>,
) {
  return { verify: jest.fn(implementation) } as unknown as BudgetVerificationV1Service;
}

describe('ParserRouterV1Service executable workflow', () => {
  it('executes a local parser and sends exact identities to Phase 2', async () => {
    const parserRuntime = runtime();
    const verifier = verification(async (request) => result(request, 'PASS'));
    const service = new ParserRouterV1Service(config(), {
      artifactStore: new FilesystemParserArtifactStore(join(workDir, 'cache')),
      runtimeClient: parserRuntime,
      verificationService: verifier,
    });

    const output = await service.execute([profile], [1]);
    expect(output.finalState).toBe('TERMINAL_PASSED');
    expect(output.verifierDecision).toBe('PASS');
    expect((parserRuntime.executeJob as jest.Mock).mock.calls).toHaveLength(1);
    expect(verifier.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        manifestLocator: '/manifests/fy2027.json',
        sourceDocumentId: 'source-document-1',
        expectedSourcePdfSha256: SOURCE_SHA,
        expectedExtractionArtifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    const artifact = JSON.parse(readFileSync(output.artifactLocator, 'utf8'));
    expect(artifact.schemaVersion).toBe('defense_budget_extraction_v1');
  });

  it('replays a verified parser artifact without executing the runtime again', async () => {
    const parserRuntime = runtime();
    const verifier = verification(async (request) => result(request, 'PASS'));
    const store = new FilesystemParserArtifactStore(join(workDir, 'cache'));
    const first = new ParserRouterV1Service(config(), {
      artifactStore: store,
      runtimeClient: parserRuntime,
      verificationService: verifier,
    });
    await first.execute([profile], [1]);

    const second = new ParserRouterV1Service(config(), {
      artifactStore: store,
      runtimeClient: parserRuntime,
      verificationService: verifier,
    });
    const replay = await second.execute([profile], [1]);

    expect((parserRuntime.executeJob as jest.Mock).mock.calls).toHaveLength(1);
    expect(replay.reusedArtifacts).toHaveLength(1);
    expect(replay.costReport.pdfplumberPagesReused).toBe(1);
  });

  it('uses evidence-backed findings to escalate from pdfplumber to Camelot', async () => {
    const parserRuntime = runtime();
    let call = 0;
    const verifier = verification(async (request) => {
      call++;
      if (call > 1) return result(request, 'PASS');
      const artifact = JSON.parse(
        readFileSync(request.extractionArtifactLocator, 'utf8'),
      ) as { evidence: Array<{ evidenceId: string }> };
      return result(request, 'REVIEW', [
        {
          checkId: 'check-missing-evidence',
          code: 'missing_evidence',
          ruleVersion: 'defense_budget_verification_rule_v1',
          outcome: 'FAIL',
          required: true,
          blocking: false,
          riskPoints: 20,
          message: 'table evidence incomplete',
          assertionIds: [],
          evidenceIds: [artifact.evidence[0]!.evidenceId],
          referenceArtifactIds: [],
        },
      ]);
    });
    const service = new ParserRouterV1Service(config(), {
      artifactStore: new FilesystemParserArtifactStore(join(workDir, 'cache')),
      runtimeClient: parserRuntime,
      verificationService: verifier,
    });

    const output = await service.execute([profile], [1]);
    const jobs = (parserRuntime.executeJob as jest.Mock).mock.calls.map(
      (args) => args[0].job.engine,
    );
    expect(jobs).toEqual(['deterministic_pdfplumber', 'camelot']);
    expect(output.rounds).toHaveLength(2);
    expect(output.finalState).toBe('TERMINAL_PASSED');
  });

  it('binds local parser config hashes to the registered cross-language defaults', () => {
    expect(
      computeParserConfigSha256(getDefaultParserConfig('deterministic_pdfplumber')),
    ).toMatch(/^[a-f0-9]{64}$/);
  });
});
