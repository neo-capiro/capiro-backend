import { describe, expect, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const entrypointPath = join(__dirname, 'entrypoint.sh');
const entrypoint = readFileSync(entrypointPath, 'utf8');

describe('accept-defense-budget-ingestion-review-v1 entrypoint wiring (Phase 10B-15 Parts E/F)', () => {
  test('has its own explicit case -- does not fall through to the legacy dispatcher', () => {
    const caseIndex = entrypoint.indexOf('accept-defense-budget-ingestion-review-v1)');
    const fallthroughIndex = entrypoint.indexOf('*)\n    exec /bin/sh /usr/local/lib/capiro/entrypoint-legacy.sh');
    expect(caseIndex).toBeGreaterThan(-1);
    expect(fallthroughIndex).toBeGreaterThan(-1);
    expect(caseIndex).toBeLessThan(fallthroughIndex);
  });

  test('composes DATABASE_URL through the normal controlled helper before invoking the script', () => {
    const caseBody = entrypoint.slice(
      entrypoint.indexOf('accept-defense-budget-ingestion-review-v1)'),
      entrypoint.indexOf(';;', entrypoint.indexOf('accept-defense-budget-ingestion-review-v1)')),
    );
    expect(caseBody).toContain('compose_database_url');
    expect(caseBody).not.toMatch(/PROMOTER_DATABASE_URL/);
  });

  test('invokes the intended script and forwards every argument', () => {
    expect(entrypoint).toContain(
      'exec ./node_modules/.bin/tsx scripts/accept-defense-budget-ingestion-review-v1.ts "$@"',
    );
  });

  test('the intended script file actually exists', () => {
    expect(() =>
      readFileSync(join(__dirname, 'accept-defense-budget-ingestion-review-v1.ts'), 'utf8'),
    ).not.toThrow();
  });

  test('remains exact-row only -- no batch/family/FY sweep flag is ever composed for this verb in the entrypoint', () => {
    const caseBody = entrypoint.slice(
      entrypoint.indexOf('accept-defense-budget-ingestion-review-v1)'),
      entrypoint.indexOf(';;', entrypoint.indexOf('accept-defense-budget-ingestion-review-v1)')),
    );
    expect(caseBody).not.toMatch(/--all|--batch|--family|--fiscal-year|--sweep/);
  });

  test('is a distinct verb from the REJECT-replay command -- never the same case', () => {
    expect(entrypoint.indexOf('accept-defense-budget-ingestion-review-v1)')).not.toBe(
      entrypoint.indexOf('replay-defense-budget-ingestion-outbox-v1)'),
    );
  });
});

describe('the dispatcher is valid shell', () => {
  function parses(file: string): 'ok' | 'no-shell' | string {
    try {
      execFileSync('sh', ['-n', file], { stdio: 'pipe' });
      return 'ok';
    } catch (err) {
      const e = err as { code?: string; stderr?: Buffer };
      if (e.code === 'ENOENT') return 'no-shell';
      return e.stderr?.toString().trim() || 'parse failed';
    }
  }

  test('entrypoint.sh parses', () => {
    const result = parses(entrypointPath);
    if (result === 'no-shell') return;
    expect(result).toBe('ok');
  });
});
