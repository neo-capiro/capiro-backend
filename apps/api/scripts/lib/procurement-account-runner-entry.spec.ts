import { describe, it, expect, beforeAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildAccountRunnerReceipt } from './procurement-account-runner.js';

const api = resolve(__dirname, '../..');
const id = 'CONT_AWD_0001_9700_-NONE-_-NONE-';
let ids: string;
beforeAll(() => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? 'C:/ProgramData/Hermes/cache/scratch', 'account-entry-'));
  ids = join(directory, 'awards.json'); writeFileSync(ids, JSON.stringify([id]));
});
function run(mode: string, commit = true, extra: string[] = [], changes: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ['--require', join(__dirname, 'fixtures/account-runner-preload.cjs'),
    join(api, 'node_modules/tsx/dist/cli.mjs'), 'scripts/enrich-award-pe-tas.ts', '--account-award-ids-file', ids,
    ...(commit ? ['--commit'] : []), ...extra], {
    cwd: api, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, NODE_OPTIONS: `--require ${join(__dirname, 'fixtures/account-runner-preload.cjs')}`, ACCOUNT_RUNNER_TEST: '1', ACCOUNT_RUNNER_TEST_MODE: mode,
      PROGRAM_ACQUISITION_CONTINUITY_ENABLED: 'true',
      DATABASE_URL: 'postgresql://fixture_role:URI_SECRET_CANARY@fixture.invalid/fixture?sslmode=require',
      ACCOUNT_EXPECTED_HOST: 'fixture.invalid', ACCOUNT_EXPECTED_DATABASE: 'fixture', ACCOUNT_EXPECTED_USER: 'fixture_role',
      ...changes },
  });
  expect(result.error).toBeUndefined();
  const traces = result.stdout.split('\n').filter(line => line.startsWith('ACCOUNT_TEST_TRACE='))
    .map(line => JSON.parse(line.slice('ACCOUNT_TEST_TRACE='.length)) as string[]);
  expect(traces.length).toBeGreaterThan(0);
  const events = traces.sort((a, b) => b.length - a.length)[0]!;
  const start = result.stdout.indexOf('{'), end = result.stdout.lastIndexOf('}');
  const receipt = start < 0 ? undefined : JSON.parse(result.stdout.slice(start, end + 1));
  return { code: result.status, events, receipt, stderr: result.stderr };
}

describe('actual account entrypoint lifecycle with isolated ports', () => {
  it('executes dry run without constructing or connecting any database client', () => {
    const result = run('dry', false);
    expect(result.code).toBe(0); expect(result.events).toEqual(['fetch']);
    expect(result.receipt).toMatchObject({ mode: 'DRY_RUN', status: 'VALIDATED', requested: 1 });
    expect(result.receipt.awards[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('commits once, retains TLS configuration and disconnects before normal exit', () => {
    const result = run('commit');
    expect(result.code).toBe(0);
    expect(result.events).toContain('construct:sslmode=require');
    const transactions = result.events.filter(event => event.startsWith('transaction:'));
    expect(transactions).toHaveLength(1);
    expect(Number(transactions[0]!.split(':')[1])).toBeGreaterThan(0);
    expect(Number(transactions[0]!.split(':')[1])).toBeLessThanOrEqual(15000);
    expect(result.events.filter(event => event === 'append')).toHaveLength(1);
    expect(result.events.at(-2)).toBe('commit-acknowledged'); expect(result.events.at(-1)).toBe('disconnect');
    expect(result.receipt).toMatchObject({ mode: 'COMMIT', status: 'COMMITTED', inserted: 1, existing: 0 });
  });
  it('reports lost commit acknowledgement as unresolved without retry or secret leakage', () => {
    const result = run('lost-ack');
    expect(result.code).toBe(1); expect(result.events.filter(event => event === 'append')).toHaveLength(1);
    expect(result.events.at(-1)).toBe('disconnect');
    expect(result.receipt).toMatchObject({ status: 'TRANSACTION_OUTCOME_UNRESOLVED', inserted: null, existing: null });
    expect(result.stderr).not.toContain('SERVER_SECRET_CANARY');
  });
  it('withholds arbitrary server error text and disconnects after identity-read failure', () => {
    const result = run('secret-error');
    expect(result.code).toBe(1); expect(result.stderr).not.toContain('SERVER_SECRET_CANARY');
    expect(result.events).not.toContain('append'); expect(result.events.at(-1)).toBe('disconnect');
  });
  it('refuses an effective target mismatch without writing and still disconnects', () => {
    const result = run('wrong-role');
    expect(result.code).toBe(2); expect(result.events).not.toContain('append');
    expect(result.events.at(-1)).toBe('disconnect');
  });
  it('does not echo arbitrary argument contents on parser failure', () => {
    const result = run('dry', false, ['PRIVATE_ARGUMENT_CANARY']);
    expect(result.code).toBe(2); expect(result.events).toEqual([]);
    expect(result.stderr).not.toContain('PRIVATE_ARGUMENT_CANARY');
  });
  it('refuses a configured wrong target before source or DB access', () => {
    const result = run('commit', true, [], { ACCOUNT_EXPECTED_HOST: 'different.invalid' });
    expect(result.code).toBe(2); expect(result.events).toEqual([]);
    expect(result.stderr).not.toContain('URI_SECRET_CANARY');
  });
  it('never calls a cohort committed when its acknowledgement set is incomplete', () => {
    const cohort = [{ awardUniqueId: id, outcome: { ok: true as const,
      page: { rawText: '{}', sha256: 'a'.repeat(64), sourceObservedAt: '2026-11-05T00:00:00.000000Z', rowCount: 0 } } }];
    const result = buildAccountRunnerReceipt(cohort, { committed: true, acknowledgements: [] });
    expect(result.status).toBe('TRANSACTION_OUTCOME_UNRESOLVED'); expect(result.inserted).toBeNull();
  });
});
