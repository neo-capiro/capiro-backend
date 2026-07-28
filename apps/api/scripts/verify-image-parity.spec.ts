import { describe, expect, test } from '@jest/globals';
import { DEFAULT_PAIRS, evaluate, formatReport, parseArgs } from './verify-image-parity.js';

const A = 'sha256:13a3a19f955236e50f1571e5302b9e028615bdc07c4b0faf7eb7795aa2496812';
const B = 'sha256:336db299ea4204b5555936f4742129dc7b467a5e88b5ad25b3591bdede76c0b0';
const SHA = '1cdd372f0409986ac238beef2c4e9f310925fb37';

describe('parseArgs', () => {
  test('defaults to the whole capiro-dev cluster', () => {
    const o = parseArgs(['node', 's']);
    expect(o.cluster).toBe('capiro-dev');
    expect(o.service).toBeNull();
  });

  test('--service scopes to one, empty means all', () => {
    expect(parseArgs(['node', 's', '--service=capiro-dev-api']).service).toBe('capiro-dev-api');
    expect(parseArgs(['node', 's', '--service=']).service).toBeNull();
  });
});

describe('evaluate', () => {
  test('identical digests are parity', () => {
    const r = evaluate('capiro-dev-api', 'capiro/dev/api', A, A, ['latest', SHA]);
    expect(r.match).toBe(true);
  });

  test('this is the HP-07 case: :latest moved but nobody ran update-service', () => {
    // QA on 2026-07-27 found capiro-dev-intel-api serving 13ac6c6d while
    // :latest had been rebuilt from 1f428b82. The cron would have picked up the
    // newer code at the next tick; the HTTP service would not.
    const r = evaluate('capiro-dev-intel-api', 'capiro/dev/intel-api', A, B, ['latest', SHA]);
    expect(r.match).toBe(false);
    expect(r.note).toContain('update-service');
  });

  test('a service with no running task is a failure, not a pass', () => {
    const r = evaluate('capiro-dev-web', 'capiro/dev/web', A, null, ['latest']);
    expect(r.match).toBe(false);
    expect(r.note).toContain('no RUNNING task');
  });

  test('a missing :latest tag is a failure, not a pass', () => {
    const r = evaluate('capiro-dev-api', 'capiro/dev/api', null, A, []);
    expect(r.match).toBe(false);
    expect(r.note).toContain('no :latest tag');
  });
});

describe('formatReport', () => {
  test('a clean run reports parity and surfaces the commit', () => {
    const out = formatReport([evaluate('capiro-dev-api', 'capiro/dev/api', A, A, ['latest', SHA])]);
    expect(out).toContain('OK');
    expect(out).toContain('in parity');
    expect(out).toContain('1cdd372f');
    expect(out).not.toContain('DRIFT');
  });

  test('a mismatch names the remedy', () => {
    const out = formatReport([evaluate('capiro-dev-intel-api', 'capiro/dev/intel-api', A, B, [])]);
    expect(out).toContain('DRIFT');
    expect(out).toContain('out of parity');
  });
});

describe('DEFAULT_PAIRS', () => {
  test('covers the three services LegiWatch is served from', () => {
    expect(DEFAULT_PAIRS.map((p) => p.service)).toEqual([
      'capiro-dev-intel-api',
      'capiro-dev-api',
      'capiro-dev-web',
    ]);
  });
});
