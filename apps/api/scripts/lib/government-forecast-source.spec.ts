import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseRefreshArgs, runRefresh } from '../refresh-government-forecasts.js';
import { validateImportReceipt } from './government-forecast-import.js';
import {
  AGENDA_LISTING,
  collectOfficialAgenda,
  currentAgendaEdition,
} from './government-forecast-source.js';

const sourceUrl =
  'https://www.reginfo.gov/public/do/XMLViewFileAction?f=REGINFO_RIN_DATA_202510.xml';
const listing = `<a href="${sourceUrl}">2026 Data</a>`;
const xml =
  '<REGINFO_RIN_DATA RUN_DATE="2026-07-03-04:00"><RIN_INFO><RIN>1234-AA01</RIN><RULE_TITLE>Synthetic forecast</RULE_TITLE><PUBLICATION><PUBLICATION_ID>202510</PUBLICATION_ID></PUBLICATION><RULE_STAGE>Proposed Rule Stage</RULE_STAGE><TIMETABLE_LIST><TIMETABLE><TTBL_ACTION>NPRM</TTBL_ACTION><TTBL_DATE>11/00/2026</TTBL_DATE></TIMETABLE></TIMETABLE_LIST></RIN_INFO></REGINFO_RIN_DATA>';
function response(
  url: string,
  body: ConstructorParameters<typeof Response>[0],
  type: string,
  headers = {},
) {
  const result = new Response(body, { headers: { 'content-type': type, ...headers } });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}
function sourceDeps() {
  return {
    fetch: jest.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url) === AGENDA_LISTING
        ? response(AGENDA_LISTING, listing, 'text/html')
        : response(sourceUrl, xml, 'application/xml'),
    ),
    now: () => new Date('2026-11-01T12:00:00.000Z'),
    retain: jest.fn(async (_name: string, _bytes: Uint8Array) => undefined),
  };
}

describe('bounded official Unified Agenda collection', () => {
  afterEach(() => jest.restoreAllMocks());
  it('retains exact source and both listings with actual clock, hash and no inferred issue date', async () => {
    const deps = sourceDeps();
    const result = await collectOfficialAgenda(deps);
    expect(result).toMatchObject({
      edition: '202510',
      sha256: createHash('sha256').update(xml).digest('hex'),
      observedAt: '2026-11-01T12:00:00.000Z',
      publisherIssuedAt: null,
      candidates: 1,
    });
    expect(deps.retain.mock.calls.map((c) => c[0])).toEqual([
      'listing-before.html',
      'source.xml',
      'listing-after.html',
    ]);
    expect(deps.retain).toHaveBeenCalledWith('source.xml', Buffer.from(xml));
    expect(deps.fetch.mock.calls.map((c) => c[0])).toEqual([
      AGENDA_LISTING,
      sourceUrl,
      AGENDA_LISTING,
    ]);
    for (const call of deps.fetch.mock.calls)
      expect(call[1]).toMatchObject({
        redirect: 'error',
        signal: expect.any(AbortSignal),
        headers: { 'Cache-Control': 'no-cache, no-store' },
      });
  });
  it('chooses only canonical official links and a valid latest edition', () => {
    expect(
      currentAgendaEdition(
        `<a href="/public/do/XMLViewFileAction?f=REGINFO_RIN_DATA_202504.xml">old</a>${listing}<a href="https://evil.test/?f=REGINFO_RIN_DATA_202612.xml">bad</a>`,
      ),
    ).toBe('202510');
    expect(() =>
      currentAgendaEdition(
        '<a href="https://www.reginfo.gov.evil.test/?f=REGINFO_RIN_DATA_202510.xml">bad</a>',
      ),
    ).toThrow('OFFICIAL_EDITION_UNAVAILABLE');
    expect(() =>
      currentAgendaEdition(
        '<a href="/public/do/XMLViewFileAction?f=REGINFO_RIN_DATA_202513.xml">bad</a>',
      ),
    ).toThrow();
  });
  it('refuses edition changes during collection after retaining both responses', async () => {
    const deps = sourceDeps();
    deps.fetch
      .mockResolvedValueOnce(response(AGENDA_LISTING, listing, 'text/html'))
      .mockResolvedValueOnce(response(sourceUrl, xml, 'text/xml'))
      .mockResolvedValueOnce(
        response(AGENDA_LISTING, listing.replaceAll('202510', '202604'), 'text/html'),
      );
    await expect(collectOfficialAgenda(deps)).rejects.toThrow('OFFICIAL_EDITION_CHANGED');
    expect(deps.retain).toHaveBeenCalledTimes(3);
  });
  it.each(['status', 'host', 'media', 'length'])(
    'refuses invalid %s without retries',
    async (kind) => {
      const deps = sourceDeps();
      const item = response(
        kind === 'host' ? 'https://evil.test/' : AGENDA_LISTING,
        listing,
        kind === 'media' ? 'application/json' : 'text/html',
        kind === 'length' ? { 'content-length': '1048577' } : {},
      );
      if (kind === 'status') Object.defineProperty(item, 'status', { value: 503 });
      deps.fetch.mockResolvedValue(item);
      await expect(collectOfficialAgenda(deps)).rejects.toThrow('OFFICIAL_RESPONSE_');
      expect(deps.fetch).toHaveBeenCalledTimes(1);
    },
  );
  it('enforces actual streamed bytes even without content-length', async () => {
    const deps = sourceDeps();
    deps.fetch.mockResolvedValue(
      response(AGENDA_LISTING, new Uint8Array(1024 * 1024 + 1), 'text/html'),
    );
    await expect(collectOfficialAgenda(deps)).rejects.toThrow('OFFICIAL_RESPONSE_TOO_LARGE');
  });
  it('bounds XML bytes separately at 40 MiB', async () => {
    const deps = sourceDeps();
    deps.fetch
      .mockResolvedValueOnce(response(AGENDA_LISTING, listing, 'text/html'))
      .mockResolvedValueOnce(
        response(sourceUrl, xml, 'application/xml', {
          'content-length': String(40 * 1024 * 1024 + 1),
        }),
      );
    await expect(collectOfficialAgenda(deps)).rejects.toThrow('OFFICIAL_RESPONSE_TOO_LARGE');
  });
  it('has one whole-collection deadline and aborts a stalled request without retry', async () => {
    const actualTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => actualTimeout(10));
    const deps = sourceDeps();
    deps.fetch.mockImplementation(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), {
            once: true,
          });
        }),
    );
    await expect(collectOfficialAgenda(deps)).rejects.toThrow('OFFICIAL_FETCH_FAILED');
    expect(timeout).toHaveBeenCalledWith(90000);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['utf8', 'edition'])('rejects %s XML, retaining its original bytes', async (kind) => {
    const deps = sourceDeps();
    const body = kind === 'utf8' ? new Uint8Array([0xff]) : xml.replaceAll('202510', '202504');
    deps.fetch
      .mockResolvedValueOnce(response(AGENDA_LISTING, listing, 'text/html'))
      .mockResolvedValueOnce(response(sourceUrl, body, 'application/xml'));
    await expect(collectOfficialAgenda(deps)).rejects.toThrow('OFFICIAL_SNAPSHOT_UNQUALIFIED');
    expect(deps.retain).toHaveBeenCalledWith('source.xml', expect.any(Buffer));
  });
  it('does not relabel an archive failure as a source-check failure', async () => {
    const deps = sourceDeps();
    deps.retain.mockRejectedValue(new Error('DISK_FULL'));
    await expect(collectOfficialAgenda(deps)).rejects.toThrow('DISK_FULL');
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects backwards collection clocks', async () => {
    const deps = sourceDeps();
    deps.now = jest
      .fn()
      .mockReturnValueOnce(new Date('2026-11-02T00:00:00Z'))
      .mockReturnValue(new Date('2026-11-01T00:00:00Z'));
    await expect(collectOfficialAgenda(deps)).rejects.toThrow('OBSERVATION_CLOCK_REVERSED');
  });
});

describe('one durable refresh occurrence and original importer', () => {
  let archiveDir: string;
  const priorUrl = process.env.DATABASE_URL;
  beforeEach(async () => {
    archiveDir = await mkdtemp(join(tmpdir(), 'forecast-refresh-'));
    process.env.DATABASE_URL =
      'postgresql://synthetic:synthetic@127.0.0.1/synthetic?connection_limit=1';
  });
  afterEach(async () => {
    if (priorUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorUrl;
    if (
      dirname(resolve(archiveDir)) !== resolve(tmpdir()) ||
      !basename(archiveDir).startsWith('forecast-refresh-')
    )
      throw new Error('Unsafe fixture cleanup');
    await rm(archiveDir, { recursive: true });
  });
  const input = (archiveDir: string, apply = false, runId = 'daily-20261101') => ({
    help: false as const,
    archiveDir,
    runId,
    apply,
  });
  const deps = () => ({
    ...sourceDeps(),
    importSnapshot: jest.fn(async (_args: string[]): Promise<Record<string, unknown>> => ({
      mode: 'apply',
      checkId: '1',
      accepted: 1,
      rejected: 0,
      replay: false,
    })),
  });
  const load = (archiveDir: string, name: string) =>
    readFile(join(archiveDir, 'daily-20261101', name), 'utf8').then(JSON.parse);

  it('defaults to dry run and forwards retained original identity to the existing importer', async () => {
    delete process.env.DATABASE_URL;
    const d = deps();
    const out = await runRefresh(input(archiveDir), d);
    expect(out.status).toBe('dry-run');
    expect(d.importSnapshot).toHaveBeenCalledWith([
      '--input',
      join(archiveDir, 'daily-20261101/source.xml'),
      '--edition',
      '202510',
      '--sha256',
      createHash('sha256').update(xml).digest('hex'),
      '--observed-at',
      '2026-11-01T12:00:00.000Z',
    ]);
    expect(await readFile(join(archiveDir, 'daily-20261101/source.xml'), 'utf8')).toBe(xml);
    expect(await load(archiveDir, 'source.json')).toMatchObject({
      edition: '202510',
      publisherIssuedAt: null,
    });
    await expect(readFile(join(archiveDir, '.forecast-refresh-active'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('archives import intent before any database invocation and records returned receipt', async () => {
    const d = deps();
    d.importSnapshot.mockImplementation(async (args) => {
      expect(await load(archiveDir, 'import-intent.json')).toEqual({ kind: 'snapshot', args });
      expect(await readFile(join(archiveDir, '.forecast-refresh-active'), 'utf8')).toContain(
        'daily-20261101',
      );
      expect(process.env.DATABASE_URL).toContain('connection_limit=1');
      return { mode: 'apply', checkId: '9', accepted: 1, rejected: 0, replay: false };
    });
    await expect(runRefresh(input(archiveDir, true), d)).resolves.toMatchObject({
      status: 'import-returned',
    });
    expect(await load(archiveDir, 'import-result.json')).toMatchObject({ checkId: '9' });
    expect(d.importSnapshot).toHaveBeenCalledTimes(1);
  });
  it('refuses apply without an explicitly supplied database URL before fetching', async () => {
    delete process.env.DATABASE_URL;
    const d = deps();
    await expect(runRefresh(input(archiveDir, true), d)).rejects.toThrow('DATABASE_URL_REQUIRED');
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.importSnapshot).not.toHaveBeenCalled();
  });
  it('blocks overlaps and crashed runs without stealing a stale marker', async () => {
    await writeFile(join(archiveDir, '.forecast-refresh-active'), '{"createdAt":"2000-01-01"}');
    const d = deps();
    await expect(runRefresh(input(archiveDir, true), d)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.importSnapshot).not.toHaveBeenCalled();
  });
  it('refuses duplicate occurrence without fetching or overwriting its archive', async () => {
    const d = deps();
    await runRefresh(input(archiveDir), d);
    d.fetch.mockClear();
    d.importSnapshot.mockClear();
    await expect(runRefresh(input(archiveDir), d)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.importSnapshot).not.toHaveBeenCalled();
    expect(await load(archiveDir, 'outcome.json')).toMatchObject({ status: 'dry-run' });
  });
  it('a definite source failure records only failure and exits unsuccessful', async () => {
    const d = deps();
    d.fetch.mockRejectedValue(new Error('source offline'));
    d.importSnapshot.mockResolvedValue({ mode: 'record-failure', recorded: true });
    await expect(runRefresh(input(archiveDir, true), d)).rejects.toThrow('OFFICIAL_FETCH_FAILED');
    expect(d.importSnapshot).toHaveBeenCalledWith([
      '--record-failure',
      '--observed-at',
      '2026-11-01T12:00:00.000Z',
      '--apply',
    ]);
    expect(await load(archiveDir, 'outcome.json')).toMatchObject({
      status: 'source-failure-recorded',
    });
    await expect(readFile(join(archiveDir, '.forecast-refresh-active'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('a failed dry collection never invokes the importer or writes check evidence', async () => {
    const d = deps();
    d.fetch.mockRejectedValue(new Error('offline'));
    await expect(runRefresh(input(archiveDir), d)).rejects.toThrow('OFFICIAL_FETCH_FAILED');
    expect(d.importSnapshot).not.toHaveBeenCalled();
  });
  it.each(['snapshot', 'failure-record'])(
    'preserves uncertainty after %s import errors and blocks future days',
    async (kind) => {
      const d = deps();
      if (kind === 'failure-record') d.fetch.mockRejectedValue(new Error('offline'));
      d.importSnapshot.mockRejectedValue(new Error('lost result after possible commit'));
      await expect(runRefresh(input(archiveDir, true), d)).rejects.toThrow(
        'FORECAST_DATABASE_OUTCOME_UNKNOWN',
      );
      expect(d.importSnapshot).toHaveBeenCalledTimes(1);
      expect(await load(archiveDir, 'unknown-outcome.json')).toMatchObject({ status: 'unknown' });
      d.fetch.mockClear();
      await expect(runRefresh(input(archiveDir, true, 'daily-20261102'), d)).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(d.fetch).not.toHaveBeenCalled();
      expect(d.importSnapshot).toHaveBeenCalledTimes(1);
    },
  );
  it('receipt persistence failure after import also retains the uncertainty marker', async () => {
    const d = deps();
    d.importSnapshot.mockImplementation(async () => {
      await writeFile(join(archiveDir, 'daily-20261101/import-result.json'), 'existing');
      return { mode: 'apply', checkId: '1' };
    });
    await expect(runRefresh(input(archiveDir, true), d)).rejects.toThrow(
      'FORECAST_DATABASE_OUTCOME_UNKNOWN',
    );
    await expect(readFile(join(archiveDir, '.forecast-refresh-active'), 'utf8')).resolves.toContain(
      'daily-20261101',
    );
  });
  it.each(
    [
      [],
      ['--apply'],
      ['--archive-dir', 'relative', '--run-id', 'day'],
      ['--archive-dir', '/archive', '--run-id', '../escape'],
      ['--archive-dir', '/archive', '--run-id', 'day', '--apply', '--apply'],
    ].map((args) => ({ args })),
  )('refuses incomplete or unsafe argument set %#', ({ args }) => {
    expect(() => parseRefreshArgs(args)).toThrow('INVALID_REFRESH_ARGUMENTS');
  });
  it('validates importer receipts instead of accepting zero-exit empty/malformed output', () => {
    expect(
      validateImportReceipt(
        '{"mode":"apply","checkId":"4","accepted":1,"rejected":0,"replay":false}',
        ['--apply'],
      ),
    ).toMatchObject({ checkId: '4' });
    for (const body of [
      '',
      '{}',
      'null',
      '{"mode":"dry-run","candidates":1,"rejected":0}',
      '{"mode":"apply","checkId":"4","accepted":-1,"rejected":0,"replay":false}',
    ])
      expect(() => validateImportReceipt(body, ['--apply'])).toThrow();
    expect(
      validateImportReceipt('{"mode":"record-failure","recorded":true}', [
        '--record-failure',
        '--apply',
      ]),
    ).toEqual({ mode: 'record-failure', recorded: true });
  });
});
