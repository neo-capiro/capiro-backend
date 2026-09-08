/**
 * Phase 10B-31 (GAP 4 investigation) -- documents, as executable contract,
 * WHY a fresh drain run of byte-identical source produces a NEW
 * `budget_extraction_candidate_v1` row rather than reusing the prior one,
 * and which layer of identity is (and is not) stable across runs.
 *
 * The chain, traced through production code:
 *
 *   DefaultParserHandoffAdapter.handoff
 *     executionId = `phase10b1-bridge-${sourceDocumentId}-${randomUUID().slice(0, 8)}`
 *   -> ParserRouterV1Service.executeLocalStep
 *        job.jobId = `${executionId}-${engine}-${step.ordinal}`
 *   -> Python runtime result: contentSha256 = sha256(canonical(result minus
 *        contentSha256 and metrics.durationMillis))  -- `jobId` IS hashed
 *   -> entry.outputArtifactSha256 = replay.result.contentSha256
 *   -> artifact.parserRuns[].outputArtifactSha256
 *   -> computeArtifactContentSha256(artifact)  (covers parserRuns)
 *   -> artifactId / extractionArtifactSha256
 *   -> CandidateIdentityV1.extractionArtifactId / extractionArtifactSha256
 *   -> computeCandidateId  and the 10-column unique key on
 *      budget_extraction_candidate_v1.
 *
 * So the candidate identity is content-addressed and idempotent -- an exact
 * identity is never persisted twice (`findTerminalRunByIdentity`,
 * `persistCompletedVerification`) -- but the artifact content hash is NOT a
 * pure function of (source bytes, engine, config, pages): it embeds the
 * run-specific `jobId`. Two fresh containers parsing identical bytes
 * therefore produce two candidates (append-only history, one per fresh
 * verification run). Within ONE shared parser-artifact root the
 * `reuseOrCreate` cache returns the FIRST run's persisted result for the
 * same canonical parser-run identity, so the second execution replays the
 * first run's bytes (same `jobId` inside) and the candidate IS reused --
 * which is why the same-process idempotency test in
 * `lifecycle-bridge-source-metadata-agreement.integration.spec.ts` sees one
 * candidate while two separate drain containers (empty `/tmp` each) do not.
 *
 * The canonical PARSER-RUN identity (`parserRunIdV1`, Phase 10B-25) is
 * deliberately independent of `jobId`; only the OUTPUT content hash carries
 * it. These tests pin each of those three facts so a future change to either
 * hash domain is a visible, reviewed decision rather than an accident.
 */
import {
  computeResultContentSha256,
  sealParserRuntimeResult,
  type ParserRuntimeResultV1,
} from './parser-runtime-contract-v1.js';
import { parserRunIdV1 } from './parser-run-identity-v1.js';
import { computeCandidateId } from '../verification/persistence/verification-persistence-mappers.js';
import type { CandidateIdentityV1 } from '../verification/persistence/verification-repository.js';

const SOURCE_SHA = 'a'.repeat(64);
const CONFIG_SHA = 'b'.repeat(64);

function runtimeResult(jobId: string, durationMillis = 1): Omit<ParserRuntimeResultV1, 'contentSha256'> {
  return {
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId,
    engine: 'deterministic_pdfplumber',
    parserVersion: 'pdfplumber-0.11.0',
    parserConfigSha256: CONFIG_SHA,
    inputSourceSha256: SOURCE_SHA,
    requestedPages: [1, 2],
    succeededPages: [1, 2],
    failedPages: [],
    pages: [],
    warnings: [],
    metrics: {
      durationMillis,
      pagesProcessed: 2,
      pagesSucceeded: 2,
      pagesFailed: 0,
      engineVersion: 'pdfplumber-0.11.0',
      modelVersions: null,
    },
  };
}

function identity(overrides: Partial<CandidateIdentityV1> = {}): CandidateIdentityV1 {
  return {
    cycleId: 'cff02efd-45e7-4ae4-8f7f-dacd12bdb84c',
    manifestContentSha256: 'c'.repeat(64),
    manifestDocumentKey: 'a99fbf5b-5eb4-45f3-87e4-96c40c2c0bb0',
    extractionArtifactId: 'dbx1_' + 'd'.repeat(64),
    extractionArtifactSha256: 'd'.repeat(64),
    extractionArtifactLocator: '/scratch/run-1/artifact.json',
    sourceDocumentId: 'a99fbf5b-5eb4-45f3-87e4-96c40c2c0bb0',
    sourceSha256: SOURCE_SHA,
    verifierVersion: 'defense_budget_verifier_v1',
    policyVersion: 'defense_budget_verification_policy_v1',
    policySha256: 'e'.repeat(64),
    ...overrides,
  };
}

describe('parser output content hash vs canonical parser-run identity vs candidate identity (Phase 10B-31 GAP 4)', () => {
  it('the parser OUTPUT content hash changes when only the run-specific jobId changes (identical pages, engine, config, source)', () => {
    const a = computeResultContentSha256(runtimeResult('phase10b1-bridge-doc-11111111-deterministic_pdfplumber-0'));
    const b = computeResultContentSha256(runtimeResult('phase10b1-bridge-doc-22222222-deterministic_pdfplumber-0'));
    expect(a).not.toBe(b);
    // and sealing embeds exactly that jobId-sensitive hash
    expect(sealParserRuntimeResult(runtimeResult('phase10b1-bridge-doc-11111111-deterministic_pdfplumber-0')).contentSha256).toBe(a);
  });

  it('the parser OUTPUT content hash ignores runtime timing (metrics.durationMillis) -- the one field the contract excludes', () => {
    const a = computeResultContentSha256(runtimeResult('same-job', 1));
    const b = computeResultContentSha256(runtimeResult('same-job', 999_999));
    expect(a).toBe(b);
  });

  it('the canonical PARSER-RUN identity does NOT depend on jobId (Phase 10B-25: identity = source SHA + engine + version + config + requested pages)', () => {
    const base = {
      sourceSha256: SOURCE_SHA,
      method: 'deterministic_pdfplumber' as const,
      parserVersion: 'pdfplumber-0.11.0',
      parserConfigSha256: CONFIG_SHA,
      requestedPages: [1, 2],
    };
    // There is no jobId input at all -- the identity constructor cannot even
    // be handed one. Pin the stability and the pr1_ shape.
    expect(parserRunIdV1(base)).toBe(parserRunIdV1({ ...base, requestedPages: [2, 1] }));
    expect(parserRunIdV1(base)).toMatch(/^pr1_[0-9a-f]{64}$/);
    expect(parserRunIdV1({ ...base, requestedPages: [1, 2, 3] })).not.toBe(parserRunIdV1(base));
  });

  it('the CANDIDATE identity follows the artifact content hash, so a different parser-output hash for identical source bytes is a different candidate', () => {
    const first = identity();
    const second = identity({
      extractionArtifactId: 'dbx1_' + 'f'.repeat(64),
      extractionArtifactSha256: 'f'.repeat(64),
    });
    expect(second.sourceSha256).toBe(first.sourceSha256);
    expect(second.cycleId).toBe(first.cycleId);
    expect(computeCandidateId(first)).not.toBe(computeCandidateId(second));
  });

  it('the CANDIDATE identity does NOT depend on the artifact locator (where the bytes were stored), only on what they hash to', () => {
    const local = identity({ extractionArtifactLocator: '/tmp/defense-budget-parser-scratch/x/artifact.json' });
    const s3 = identity({
      extractionArtifactLocator:
        's3://capiro-dev-defense-budget-extraction-artifacts-967807252336/phase10/parser-artifacts/abc?versionId=v1',
    });
    expect(computeCandidateId(local)).toBe(computeCandidateId(s3));
  });
});
