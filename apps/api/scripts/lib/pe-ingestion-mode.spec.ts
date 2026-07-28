import { describe, expect, test } from '@jest/globals';
import {
  resolveDefenseBudgetIngestPosture,
  usesDeprecatedDryRunAlias,
} from './defense-budget-ingest-mode.js';

describe('resolveDefenseBudgetIngestPosture', () => {
  test('defaults to preflight when no write or extraction flag is present', () => {
    expect(
      resolveDefenseBudgetIngestPosture([
        '--path',
        'budget.pdf',
        '--mode',
        'pdf_fast',
        '--fy',
        '2027',
      ]),
    ).toBe('preflight');
  });

  test('--extract-only permits external extraction without canonical writes', () => {
    expect(resolveDefenseBudgetIngestPosture(['--extract-only'])).toBe('extract_only');
  });

  test('deprecated --dry-run remains an extract-only alias', () => {
    expect(resolveDefenseBudgetIngestPosture(['--dry-run'])).toBe('extract_only');
    expect(usesDeprecatedDryRunAlias(['--dry-run'])).toBe(true);
  });

  test('--commit is detected so the caller can fail closed before configuration or I/O', () => {
    expect(resolveDefenseBudgetIngestPosture(['--commit'])).toBe('commit');
  });

  test.each([
    [['--commit', '--extract-only']],
    [['--commit', '--dry-run']],
    [['--extract-only', '--dry-run']],
  ])('rejects incompatible posture flags: %j', (argv) => {
    expect(() => resolveDefenseBudgetIngestPosture(argv)).toThrow(
      'Choose exactly one ingestion posture',
    );
  });

  test('--allow-vendor-parse alone does not silently opt into extraction', () => {
    expect(resolveDefenseBudgetIngestPosture(['--allow-vendor-parse'])).toBe('preflight');
  });

  test('does not treat unrelated flags as a posture', () => {
    expect(resolveDefenseBudgetIngestPosture(['--limit', '10', '--only', 'rdte'])).toBe(
      'preflight',
    );
    expect(usesDeprecatedDryRunAlias(['--extract-only'])).toBe(false);
  });
});
