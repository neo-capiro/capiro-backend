import type { PrismaClient } from '@prisma/client';
import { resolve } from 'node:path';
import { parseFiniteSamConfig, runFiniteSamCohort, type FiniteSamConfig, type FiniteSamPorts } from './sam-finite-cohort.js';
import { awardKey, type AwardCandidate, type SamRecord } from './sam-contract-action.js';
import { sha256Bytes } from './sam-finite-evidence.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const ENV = { SAM_GOV_API_KEY: 'synthetic-private-api-key', PROGRAM_ACQUISITION_CONTINUITY_ENABLED: 'true' };
function candidate(piid = '000123', agency = '9700'): AwardCandidate {
  const awardUniqueId = `CONT_AWD_${piid}_${agency}_-NONE-_-NONE-`;
  return { piid, awardUniqueId, identityKey: awardKey(awardUniqueId)! };
}
function record(piid: string | number = '000123', agency = '9700'): SamRecord {
  return { contractId: { piid, subtier: { code: agency }, modificationNumber: 0, transactionNumber: 0 },
    coreData: { awardOrIDV: 'AWARD', awardOrIDVType: { code: 'D' } },
    awardDetails: { dollars: { actionObligation: '-1.23' }, dates: { dateSigned: '2026-10-01' },
      transactionData: { lastModifiedDate: '2026-10-02T00:00:00.123456Z' } } };
}
function setup(keys = [candidate().identityKey], extra: string[] = [], env = ENV) {
  const raw = Buffer.from(JSON.stringify(keys));
  const args = ['--award-keys-file', 'synthetic-cohort.json', '--award-keys-sha256', sha256Bytes(raw),
    '--evidence-dir', resolve('synthetic-private/new-run'), '--expires-at', '2026-11-01T12:02:00Z',
    '--producer-commit', 'a'.repeat(40), '--image-digest', `sha256:${'b'.repeat(64)}`, '--run-id', 'synthetic-run', '--target-id', 'synthetic-target', ...extra];
  return { raw, args, config: parseFiniteSamConfig(args, env, NOW, () => raw) };
}
function harness(config: FiniteSamConfig, records: SamRecord[] = [record()], candidates = [candidate()]) {
  let now = NOW;
  const files = new Map<string, Buffer>();
  const writes: Array<Record<string, unknown>> = [];
  const tx = { $executeRaw: jest.fn(async (..._args: unknown[]) => 0), $queryRaw: jest.fn(async (...args: unknown[]) => {
    return String(args[0]).includes('FROM public.federal_award') ? candidates : [];
  }), acquisitionAwardTransactionRevision: {
    findUnique: jest.fn(async () => null), findFirst: jest.fn(async () => null),
    create: jest.fn(async (input: { data: Record<string, unknown> }) => {
      expect(files.has('write-intent.json')).toBe(true); writes.push(input.data); return { id: `synthetic-row-${writes.length}` };
    }),
  } };
  const client = { $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>, _options?: unknown) => work(tx)),
    $disconnect: jest.fn(async () => {}) };
  const fetchMock = jest.fn(async () => new Response(JSON.stringify({ awardSummary: records, totalRecords: records.length })));
  const createClient = jest.fn(() => client as unknown as PrismaClient);
  const write = jest.fn((name: string, content: Uint8Array) => {
    if (files.has(name)) throw new Error('exclusive evidence already exists');
    files.set(name, Buffer.from(content));
  });
  const ports: FiniteSamPorts = { createClient, createEvidence: jest.fn(() => ({ write })), fetch: fetchMock as typeof fetch, now: () => now };
  return { config, ports, files, writes, tx, client, fetchMock, createClient, write, setNow: (value: number) => { now = value; } };
}

describe('finite SAM configuration', () => {
  it('binds exact bytes, numeric and leading-zero full identities, and two-key write admission', () => {
    const keys = [candidate('1').identityKey, candidate('000123').identityKey];
    const { raw, config } = setup(keys, ['--commit']);
    expect(config.keys).toEqual(keys); expect(config.cohortSha256).toBe(sha256Bytes(raw)); expect(config.enabled).toBe(true);
    expect(setup(keys).config.enabled).toBe(false);
    expect(setup(keys, ['--commit'], { ...ENV, PROGRAM_ACQUISITION_CONTINUITY_ENABLED: 'false' }).config.enabled).toBe(false);
  });
  it.each([
    { keys: [] }, { keys: ['000123'] }, { keys: [candidate().identityKey, candidate().identityKey] },
    { keys: Array.from({ length: 26 }, (_, index) => candidate(String(index)).identityKey) },
    { keys: [candidate().identityKey.replace('-NONE-_-NONE-', 'PARENT_-NONE-')] },
  ])('rejects invalid finite scope without calling resources (%j)', ({ keys }) => {
    expect(() => setup(keys)).toThrow();
  });
  it('rejects digest mismatch, malformed JSON, oversized bytes, expired or mixed/duplicate flags', () => {
    const { args, raw } = setup();
    for (const bytes of [Buffer.from('['), Buffer.from(' '.repeat(16385)), Buffer.from(JSON.stringify([candidate('other').identityKey]))])
      expect(() => parseFiniteSamConfig(args, ENV, NOW, () => bytes)).toThrow();
    for (const flags of [['--pages', '1'], ['--commit', '--commit'], ['--max-pages', '26'], ['--max-pages', '1', '--max-pages', '1'],
      ['--max-records', '2501'], ['--max-body-bytes', '2097153'], ['--max-total-bytes', '16777217'], ['--task-timeout-ms', '120001'], ['--response-timeout-ms', '10001']])
      expect(() => parseFiniteSamConfig([...args, ...flags], ENV, NOW, () => raw)).toThrow();
    expect(() => parseFiniteSamConfig(args, ENV, NOW + 120001, () => raw)).toThrow('FINITE_EXPIRY_INVALID');
    expect(() => setup([candidate('1').identityKey, candidate('2').identityKey], ['--max-pages', '1'])).toThrow('FINITE_PAGE_BUDGET');
    const malformed = Buffer.from('['), matchingArgs = [...args]; matchingArgs[3] = sha256Bytes(malformed);
    expect(() => parseFiniteSamConfig(matchingArgs, ENV, NOW, () => malformed)).toThrow('FINITE_COHORT_JSON_INVALID');
  });
});

describe('one finite staged population, canonical writer only', () => {
  it('retains exact raw numeric bytes and resolves all pages before any append', async () => {
    const h = harness(setup([candidate().identityKey], ['--commit']).config);
    const body = JSON.stringify({ awardSummary: [record()], totalRecords: 1 }).replace('"-1.23"', '70368744177664.01');
    h.fetchMock.mockImplementation(async () => new Response(body));
    const receipt = await runFiniteSamCohort(h.config, h.ports);
    expect(receipt.state).toBe('COMPLETED_BOUNDED'); expect(receipt.inserted).toBe(1);
    expect(h.files.get('page-1.bin')!.toString()).toBe(body);
    expect(receipt.artifacts.find((item) => item.file === 'page-1.bin')!.sha256).toBe(sha256Bytes(Buffer.from(body)));
    expect(h.writes[0]).toMatchObject({ signedObligationDelta: '70368744177664.01', signedOutlayDelta: null, awardIdentityKey: candidate().identityKey });
    expect(JSON.stringify(h.writes[0])).toContain('"$samDecimalLexeme":"70368744177664.01"');
    expect(receipt.pages[0]).toMatchObject({ offset: 0, limit: 100, attempts: 1, status: 200, observedAt: '2026-11-01T12:00:00.000Z' });
    expect(receipt.provisionalRows[0]).toMatchObject({ file: 'page-1.bin', row: 0, awardIdentityKey: candidate().identityKey });
    expect(h.client.$disconnect).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(receipt)).not.toContain(ENV.SAM_GOV_API_KEY);
    const options = h.client.$transaction.mock.calls[0]![1] as { timeout: number; maxWait: number; isolationLevel: string };
    expect(options.timeout + options.maxWait).toBeLessThanOrEqual(15000); expect(options.isolationLevel).toBe('ReadCommitted');
    expect(h.tx.$executeRaw.mock.calls.map((call) => String(call[0])).join(' ')).toContain('lock_timeout');
  });
  it('makes one page-zero request per deduplicated PIID and marks full-page history incomplete', async () => {
    const keys = [candidate().identityKey, candidate('000123', '1700').identityKey];
    const h = harness(setup(keys).config, Array.from({ length: 100 }, () => record()), [candidate(), candidate('000123', '1700')]);
    const receipt = await runFiniteSamCohort(h.config, h.ports);
    expect(h.fetchMock).toHaveBeenCalledTimes(1); expect(receipt.state).toBe('DRY_RUN');
    expect(receipt.pages[0]!.historyIncomplete).toBe(true); expect(receipt.examined).toBe(100); expect(h.writes).toHaveLength(0);
    expect(h.tx.$executeRaw.mock.calls.map((call) => String(call[0])).join(' ')).toContain('READ ONLY');
  });
  it('evaluates the complete candidate set before excluding same-PIID other full awards', async () => {
    const h = harness(setup(undefined, ['--commit']).config, [record(), record('000123', '1700')], [candidate(), candidate('000123', '1700')]);
    const result = await runFiniteSamCohort(h.config, h.ports);
    expect(result.rejected).toEqual({ out_of_scope: 1 }); expect(result.mapped).toBe(1); expect(result.outcomes).toHaveLength(2);
    expect(h.writes).toHaveLength(1); expect(h.writes[0]!.awardIdentityKey).toBe(candidate().identityKey);
  });
  it('refuses absent, malformed or 26th catalog pair before first append', async () => {
    for (const candidates of [[], [{ ...candidate(), identityKey: 'wrong' }], Array.from({ length: 26 }, (_, index) => candidate(String(index)))]) {
      const h = harness(setup(undefined, ['--commit']).config, [record()], candidates);
      const receipt = await runFiniteSamCohort(h.config, h.ports);
      expect(receipt.reason).toBe('FINITE_CATALOG_SCOPE_INVALID'); expect(h.writes).toHaveLength(0); expect(receipt.inserted).toBe(0);
    }
  });
  it('refuses every staged append when a later record is malformed or a source-clock fork', async () => {
    const fork = record(); fork.awardDetails!.dollars!.actionObligation = '5.00';
    for (const bad of [{}, fork]) {
      const h = harness(setup(undefined, ['--commit']).config, [record(), bad]);
      const receipt = await runFiniteSamCohort(h.config, h.ports);
      expect(receipt.state).toBe('REFUSED'); expect(receipt.reason).toBe('FINITE_STAGED_MAPPING_REFUSED');
      expect(h.writes).toHaveLength(0); expect(receipt.outcomes).toHaveLength(2);
      expect(receipt.mapped + Object.values(receipt.rejected).reduce((sum, n) => sum + n, 0)).toBe(2);
    }
  });
  it('refuses a later failed page or row bound without constructing a DB client', async () => {
    const h = harness(setup([candidate('1').identityKey, candidate('2').identityKey], ['--commit']).config);
    h.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ awardSummary: [record('1')] }))).mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    const receipt = await runFiniteSamCohort(h.config, h.ports);
    expect(receipt.state).toBe('REFUSED'); expect(receipt.pages[1]!.status).toBe(503); expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(h.files.has('page-1.bin')).toBe(true); expect(h.files.has('page-2.bin')).toBe(true); expect(h.createClient).not.toHaveBeenCalled();
    expect(receipt.unvalidated).toBe(1); expect(receipt.outcomes[0]!.outcome).toBe('staged_not_validated');
    const tooMany = harness(setup(undefined, ['--max-records', '1']).config, [record(), record()]);
    expect((await runFiniteSamCohort(tooMany.config, tooMany.ports)).reason).toBe('FINITE_ROW_LIMIT'); expect(tooMany.createClient).not.toHaveBeenCalled();
  });
  it('refuses visible prior run and evidence failure, preserving exclusive invocation evidence', async () => {
    const h = harness(setup(undefined, ['--commit']).config);
    h.tx.$queryRaw.mockImplementation(async (...args: unknown[]) => String(args[0]).includes('FROM public.federal_award') ? [candidate()] : [{ present: true }] as never);
    expect((await runFiniteSamCohort(h.config, h.ports)).reason).toBe('FINITE_PRIOR_RUN_REFUSED'); expect(h.writes).toHaveLength(0);
    const failed = harness(setup(undefined, ['--commit']).config);
    failed.write.mockImplementation((file) => { if (file === 'page-1.bin') throw new Error('fsync failed'); });
    expect((await runFiniteSamCohort(failed.config, failed.ports)).state).toBe('REFUSED'); expect(failed.createClient).not.toHaveBeenCalled();
    await expect(runFiniteSamCohort(h.config, h.ports)).rejects.toThrow('exclusive');
  });
  it('keeps provisional rows but never claims durable counts after lost commit acknowledgement or final receipt failure', async () => {
    for (const failure of ['commit', 'receipt']) {
      const h = harness(setup(undefined, ['--commit']).config);
      if (failure === 'commit') h.client.$transaction.mockImplementation(async (work) => { await work(h.tx); throw new Error('lost acknowledgement'); });
      else h.write.mockImplementation((name, content) => { if (name === 'receipt.json') throw new Error('disk failure'); h.files.set(name, Buffer.from(content)); });
      const receipt = await runFiniteSamCohort(h.config, h.ports);
      expect(receipt.state).toBe('TRANSACTION_OUTCOME_UNRESOLVED'); expect(receipt.inserted).toBeNull(); expect(receipt.existing).toBeNull();
      expect(receipt.provisionalRows).toHaveLength(1); expect(h.fetchMock).toHaveBeenCalledTimes(1); expect(h.client.$transaction).toHaveBeenCalledTimes(1);
      expect(JSON.parse(h.files.get('write-intent.json')!.toString())).toMatchObject({ state: 'TRANSACTION_OUTCOME_UNRESOLVED', inserted: null, existing: null });
    }
  });
  it('does not admit writes after expiry and refuses late cleanup as successful completion', async () => {
    const h = harness(setup(undefined, ['--commit']).config);
    h.tx.$queryRaw.mockImplementation(async () => { h.setNow(NOW + 120001); return [candidate()]; });
    expect((await runFiniteSamCohort(h.config, h.ports)).state).toBe('REFUSED'); expect(h.writes).toHaveLength(0);
    const late = harness(setup(undefined, ['--commit']).config);
    late.client.$disconnect.mockImplementation(async () => { late.setNow(NOW + 120001); });
    const receipt = await runFiniteSamCohort(late.config, late.ports);
    expect(receipt.state).toBe('TRANSACTION_OUTCOME_UNRESOLVED'); expect(receipt.inserted).toBeNull();
  });
  it('does not make a second HTTP request once the aggregate byte allowance is exhausted', async () => {
    const body = JSON.stringify({ awardSummary: [record('1')] });
    const h = harness(setup([candidate('1').identityKey, candidate('2').identityKey], ['--max-total-bytes', String(Buffer.byteLength(body))]).config);
    h.fetchMock.mockImplementation(async () => new Response(body));
    const receipt = await runFiniteSamCohort(h.config, h.ports);
    expect(receipt.reason).toBe('FINITE_TOTAL_BODY_LIMIT'); expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.createClient).not.toHaveBeenCalled(); expect(receipt.unvalidated).toBe(1);
  });
  it('retains superseding expiry evidence if final fsync consumes the remaining deadline', async () => {
    const h = harness(setup(undefined, ['--commit']).config);
    h.write.mockImplementation((file, content) => { h.files.set(file, Buffer.from(content)); if (file === 'receipt.json') h.setNow(NOW + 120001); });
    const receipt = await runFiniteSamCohort(h.config, h.ports);
    expect(receipt.state).toBe('TRANSACTION_OUTCOME_UNRESOLVED'); expect(receipt.inserted).toBeNull();
    expect(JSON.parse(h.files.get('task-expired.json')!.toString())).toMatchObject({ inserted: null, supersedesReceipt: true, serverTerminationOrRollbackEstablished: false });
    expect(h.writes).toHaveLength(1);
  });
});
