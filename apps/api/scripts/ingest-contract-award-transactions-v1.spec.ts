import type { PrismaClient } from '@prisma/client';
import { resolve } from 'node:path';
import * as evidence from './lib/sam-finite-evidence.js';
import { runSamActionProducerCli } from './ingest-contract-award-transactions-v1.js';
import type { FiniteSamPorts } from './lib/sam-finite-cohort.js';

const key = 'usaspending|award|CONT_AWD_000123_9700_-NONE-_-NONE-';
const NOW = Date.parse('2026-11-01T12:00:00Z');
function fixture() {
  const raw = Buffer.from(JSON.stringify([key]));
  const args = ['--award-keys-file', 'synthetic-cohort.json', '--award-keys-sha256', evidence.sha256Bytes(raw),
    '--evidence-dir', resolve('synthetic-evidence/new-run'), '--expires-at', '2026-11-01T12:02:00Z',
    '--producer-commit', 'a'.repeat(40), '--image-digest', `sha256:${'b'.repeat(64)}`, '--run-id', 'synthetic-run', '--target-id', 'synthetic-target'];
  const files = new Map<string, Buffer>();
  const fetcher = jest.fn(async () => new Response('unavailable', { status: 503 }));
  const createClient = jest.fn(() => { throw new Error('unexpected DB resource'); });
  const ports: FiniteSamPorts = { now: () => NOW, fetch: fetcher as typeof fetch, createClient: createClient as () => PrismaClient,
    createEvidence: () => ({ write: (file, bytes) => { if (files.has(file)) throw new Error('exclusive'); files.set(file, Buffer.from(bytes)); } }) };
  return { raw, args, files, fetcher, createClient, ports };
}
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
describe('existing SAM producer finite CLI boundary', () => {
  it('imports safely, and help performs no file, provider or DB effects', async () => {
    const h = fixture();
    const read = jest.spyOn(evidence, 'readCohortFile'); const log = jest.spyOn(console, 'log').mockImplementation();
    expect(await runSamActionProducerCli(['--help'], {}, h.ports)).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Exit 0')); expect(read).not.toHaveBeenCalled();
    expect(h.fetcher).not.toHaveBeenCalled(); expect(h.createClient).not.toHaveBeenCalled();
  });
  it.each(['--max-pages', '--max-records', '--max-body-bytes', '--max-total-bytes', '--response-timeout-ms', '--task-timeout-ms', '--award-keys-file=unsafe'])
  ('never falls through to legacy mode for malformed finite-only option %s', async (option) => {
    const h = fixture();
    await expect(runSamActionProducerCli([option, '1', '--from', '2026-01-01', '--to', '2026-02-01'], {}, h.ports)).rejects.toThrow('FINITE_');
    expect(h.fetcher).not.toHaveBeenCalled(); expect(h.createClient).not.toHaveBeenCalled();
  });
  it('reports safe counts only and nonzero refusal with private retained source evidence', async () => {
    const h = fixture(); jest.spyOn(evidence, 'readCohortFile').mockReturnValue(h.raw);
    const log = jest.spyOn(console, 'log').mockImplementation();
    expect(await runSamActionProducerCli(h.args, { SAM_GOV_API_KEY: 'synthetic-secret' }, h.ports)).toBe(1);
    const stdout = String(log.mock.calls[0]![0]); expect(stdout).not.toContain('synthetic-secret'); expect(stdout).not.toContain(key);
    expect(stdout).toContain('SOURCE_HTTP_503'); expect(h.files.has('receipt.json')).toBe(true);
  });
  it('does not expose a private path from configuration or evidence allocation errors', async () => {
    const h = fixture(); jest.spyOn(evidence, 'readCohortFile').mockImplementation(() => { throw new Error('ENOENT private-customer-path'); });
    await expect(runSamActionProducerCli(h.args, { SAM_GOV_API_KEY: 'synthetic-secret' }, h.ports)).rejects.toThrow('FINITE_CONFIGURATION_OR_EVIDENCE_FAILED');
    expect(h.fetcher).not.toHaveBeenCalled(); expect(h.createClient).not.toHaveBeenCalled();
  });
  it('runs task watchdog over a pending body, retains expiry evidence, and does not replay', async () => {
    jest.useFakeTimers();
    const h = fixture(); jest.spyOn(evidence, 'readCohortFile').mockReturnValue(h.raw); jest.spyOn(console, 'log').mockImplementation();
    h.fetcher.mockImplementation(async () => new Response(new ReadableStream({ start(controller) {
      setTimeout(() => controller.error(new Error('synthetic body failure')), 20);
    } })));
    const expire = jest.fn();
    const run = runSamActionProducerCli([...h.args, '--task-timeout-ms', '10'], { SAM_GOV_API_KEY: 'synthetic-secret' }, h.ports, expire);
    await jest.advanceTimersByTimeAsync(21); expect(await run).toBe(1);
    expect(expire).toHaveBeenCalledTimes(1); expect(h.files.has('task-expired.json')).toBe(true);
    expect(JSON.parse(h.files.get('task-expired.json')!.toString())).toMatchObject({ inserted: 0, serverTerminationOrRollbackEstablished: false });
    expect(h.fetcher).toHaveBeenCalledTimes(1); expect(h.createClient).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
  });
});
