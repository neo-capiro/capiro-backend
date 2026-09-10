/**
 * qualify-defense-budget-drain-image-v1-entrypoint.spec.ts (Phase 10B-36).
 *
 * Pins the image entrypoint wiring for the new qualification verb, modeled
 * directly on accept-defense-budget-ingestion-review-entrypoint.spec.ts.
 * The single most safety-critical assertion here is the LAST one: this verb
 * must never call compose_database_url, because that helper composes the
 * REAL production Aurora connection string from DB_HOST/DB_PORT/DB_USER/
 * DB_PASSWORD/DB_NAME secrets -- calling it here would silently overwrite
 * the isolated `pg` sidecar's DATABASE_URL (127.0.0.1:5432) with production,
 * defeating the entire isolation guarantee this qualification mechanism
 * exists to provide.
 */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const entrypointPath = join(__dirname, 'entrypoint.sh');
const entrypoint = readFileSync(entrypointPath, 'utf8');

function caseBody(verb: string): string {
  const start = entrypoint.indexOf(`${verb})`);
  expect(start).toBeGreaterThan(-1);
  const end = entrypoint.indexOf(';;', start);
  expect(end).toBeGreaterThan(start);
  return entrypoint.slice(start, end);
}

describe('qualify-defense-budget-drain-image-v1 entrypoint wiring (Phase 10B-36)', () => {
  test('has its own explicit case -- does not fall through to the legacy dispatcher', () => {
    const caseIndex = entrypoint.indexOf('qualify-defense-budget-drain-image-v1)');
    const fallthroughIndex = entrypoint.indexOf('*)\n    exec /bin/sh /usr/local/lib/capiro/entrypoint-legacy.sh');
    expect(caseIndex).toBeGreaterThan(-1);
    expect(fallthroughIndex).toBeGreaterThan(-1);
    expect(caseIndex).toBeLessThan(fallthroughIndex);
  });

  test('invokes the committed script directly and forwards every argument', () => {
    expect(entrypoint).toContain(
      'exec ./node_modules/.bin/tsx scripts/qualify-defense-budget-drain-image-v1.ts "$@"',
    );
  });

  test('the intended script file actually exists', () => {
    expect(() => readFileSync(join(__dirname, 'qualify-defense-budget-drain-image-v1.ts'), 'utf8')).not.toThrow();
  });

  test('is a distinct verb from every other defense-budget dispatcher case', () => {
    const others = [
      'accept-defense-budget-ingestion-review-v1',
      'replay-defense-budget-ingestion-outbox-v1',
      'import-defense-budget-source-v1',
      'seed-army-r2-bundle-members-v1',
    ];
    const thisIndex = entrypoint.indexOf('qualify-defense-budget-drain-image-v1)');
    for (const other of others) {
      expect(thisIndex).not.toBe(entrypoint.indexOf(`${other})`));
    }
  });

  test('never calls compose_database_url -- must not overwrite the isolated sidecar DATABASE_URL with composed production Aurora credentials', () => {
    const body = caseBody('qualify-defense-budget-drain-image-v1');
    expect(body).not.toContain('compose_database_url');
    expect(body).not.toMatch(/DB_HOST|DB_PASSWORD|PROMOTER_DATABASE_URL/);
  });
});
