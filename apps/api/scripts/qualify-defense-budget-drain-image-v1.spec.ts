/**
 * qualify-defense-budget-drain-image-v1.spec.ts (Phase 10B-36).
 *
 * Unit coverage for the pure logic in the release-qualification driver:
 * config resolution/defaults, source-identity verification, and structured
 * report assembly. The real, I/O-driven path (isolated-fixture seeding +
 * dbverify against a real Postgres/MinIO, and the real parser handoff) is
 * covered separately by qualify-defense-budget-drain-image-v1.integration.spec.ts
 * and its self-provisioning rehearsal script, per this program's established
 * DB-backed-testing convention.
 */
import { describe, expect, test } from '@jest/globals';
import { join } from 'node:path';
import {
  assertCanonicalSourceUrl,
  buildQualificationReport,
  canonicalize,
  checkSourceIdentity,
  encodeChunkedPayload,
  hashQualificationArtifactProjectionV1,
  jsonSafe,
  projectQualificationArtifactV1,
  resolveQualificationConfig,
  stripRunIdentity,
  UsageError,
} from './qualify-defense-budget-drain-image-v1.js';

describe('resolveQualificationConfig', () => {
  const baseEnv = { QUAL_PRESIGNED_GET: 'https://example.invalid/presigned' };

  test('requires QUAL_PRESIGNED_GET', () => {
    expect(() => resolveQualificationConfig({})).toThrow(UsageError);
  });

  test('defaults to the real Phase 10B-28/10B-32 FY2024 Army R-2 fixture identity', () => {
    const config = resolveQualificationConfig(baseEnv);
    expect(config.sourceSha256).toBe(
      '1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6',
    );
    expect(config.sourceBytes).toBe(7227604);
    expect(config.targetPeCode).toBe('0601102A');
    expect(config.fiscalYear).toBe(2024);
    expect(config.cycleId).toBe('cff02efd-45e7-4ae4-8f7f-dacd12bdb84c');
    expect(config.component).toBe('ARMY');
    expect(config.budgetFamily).toBe('rdte');
    expect(config.runId).toBe('run1');
  });

  test('every fixture-identity field is independently overridable', () => {
    const config = resolveQualificationConfig({
      ...baseEnv,
      QUAL_RUN_ID: 'run2',
      QUAL_SOURCE_SHA256: 'a'.repeat(64),
      QUAL_SOURCE_BYTES: '123',
      QUAL_TARGET_PE: '0601234A',
      QUAL_TARGET_R3_PE: '0605678A',
      QUAL_FISCAL_YEAR: '2025',
      QUAL_CYCLE_ID: '11111111-1111-1111-1111-111111111111',
      QUAL_SOURCE_DOCUMENT_ID: '22222222-2222-2222-2222-222222222222',
      QUAL_SOURCE_KEY: 'custom-key',
      QUAL_ARCHIVE_BUCKET: 'custom-bucket',
      QUAL_COMPONENT: 'NAVY',
      QUAL_ACCOUNT: '1506N: Aircraft Procurement, Navy',
      QUAL_BUDGET_FAMILY: 'procurement',
    });
    expect(config.runId).toBe('run2');
    expect(config.sourceSha256).toBe('a'.repeat(64));
    expect(config.sourceBytes).toBe(123);
    expect(config.targetPeCode).toBe('0601234A');
    expect(config.targetR3PeCode).toBe('0605678A');
    expect(config.fiscalYear).toBe(2025);
    expect(config.cycleId).toBe('11111111-1111-1111-1111-111111111111');
    expect(config.sourceDocumentId).toBe('22222222-2222-2222-2222-222222222222');
    expect(config.sourceKey).toBe('custom-key');
    expect(config.archiveBucket).toBe('custom-bucket');
    expect(config.component).toBe('NAVY');
    expect(config.account).toBe('1506N: Aircraft Procurement, Navy');
    expect(config.budgetFamily).toBe('procurement');
  });

  test('rejects a fetch credential as the durable source locator', () => {
    const samePlainUrl = 'https://archive.example/source.pdf';
    expect(() =>
      resolveQualificationConfig({
        QUAL_PRESIGNED_GET: samePlainUrl,
        QUAL_SOURCE_URL: samePlainUrl,
      }),
    ).toThrow(UsageError);

    const signed = 'https://archive.example/source.pdf?X-Amz-Signature=secret';
    expect(() =>
      resolveQualificationConfig({ QUAL_PRESIGNED_GET: signed, QUAL_SOURCE_URL: signed }),
    ).toThrow(UsageError);
    expect(() =>
      resolveQualificationConfig({
        QUAL_PRESIGNED_GET: 'https://archive.example/presigned',
        QUAL_SOURCE_URL: signed,
      }),
    ).toThrow(UsageError);
  });

  test('accepts the canonical Air Force LinkClick locator', () => {
    const sourceUrl =
      'https://www.saffm.hq.af.mil/LinkClick.aspx?fileticket=k4ghOMooM40%3D&portalid=84';
    expect(() =>
      assertCanonicalSourceUrl(
        sourceUrl,
        'https://archive.example/presigned?X-Amz-Signature=secret',
      ),
    ).not.toThrow();
  });

  test('resolves paths under the given QUAL_OUT_ROOT', () => {
    const config = resolveQualificationConfig({ ...baseEnv, QUAL_OUT_ROOT: '/tmp/custom-qual' });
    expect(config.sourcePath).toBe(join('/tmp/custom-qual', 'source.pdf'));
    expect(config.workDir).toBe(join('/tmp/custom-qual', 'work'));
  });

  test('appsApiDir resolves to the script’s own parent directory, not process.cwd()', () => {
    const config = resolveQualificationConfig(baseEnv);
    expect(config.appsApiDir.endsWith('api')).toBe(true);
  });
});

describe('encodeChunkedPayload', () => {
  test('round-trips multiple chunks and binds byte count and SHA-256', () => {
    const source = Buffer.from(JSON.stringify({ assertions: [], omissions: [] }), 'utf8');
    const encoded = encodeChunkedPayload(source, 7);
    const reconstructed = Buffer.from(encoded.parts.join(''), 'base64');
    const report = buildQualificationReport({
      runId: 'chunk-contract',
      decision: 'REVIEW',
      finalState: 'TERMINAL_REVIEW',
      artifact: { assertions: [], omissions: [] },
      artifactRawBytes: source,
      manifestCycleId: 'x',
      targetPeCode: '0604017A',
      fiscalYear: 2024,
      dbverify: { candidate: null, run: null, checks: [], discrepancies: [], proofSnapshots: [] },
    });

    expect(encoded.parts.length).toBeGreaterThan(1);
    expect(reconstructed.equals(source)).toBe(true);
    expect(encoded.bytes).toBe(source.length);
    expect(encoded.sha256).toBe(report.artifactSha256);
  });

  test('represents an empty payload with one empty part', () => {
    expect(encodeChunkedPayload(Buffer.alloc(0), 10).parts).toEqual(['']);
  });

  test('rejects invalid chunk sizes', () => {
    expect(() => encodeChunkedPayload(Buffer.from('x'), 0)).toThrow(RangeError);
    expect(() => encodeChunkedPayload(Buffer.from('x'), 1.5)).toThrow(RangeError);
  });
});

describe('checkSourceIdentity', () => {
  const expected = { bytes: 100, sha256: 'deadbeef' };

  test('passes on an exact match', () => {
    expect(checkSourceIdentity({ bytes: 100, sha256: 'deadbeef' }, expected)).toEqual({ ok: true });
  });

  test('fails on a byte-count mismatch, independent of the hash', () => {
    const verdict = checkSourceIdentity({ bytes: 99, sha256: 'deadbeef' }, expected);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/byte size mismatch/);
  });

  test('fails on a sha256 mismatch even when byte count matches', () => {
    const verdict = checkSourceIdentity({ bytes: 100, sha256: 'wrong' }, expected);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/sha256 mismatch/);
  });

  test('checks byte count before hash (cheaper, deterministic failure ordering)', () => {
    const verdict = checkSourceIdentity({ bytes: 1, sha256: 'wrong' }, expected);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/byte size mismatch/);
  });
});

describe('jsonSafe / canonicalize / stripRunIdentity', () => {
  test('jsonSafe converts Date to ISO string and bigint to string, recursively', () => {
    const input = {
      at: new Date('2026-01-01T00:00:00.000Z'),
      big: BigInt(42),
      nested: [{ at: new Date('2026-01-02T00:00:00.000Z') }],
    };
    const out = jsonSafe(input) as Record<string, unknown>;
    expect(out.at).toBe('2026-01-01T00:00:00.000Z');
    expect(out.big).toBe('42');
    const nested = out.nested as Array<Record<string, unknown>>;
    expect(nested[0]?.at).toBe('2026-01-02T00:00:00.000Z');
  });

  test('canonicalize sorts object keys recursively so two differently-ordered-but-equal objects hash identically', () => {
    const a = canonicalize({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalize({ a: { c: 3, d: 2 }, b: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('stripRunIdentity removes executionId/parserRunId/artifactId but keeps everything else', () => {
    const out = stripRunIdentity({
      executionId: 'run-1',
      parserRunId: 'pr-1',
      artifactId: 'art-1',
      decision: 'REVIEW',
      nested: { executionId: 'nested-run', keep: 'me' },
    }) as Record<string, unknown>;
    expect(out.executionId).toBeUndefined();
    expect(out.parserRunId).toBeUndefined();
    expect(out.artifactId).toBeUndefined();
    expect(out.decision).toBe('REVIEW');
    expect((out.nested as Record<string, unknown>).executionId).toBeUndefined();
    expect((out.nested as Record<string, unknown>).keep).toBe('me');
  });
});

describe('versioned substantive qualification projection', () => {
  const artifact = {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId: 'artifact-a',
    contentSha256: 'a'.repeat(64),
    source: {
      manifestDocumentKey: 'doc-a',
      sourceDocumentId: 'source-a',
      sourcePdfSha256: 'b'.repeat(64),
      sourceLocator: 's3://bucket/a.pdf',
      sourceUrl: 'https://example.invalid/a',
      fiscalYear: 2024,
      family: 'rdte',
      exhibit: 'R-2',
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'cycle-a',
      documentType: 'budget',
      pageCount: 12,
      title: 'Army R-2',
    },
    parserRuns: [
      {
        parserRunId: 'parser-a',
        providerJobId: 'job-a',
        method: 'native_pdf_text',
        parserVersion: 'v1',
        parserConfigSha256: 'c'.repeat(64),
        inputSourceSha256: 'b'.repeat(64),
        outputArtifactSha256: 'd'.repeat(64),
        pageRanges: [{ startPage: 1, endPage: 2 }],
      },
    ],
    evidence: [
      {
        evidenceId: 'evidence-a',
        parserRunId: 'parser-a',
        sourcePdfSha256: 'b'.repeat(64),
        granularity: 'page_only',
        page: 1,
        excerpt: 'research aircraft',
      },
    ],
    sourceFacts: [
      {
        factId: 'fact-a',
        sourcePath: 'r2/pe/0601102A',
        category: 'money',
        requiredForCompleteness: true,
        rawValue: '296.67',
        evidenceIds: ['evidence-a'],
      },
    ],
    assertions: [
      {
        assertionId: 'assertion-a',
        sourceFactIds: ['fact-a'],
        evidenceIds: ['evidence-a'],
        assertionKind: 'document_fact',
        confidence: 0.98,
        fieldName: 'r2_total_component',
        value: { peCode: '0601102A', fiscalYear: 2024, valueMillions: '296.67' },
        metadata: { exhibit: 'R-2', physicalPage: 1, generatedAt: '2026-01-01T00:00:00.000Z' },
      },
    ],
    warnings: [
      {
        warningId: 'warning-a',
        code: 'review_hint',
        severity: 'review',
        message: 'Check table heading',
        sourceFactIds: ['fact-a'],
        evidenceIds: ['evidence-a'],
      },
    ],
    omissions: [
      {
        omissionId: 'omission-a',
        sourceFactId: 'fact-a',
        reason: 'unsupported_field',
        severity: 'review',
        message: 'No enacted column',
      },
    ],
    summary: {
      assertionCount: 1,
      warningCount: 1,
      omissionCount: 1,
      completenessStatus: 'complete_with_omissions',
    },
  };

  test('run IDs, generated locators and ordering do not change the projection hash', () => {
    const changedRun = {
      ...artifact,
      artifactId: 'artifact-b',
      contentSha256: 'e'.repeat(64),
      source: {
        ...artifact.source,
        manifestDocumentKey: 'doc-b',
        sourceDocumentId: 'source-b',
        sourceLocator: 's3://other/b.pdf',
        sourceUrl: 'https://other.invalid/b',
      },
      parserRuns: [
        {
          ...artifact.parserRuns[0],
          parserRunId: 'parser-b',
          providerJobId: 'job-b',
          outputArtifactSha256: 'f'.repeat(64),
        },
      ],
      evidence: [{ ...artifact.evidence[0], evidenceId: 'evidence-b', parserRunId: 'parser-b' }],
      sourceFacts: [{ ...artifact.sourceFacts[0], factId: 'fact-b', evidenceIds: ['evidence-b'] }],
      assertions: [
        {
          ...artifact.assertions[0],
          assertionId: 'assertion-b',
          sourceFactIds: ['fact-b'],
          evidenceIds: ['evidence-b'],
        },
      ],
      warnings: [
        {
          ...artifact.warnings[0],
          warningId: 'warning-b',
          sourceFactIds: ['fact-b'],
          evidenceIds: ['evidence-b'],
        },
      ],
      omissions: [{ ...artifact.omissions[0], omissionId: 'omission-b', sourceFactId: 'fact-b' }],
    };
    const additionalAssertion = {
      ...artifact.assertions[0],
      assertionId: 'assertion-c',
      fieldName: 'other_fact',
      value: { peCode: '0601103A', fiscalYear: 2024, valueMillions: '12.00' },
    };
    const additionalParserRun = {
      ...artifact.parserRuns[0],
      parserRunId: 'parser-c',
      providerJobId: 'job-c',
    };
    const additionalOmission = {
      ...artifact.omissions[0],
      omissionId: 'omission-c',
      message: 'Another unsupported field',
    };
    const multiItem = {
      ...artifact,
      assertions: [...artifact.assertions, additionalAssertion],
      parserRuns: [...artifact.parserRuns, additionalParserRun],
      omissions: [...artifact.omissions, additionalOmission],
    };
    const reordered = {
      ...multiItem,
      assertions: [...multiItem.assertions].reverse(),
      parserRuns: [...multiItem.parserRuns].reverse(),
      omissions: [...multiItem.omissions].reverse(),
    };
    expect(hashQualificationArtifactProjectionV1(changedRun)).toBe(
      hashQualificationArtifactProjectionV1(artifact),
    );
    expect(hashQualificationArtifactProjectionV1(reordered)).toBe(
      hashQualificationArtifactProjectionV1(multiItem),
    );
    expect(projectQualificationArtifactV1(artifact)).toMatchObject({
      projectionVersion: 'qualification_artifact_projection_v1',
    });
  });

  test('substantive assertion changes alter the projection hash', () => {
    const firstAssertion = artifact.assertions[0]!;
    const changedValue = {
      ...artifact,
      assertions: [
        { ...firstAssertion, value: { ...firstAssertion.value, valueMillions: '296.68' } },
      ],
    };
    expect(hashQualificationArtifactProjectionV1(changedValue)).not.toBe(
      hashQualificationArtifactProjectionV1(artifact),
    );
    const changedConfig = {
      ...artifact,
      parserRuns: [{ ...artifact.parserRuns[0], parserConfigSha256: '9'.repeat(64) }],
    };
    expect(hashQualificationArtifactProjectionV1(changedConfig)).not.toBe(
      hashQualificationArtifactProjectionV1(artifact),
    );
  });

  test('preserves semantic tuple order while normalizing top-level collection order', () => {
    const withBox = {
      ...artifact,
      evidence: [
        { ...artifact.evidence[0], evidenceId: 'evidence-b', boundingBox: [10, 20, 30, 40] },
        { ...artifact.evidence[0], evidenceId: 'evidence-c', page: 2, excerpt: 'second item' },
      ],
    };
    const reorderedCollection = { ...withBox, evidence: [...withBox.evidence].reverse() };
    const reorderedTuple = {
      ...withBox,
      evidence: [{ ...withBox.evidence[0], boundingBox: [20, 10, 30, 40] }, withBox.evidence[1]],
    };

    expect(hashQualificationArtifactProjectionV1(reorderedCollection)).toBe(
      hashQualificationArtifactProjectionV1(withBox),
    );
    expect(hashQualificationArtifactProjectionV1(reorderedTuple)).not.toBe(
      hashQualificationArtifactProjectionV1(withBox),
    );
  });
});

describe('buildQualificationReport', () => {
  const artifactRawBytes = Buffer.from(
    JSON.stringify({
      assertions: [
        // program_element_identity assertions carry their PE code under
        // `identity` (rdtePeIdentityV1Schema), NOT `value` -- document_fact
        // assertions below are the ones that use `value`. Mixing these up
        // is a real bug this fixture is shaped to catch.
        { assertionKind: 'program_element_identity', identity: { peCode: '0601102A' } },
        { assertionKind: 'program_element_identity', identity: { peCode: '0601103A' } },
        {
          assertionKind: 'document_fact',
          fieldName: 'r2_total_component',
          // valueMillions is a canonical decimal STRING
          // (canonicalDecimalStringSchema), never a JS number.
          value: {
            peCode: '0601102A',
            fiscalYear: 2024,
            rowKind: 'pe_total',
            valueMillions: '296.67',
          },
        },
      ],
      omissions: [{ omissionKind: 'ambiguous_layout' }, { omissionKind: 'ambiguous_layout' }],
    }),
    'utf8',
  );
  const artifact = JSON.parse(artifactRawBytes.toString('utf8'));

  test('computes assertion/omission counts, identity list, and the target PE total from the real artifact shape', () => {
    const report = buildQualificationReport({
      runId: 'run1',
      decision: 'REVIEW',
      finalState: 'TERMINAL_REVIEW',
      artifact,
      artifactRawBytes,
      manifestCycleId: 'fy2024:cff02efd-45e7-4ae4-8f7f-dacd12bdb84c',
      targetPeCode: '0601102A',
      fiscalYear: 2024,
      dbverify: { candidate: null, run: null, checks: [], discrepancies: [], proofSnapshots: [] },
    });
    expect(report.totalAssertions).toBe(3);
    expect(report.assertionsByKind).toEqual({ program_element_identity: 2, document_fact: 1 });
    expect(report.identityCount).toBe(2);
    expect(report.identityPeCodes).toEqual(['0601102A', '0601103A']);
    expect(report.omissions).toBe(2);
    expect(report.omissionsByKind).toEqual({ ambiguous_layout: 2 });
    expect(report.targetPeFiscalYearTotalMillions).toBe('296.67');
    expect(report.dbverifyOk).toBe(false);
    // allTargetPeFiscalYearTotalsMillions covers every known PE regardless of
    // targetPeCode: 0601102A has a real total in this fixture, 0601103A has
    // an identity but no r2_total_component assertion (null, not a thrown
    // error), and the other three known PEs have neither (also null).
    expect(report.allTargetPeFiscalYearTotalsMillions).toEqual({
      '0601102A': '296.67',
      '0601103A': null,
      '0601104A': null,
      '0601121A': null,
      '0601601A': null,
    });
  });

  test('dbverifyOk reflects a real persisted run row, and normalizedArtifactSha256 is stable under key-order-only changes', () => {
    const reordered = Buffer.from(
      JSON.stringify({
        omissions: artifact.omissions,
        assertions: artifact.assertions,
      }),
      'utf8',
    );
    const r1 = buildQualificationReport({
      runId: 'run1',
      decision: 'REVIEW',
      finalState: 'TERMINAL_REVIEW',
      artifact,
      artifactRawBytes,
      manifestCycleId: 'x',
      targetPeCode: '0601102A',
      fiscalYear: 2024,
      dbverify: {
        candidate: { id: 'cand-1', cycleId: 'x', status: 'EXTRACTED', currentRunId: 'run-row-1' },
        run: {
          id: 'run-row-1',
          decision: 'REVIEW',
          status: 'NEEDS_REVIEW',
          riskScore: 10,
          route: 'none',
          verifierVersion: 'v1',
          policyVersion: 'p1',
        },
        checks: [],
        discrepancies: [],
        proofSnapshots: [],
      },
    });
    const r2 = buildQualificationReport({
      runId: 'run2',
      decision: 'REVIEW',
      finalState: 'TERMINAL_REVIEW',
      artifact: JSON.parse(reordered.toString('utf8')),
      artifactRawBytes: reordered,
      manifestCycleId: 'x',
      targetPeCode: '0601102A',
      fiscalYear: 2024,
      dbverify: { candidate: null, run: null, checks: [], discrepancies: [], proofSnapshots: [] },
    });
    expect(r1.dbverifyOk).toBe(true);
    expect(r1.dbCandidateId).toBe('cand-1');
    expect(r1.dbRunDecision).toBe('REVIEW');
    // Same logical content, different key order/whitespace in the raw bytes:
    // raw SHA differs, normalized (canonicalized) SHA must match.
    expect(r1.artifactSha256).not.toBe(r2.artifactSha256);
    expect(r1.normalizedArtifactSha256).toBe(r2.normalizedArtifactSha256);
  });

  test('returns null (not a thrown error) when the target PE total assertion is absent', () => {
    const noTarget = Buffer.from(JSON.stringify({ assertions: [], omissions: [] }), 'utf8');
    const report = buildQualificationReport({
      runId: 'run1',
      decision: 'REJECT',
      finalState: 'TERMINAL_REJECTED',
      artifact: JSON.parse(noTarget.toString('utf8')),
      artifactRawBytes: noTarget,
      manifestCycleId: 'x',
      targetPeCode: '0601102A',
      fiscalYear: 2024,
      dbverify: { candidate: null, run: null, checks: [], discrepancies: [], proofSnapshots: [] },
    });
    expect(report.targetPeFiscalYearTotalMillions).toBeNull();
    expect(report.decision).toBe('REJECT');
  });

  test('projects target-PE R-3 evidence and counts blocking natural-key conflicts', () => {
    const artifactRawBytes = Buffer.from(
      JSON.stringify({
        assertions: [
          {
            assertionKind: 'performer',
            parentPeCode: '0604020A',
            performerName: 'Various : Various',
            performerNormalized: 'VARIOUS : VARIOUS',
            costCategory: 'Olympus: Program Management and Capability Transition',
            contractMethod: 'TBD',
            fiscalYear: 2024,
            totalCost: { valueMillions: '6.178' },
            metadata: { exhibit: 'R-3', naturalKey: 'key-olympus', physicalPage: 399 },
          },
          {
            assertionKind: 'performer',
            parentPeCode: '0604020A',
            performerName: 'Various : Various.',
            performerNormalized: 'VARIOUS : VARIOUS',
            costCategory: 'SBIR & STTR Adjustment',
            contractMethod: 'TBD',
            fiscalYear: 2024,
            totalCost: { valueMillions: '2.811' },
            metadata: { exhibit: 'R-3', naturalKey: 'key-sbir', physicalPage: 399 },
          },
          {
            assertionKind: 'performer',
            parentPeCode: '0604020A',
            performerName: 'Same PE but R-2',
            performerNormalized: 'SAME PE BUT R-2',
            metadata: { exhibit: 'R-2', naturalKey: 'not-r3', physicalPage: 399 },
          },
          {
            assertionKind: 'performer',
            parentPeCode: '0609999A',
            performerName: 'Out of scope',
          },
        ],
        omissions: [],
        warnings: [
          { code: 'r3_duplicate_natural_key_conflict', severity: 'blocking' },
          { code: 'informational_warning', severity: 'informational' },
        ],
      }),
      'utf8',
    );
    const artifact = JSON.parse(artifactRawBytes.toString('utf8'));
    const report = buildQualificationReport({
      runId: 'run1',
      decision: 'REJECT',
      finalState: 'TERMINAL_REJECTED',
      artifact,
      artifactRawBytes,
      manifestCycleId: 'x',
      targetPeCode: '0604020A',
      targetR3PeCode: '0604020A',
      fiscalYear: 2024,
      dbverify: { candidate: null, run: null, checks: [], discrepancies: [], proofSnapshots: [] },
    });

    expect(report.targetR3Performers).toEqual([
      {
        performerName: 'Various : Various',
        performerNormalized: 'VARIOUS : VARIOUS',
        costCategory: 'Olympus: Program Management and Capability Transition',
        contractMethod: 'TBD',
        fiscalYear: 2024,
        totalCostMillions: '6.178',
        naturalKey: 'key-olympus',
        physicalPage: 399,
      },
      {
        performerName: 'Various : Various.',
        performerNormalized: 'VARIOUS : VARIOUS',
        costCategory: 'SBIR & STTR Adjustment',
        contractMethod: 'TBD',
        fiscalYear: 2024,
        totalCostMillions: '2.811',
        naturalKey: 'key-sbir',
        physicalPage: 399,
      },
    ]);
    expect(report.targetR3PeCode).toBe('0604020A');
    expect(report.r3DuplicateNaturalKeyConflictCount).toBe(1);
  });
});
