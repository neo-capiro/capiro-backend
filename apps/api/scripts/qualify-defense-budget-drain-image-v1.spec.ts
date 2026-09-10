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
  buildQualificationReport,
  canonicalize,
  checkSourceIdentity,
  jsonSafe,
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
    expect(config.sourceSha256).toBe('1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6');
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
      QUAL_FISCAL_YEAR: '2025',
      QUAL_CYCLE_ID: '11111111-1111-1111-1111-111111111111',
      QUAL_SOURCE_DOCUMENT_ID: '22222222-2222-2222-2222-222222222222',
      QUAL_SOURCE_KEY: 'custom-key',
      QUAL_ARCHIVE_BUCKET: 'custom-bucket',
      QUAL_COMPONENT: 'NAVY',
      QUAL_BUDGET_FAMILY: 'procurement',
    });
    expect(config.runId).toBe('run2');
    expect(config.sourceSha256).toBe('a'.repeat(64));
    expect(config.sourceBytes).toBe(123);
    expect(config.targetPeCode).toBe('0601234A');
    expect(config.fiscalYear).toBe(2025);
    expect(config.cycleId).toBe('11111111-1111-1111-1111-111111111111');
    expect(config.sourceDocumentId).toBe('22222222-2222-2222-2222-222222222222');
    expect(config.sourceKey).toBe('custom-key');
    expect(config.archiveBucket).toBe('custom-bucket');
    expect(config.component).toBe('NAVY');
    expect(config.budgetFamily).toBe('procurement');
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
    const input = { at: new Date('2026-01-01T00:00:00.000Z'), big: BigInt(42), nested: [{ at: new Date('2026-01-02T00:00:00.000Z') }] };
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
          value: { peCode: '0601102A', fiscalYear: 2024, rowKind: 'pe_total', valueMillions: '296.67' },
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
        run: { id: 'run-row-1', decision: 'REVIEW', status: 'NEEDS_REVIEW', riskScore: 10, route: 'none', verifierVersion: 'v1', policyVersion: 'p1' },
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
});
