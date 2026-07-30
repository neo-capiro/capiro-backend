import { describe, expect, test } from '@jest/globals';
import {
  PE_EXACT_SHA_DOLLAR_LOADERS,
  assertExactShaCommitAllowed,
  auditArtifactQuality,
  buildInspectReport,
  isPeExactShaDollarLoader,
  resolvePeDollarLoaderPosture,
} from './pe-exact-sha-loader-contract.js';

const SHA = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

describe('resolvePeDollarLoaderPosture', () => {
  test('defaults to inspect (no canonical write)', () => {
    expect(resolvePeDollarLoaderPosture(['--artifact', 'x.json'])).toBe('inspect');
    expect(resolvePeDollarLoaderPosture(['--inspect'])).toBe('inspect');
  });

  test('commit is explicit', () => {
    expect(resolvePeDollarLoaderPosture(['--commit'])).toBe('commit');
  });

  test('extract-only and deprecated dry-run are extract_only', () => {
    expect(resolvePeDollarLoaderPosture(['--extract-only'])).toBe('extract_only');
    expect(resolvePeDollarLoaderPosture(['--dry-run'])).toBe('extract_only');
  });

  test('rejects mixed posture flags', () => {
    expect(() => resolvePeDollarLoaderPosture(['--commit', '--inspect'])).toThrow(
      'Choose exactly one loader posture',
    );
    expect(() => resolvePeDollarLoaderPosture(['--commit', '--extract-only'])).toThrow(
      'Choose exactly one loader posture',
    );
  });
});

describe('assertExactShaCommitAllowed', () => {
  test('requires approved sha before promotion', () => {
    expect(() =>
      assertExactShaCommitAllowed({
        actualSha256: SHA,
        approvedSha256Raw: undefined,
        quality: { rowCount: 3 },
      }),
    ).toThrow('--commit requires --approved-sha256');
  });

  test('rejects non-matching approved sha', () => {
    expect(() =>
      assertExactShaCommitAllowed({
        actualSha256: SHA,
        approvedSha256Raw: SHA_B,
        quality: { rowCount: 3 },
      }),
    ).toThrow('Approved SHA-256 does not match source bytes');
  });

  test('quality failure blocks promotion even with matching sha', () => {
    expect(() =>
      assertExactShaCommitAllowed({
        actualSha256: SHA,
        approvedSha256Raw: SHA,
        quality: { rowCount: 0 },
      }),
    ).toThrow('Quality audit failed');
  });

  test('matching sha + non-empty rows allow commit', () => {
    const result = assertExactShaCommitAllowed({
      actualSha256: SHA,
      approvedSha256Raw: SHA,
      quality: { rowCount: 2 },
    });
    expect(result.approvedSha256).toBe(SHA);
    expect(result.quality.status).toBe('ok');
  });
});

describe('auditArtifactQuality', () => {
  test('empty artifact fails closed', () => {
    expect(auditArtifactQuality({ rowCount: 0 }).status).toBe('fail');
  });

  test('units anomalies fail', () => {
    expect(auditArtifactQuality({ rowCount: 5, unitsAnomalies: 1 }).status).toBe('fail');
  });
});

describe('buildInspectReport', () => {
  test('documents commit requirements without writing', () => {
    const report = buildInspectReport({
      loader: 'load-om.ts',
      posture: 'inspect',
      artifactPath: 'x.json',
      sha256: SHA,
      byteSize: 12,
      quality: auditArtifactQuality({ rowCount: 2 }),
    });
    expect(report.mode).toBe('INSPECT');
    expect((report.commitRequirements as { approvedSha256MustEqual: string }).approvedSha256MustEqual).toBe(
      SHA,
    );
  });
});

describe('PE exact-SHA dollar loader inventory', () => {
  test('covers every planned family entrypoint', () => {
    expect(PE_EXACT_SHA_DOLLAR_LOADERS).toEqual(
      expect.arrayContaining([
        'sync-comptroller-jbooks.ts',
        'sync-jbook-r2.ts',
        'sync-jbook-performers.ts',
        'parse-pdoc-army.ts',
        'load-om.ts',
        'load-om-op5.ts',
        'parse-hasc-sasc-reports.ts',
        'parse-defense-approps-reports.ts',
        'parse-ndaa-conference.ts',
        'parse-defense-approps-public-law.ts',
        'ingest-defense-budget-pdf.ts',
      ]),
    );
    expect(isPeExactShaDollarLoader('load-om.ts')).toBe(true);
    expect(isPeExactShaDollarLoader('not-a-loader.ts')).toBe(false);
  });
});
