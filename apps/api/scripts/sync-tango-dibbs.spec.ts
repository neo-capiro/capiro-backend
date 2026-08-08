import { describe, expect, jest, test } from '@jest/globals';
import {
  DIBBS_ENDPOINTS,
  parseArgs,
  runDibbsSync,
  type DibbsEndpoint,
  type DibbsEndpointSummary,
  type DibbsSyncDeps,
  type DibbsSyncSummary,
} from './sync-tango-dibbs.js';
import {
  TangoDibbsClient,
  TangoDibbsEnvelopeError,
  TangoDibbsHttpError,
} from '../src/external/tango/tango-dibbs.client.js';

// ── CLI ──────────────────────────────────────────────────────────────────────

describe('CLI parsing', () => {
  test('dry run is the default, all three endpoints, no limit, 7-day overlap', () => {
    expect(parseArgs([])).toEqual({
      commit: false,
      full: false,
      since: null,
      limit: undefined,
      overlapDays: 7,
      endpoints: ['rfq', 'rfp', 'award'],
    });
  });

  test('--commit, --full, --limit, --overlap-days', () => {
    expect(parseArgs(['--commit']).commit).toBe(true);
    expect(parseArgs(['--full']).full).toBe(true);
    expect(parseArgs(['--limit=500']).limit).toBe(500);
    expect(parseArgs(['--limit=999999']).limit).toBe(50_000);
    expect(parseArgs(['--limit=0']).limit).toBeUndefined();
    expect(parseArgs(['--overlap-days=30']).overlapDays).toBe(30);
    expect(parseArgs(['--overlap-days=0']).overlapDays).toBe(0);
  });

  test('--since accepts only an unambiguous calendar day', () => {
    expect(parseArgs(['--since=2026-08-01']).since).toBe('2026-08-01');
    // A half-parsed date would silently narrow the window, which is the one
    // failure the run cannot detect afterwards. Rejected, not coerced.
    expect(parseArgs(['--since=08/01/2026']).since).toBeNull();
    expect(parseArgs(['--since=2026-8-1']).since).toBeNull();
    expect(parseArgs(['--since=yesterday']).since).toBeNull();
  });

  test('--endpoint selects a subset, and an unrecognised name does NOT fall back to all three', () => {
    expect(parseArgs(['--endpoint=rfq']).endpoints).toEqual(['rfq']);
    expect(parseArgs(['--endpoint=rfq,award']).endpoints).toEqual(['rfq', 'award']);
    expect(parseArgs(['--endpoint=rfq,rfq']).endpoints).toEqual(['rfq']);
    // `rfqs` is a real typo — the endpoint PATH is plural, the document type is
    // not. It must not quietly become a full three-endpoint catalog sync.
    expect(parseArgs(['--endpoint=rfqs']).endpoints).toEqual([]);
    expect(parseArgs(['--endpoint=nonsense']).endpoints).toEqual([]);
  });
});

// ── Fakes ────────────────────────────────────────────────────────────────────

function rfq(uuid: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid,
    solicitation: `SPE7M1-${uuid}`,
    nsn: '5310-00-123-4567',
    part_number: 'PN-1',
    nomenclature: 'WASHER, FLAT',
    quantity: '500',
    unit_of_issue: 'EA',
    set_aside: 'SBA',
    status_code: 'A',
    issue_date: '2026-08-01',
    return_by_date: '2026-08-30',
    is_open: true,
    document_url: 'https://example.invalid/rfq',
    ...overrides,
  };
}

function rfp(uuid: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid,
    solicitation: `SPE7M2-${uuid}`,
    nsn: '5310-00-765-4321',
    part_number: 'PN-2',
    nomenclature: 'BOLT, MACHINE',
    buyer_code: 'BC1',
    issued_date: '2026-08-02',
    closes_date: '2026-09-15',
    is_open: true,
    document_url: 'https://example.invalid/rfp',
    tech_docs_url: 'https://example.invalid/tech',
    ...overrides,
  };
}

function award(uuid: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid,
    award_number: `SPE7M3-${uuid}`,
    delivery_order_number: 'DO-1',
    delivery_order_counter: 1,
    nsn: '5310-00-111-2222',
    part_number: 'PN-3',
    nomenclature: 'NUT, PLAIN',
    total_contract_price: '12345.67',
    awardee_cage: '1ABC1',
    awardee: { uei: 'ABCDEFGHIJK1', cage_code: '1ABC1', legal_business_name: 'Acme' },
    award_date: '2026-07-01',
    posted_date: '2026-07-02',
    ...overrides,
  };
}

type Pages = Array<Array<Record<string, unknown>>>;

interface GatewayCall {
  endpoint: DibbsEndpoint;
  options: Record<string, unknown>;
}

function fakeGateway(pagesByEndpoint: Partial<Record<DibbsEndpoint, Pages>>) {
  const calls: GatewayCall[] = [];
  const pageFor = (endpoint: DibbsEndpoint, options: any) => {
    calls.push({ endpoint, options: { ...options } });
    const pages = pagesByEndpoint[endpoint] ?? [];
    const index = (options?.page ?? 1) - 1;
    const items = pages[index] ?? [];
    const hasMore = index + 1 < pages.length;
    return Promise.resolve({
      items,
      totalCount: null,
      nextPage: hasMore ? index + 2 : null,
      rate: null,
    });
  };
  return {
    calls,
    gateway: {
      configured: true,
      listRfqs: jest.fn((options: any = {}) => pageFor('rfq', options)),
      listRfps: jest.fn((options: any = {}) => pageFor('rfp', options)),
      listAwards: jest.fn((options: any = {}) => pageFor('award', options)),
    } as any,
  };
}

/** An upsert store keyed the way the real unique index is: the provider's uuid. */
function fakeDeps(
  pagesByEndpoint: Partial<Record<DibbsEndpoint, Pages>>,
  highWater: Partial<Record<DibbsEndpoint, Date | null>> = {},
) {
  const { gateway, calls } = fakeGateway(pagesByEndpoint);
  const solicitations = new Map<string, unknown>();
  const awards = new Map<string, unknown>();
  const deps: DibbsSyncDeps = {
    gateway,
    upsertSolicitation: jest.fn(async (row: any) => {
      solicitations.set(row.tangoDibbsId, row);
    }) as any,
    upsertAward: jest.fn(async (row: any) => {
      awards.set(row.tangoDibbsId, row);
    }) as any,
    highWaterMark: jest.fn(async (endpoint: DibbsEndpoint) => highWater[endpoint] ?? null) as any,
    now: () => new Date('2026-08-08T00:00:00.000Z'),
  };
  return { deps, calls, solicitations, awards };
}

const byEndpoint = (summary: DibbsSyncSummary, e: DibbsEndpoint): DibbsEndpointSummary =>
  summary.endpoints.find((s) => s.endpoint === e)!;

// ── Posture ──────────────────────────────────────────────────────────────────

describe('write posture', () => {
  test('a dry run writes nothing but still reports what it would have written', async () => {
    const { deps, solicitations, awards } = fakeDeps({
      rfq: [[rfq('a'), rfq('b')]],
      rfp: [[rfp('c')]],
      award: [[award('d')]],
    });

    const summary = await runDibbsSync(deps, { commit: false });

    expect(solicitations.size).toBe(0);
    expect(awards.size).toBe(0);
    expect(deps.upsertSolicitation).not.toHaveBeenCalled();
    expect(deps.upsertAward).not.toHaveBeenCalled();
    expect(byEndpoint(summary, 'rfq').written).toBe(2);
    expect(byEndpoint(summary, 'rfp').written).toBe(1);
    expect(byEndpoint(summary, 'award').written).toBe(1);
    expect(summary.commit).toBe(false);
  });

  test('--commit writes, and the two row types go to their own stores', async () => {
    const { deps, solicitations, awards } = fakeDeps({
      rfq: [[rfq('a')]],
      rfp: [[rfp('b')]],
      award: [[award('c')]],
    });

    await runDibbsSync(deps, { commit: true });

    // An award must never reach the pursuable table. The migration makes that
    // structural; this pins that the sync respects the split.
    expect([...solicitations.keys()].sort()).toEqual(['a', 'b']);
    expect([...awards.keys()]).toEqual(['c']);
  });
});

// ── Idempotency / replay ─────────────────────────────────────────────────────

describe('idempotency and replay', () => {
  test('re-running the same page does not duplicate — the provider uuid is the key', async () => {
    const pages = { rfq: [[rfq('a'), rfq('b')]] as Pages, award: [[award('c')]] as Pages };

    const first = fakeDeps(pages);
    await runDibbsSync(first.deps, { commit: true, full: true });
    expect(first.solicitations.size).toBe(2);
    expect(first.awards.size).toBe(1);

    // Same fakes, second run over identical pages.
    await runDibbsSync(first.deps, { commit: true, full: true });
    expect(first.solicitations.size).toBe(2);
    expect(first.awards.size).toBe(1);
  });

  test('the same uuid arriving twice within one walk collapses to one row', async () => {
    const { deps, solicitations } = fakeDeps({
      // A shifting catalog can genuinely repeat a row across page boundaries.
      rfq: [[rfq('a')], [rfq('a', { nomenclature: 'WASHER, FLAT (REV B)' })]],
    });

    const summary = await runDibbsSync(deps, { commit: true, full: true, endpoints: ['rfq'] });

    expect(solicitations.size).toBe(1);
    // Both were processed and both were written — "written" counts upserts
    // attempted, not distinct rows. The dedupe is the store's job, and the
    // count must not pretend otherwise.
    expect(byEndpoint(summary, 'rfq').processed).toBe(2);
    expect((solicitations.get('a') as any).nomenclature).toBe('WASHER, FLAT (REV B)');
  });
});

// ── Per-endpoint counting ────────────────────────────────────────────────────

describe('counts are per endpoint, never pooled', () => {
  test('drop reasons are attributed to the endpoint and the missing field', async () => {
    const { deps } = fakeDeps({
      // rfq: one with no uuid, one with no solicitation.
      rfq: [[rfq('a'), rfq('b', { uuid: null }), rfq('c', { solicitation: null })]],
      // rfp: one with no uuid.
      rfp: [[rfp('d'), rfp('e', { uuid: undefined })]],
      // award: one with no award_number.
      award: [[award('f'), award('g', { award_number: null })]],
    });

    const summary = await runDibbsSync(deps, { commit: true, full: true });

    const q = byEndpoint(summary, 'rfq');
    expect(q.processed).toBe(3);
    expect(q.written).toBe(1);
    expect(q.droppedNoUuid).toBe(1);
    expect(q.droppedNoRequiredField).toBe(1);

    const p = byEndpoint(summary, 'rfp');
    expect(p.written).toBe(1);
    expect(p.droppedNoUuid).toBe(1);
    expect(p.droppedNoRequiredField).toBe(0);

    const a = byEndpoint(summary, 'award');
    expect(a.written).toBe(1);
    expect(a.droppedNoUuid).toBe(0);
    expect(a.droppedNoRequiredField).toBe(1);

    // The point of the split: a pooled "3 dropped" could not tell you that the
    // award endpoint's own required field was the one that went missing.
    expect(summary.endpoints.map((s) => s.endpoint)).toEqual([...DIBBS_ENDPOINTS]);
  });
});

// ── The quantity signal ──────────────────────────────────────────────────────

describe('quantityDroppedMissingUnit', () => {
  test('a quantity with no unit is counted, and the solicitation is still kept', async () => {
    const { deps, solicitations } = fakeDeps({
      rfq: [[rfq('a', { quantity: '500', unit_of_issue: null }), rfq('b')]],
    });

    const summary = await runDibbsSync(deps, { commit: true, full: true, endpoints: ['rfq'] });

    expect(summary.quantityDroppedMissingUnit).toBe(1);
    // Kept, not dropped — losing a biddable item over a secondary field would
    // be the worse trade.
    expect(solicitations.size).toBe(2);
    expect((solicitations.get('a') as any).quantity).toBeNull();
    expect((solicitations.get('a') as any).unitOfIssue).toBeNull();
  });

  test('a unit with no quantity is NOT a drop', async () => {
    const { deps } = fakeDeps({ rfq: [[rfq('a', { quantity: null, unit_of_issue: 'EA' })]] });
    const summary = await runDibbsSync(deps, { commit: true, full: true, endpoints: ['rfq'] });
    expect(summary.quantityDroppedMissingUnit).toBe(0);
  });

  test('an RFP cannot contribute to the count — it states no quantity at all', async () => {
    const { deps } = fakeDeps({
      rfp: [[rfp('a', { quantity: '500', unit_of_issue: null })]],
    });
    const summary = await runDibbsSync(deps, { commit: true, full: true, endpoints: ['rfp'] });
    expect(summary.quantityDroppedMissingUnit).toBe(0);
  });
});

// ── The window ───────────────────────────────────────────────────────────────

describe('the incremental window', () => {
  test('each endpoint sends its OWN documented date-filter spelling', async () => {
    const { deps, calls } = fakeDeps({ rfq: [[]], rfp: [[]], award: [[]] }, {
      rfq: new Date('2026-08-01T00:00:00.000Z'),
      rfp: new Date('2026-08-01T00:00:00.000Z'),
      award: new Date('2026-08-01T00:00:00.000Z'),
    });

    await runDibbsSync(deps, { commit: false, overlapDays: 0 });

    // RFQ says issue_date, RFP says issued_date, awards say posted_date. A
    // shared `dateAfter` that guessed would be the same failure the two
    // separate mappers exist to prevent.
    expect(calls.find((c) => c.endpoint === 'rfq')!.options).toMatchObject({
      issueDateAfter: '2026-08-01',
    });
    expect(calls.find((c) => c.endpoint === 'rfp')!.options).toMatchObject({
      issuedDateAfter: '2026-08-01',
    });
    expect(calls.find((c) => c.endpoint === 'award')!.options).toMatchObject({
      postedDateAfter: '2026-08-01',
    });

    // And none of them carries another endpoint's spelling.
    expect(calls.find((c) => c.endpoint === 'rfq')!.options).not.toHaveProperty('issuedDateAfter');
    expect(calls.find((c) => c.endpoint === 'rfp')!.options).not.toHaveProperty('issueDateAfter');
  });

  test('the window is the high-water mark minus the overlap', async () => {
    const { deps, calls } = fakeDeps({ rfq: [[]] }, { rfq: new Date('2026-08-08T00:00:00.000Z') });

    const summary = await runDibbsSync(deps, {
      commit: false,
      endpoints: ['rfq'],
      overlapDays: 7,
    });

    expect(calls[0]!.options).toMatchObject({ issueDateAfter: '2026-08-01' });
    expect(byEndpoint(summary, 'rfq').windowFrom).toBe('2026-08-01');
    expect(summary.windowKind).toBe('derived-high-water');
  });

  test('a first run — no stored rows — has no window at all', async () => {
    const { deps, calls } = fakeDeps({ rfq: [[]] }, { rfq: null });

    const summary = await runDibbsSync(deps, { commit: false, endpoints: ['rfq'] });

    expect(calls[0]!.options).not.toHaveProperty('issueDateAfter');
    expect(byEndpoint(summary, 'rfq').windowFrom).toBeNull();
  });

  test('--full drops the window even when a high-water mark exists', async () => {
    const { deps, calls } = fakeDeps({ rfq: [[]] }, { rfq: new Date('2026-08-08T00:00:00.000Z') });

    const summary = await runDibbsSync(deps, { commit: false, full: true, endpoints: ['rfq'] });

    expect(calls[0]!.options).not.toHaveProperty('issueDateAfter');
    expect(summary.windowKind).toBe('full');
    expect(deps.highWaterMark).not.toHaveBeenCalled();
  });

  test('--since overrides the derived mark', async () => {
    const { deps, calls } = fakeDeps({ rfq: [[]] }, { rfq: new Date('2026-08-08T00:00:00.000Z') });

    const summary = await runDibbsSync(deps, {
      commit: false,
      since: '2026-01-01',
      endpoints: ['rfq'],
    });

    expect(calls[0]!.options).toMatchObject({ issueDateAfter: '2026-01-01' });
    expect(summary.windowKind).toBe('explicit-since');
  });
});

// ── Page completeness ────────────────────────────────────────────────────────

describe('page-complete walking', () => {
  test('walks every page until the provider stops offering one', async () => {
    const { deps, solicitations } = fakeDeps({
      rfq: [[rfq('a'), rfq('b')], [rfq('c')], [rfq('d')]],
    });

    const summary = await runDibbsSync(deps, { commit: true, full: true, endpoints: ['rfq'] });

    expect(solicitations.size).toBe(4);
    expect(byEndpoint(summary, 'rfq').pagesRead).toBe(3);
    expect(byEndpoint(summary, 'rfq').complete).toBe(true);
    expect(summary.completeness).toBe('complete');
  });

  test('--limit stops early and the run is reported in_progress, not complete', async () => {
    const { deps } = fakeDeps({ rfq: [[rfq('a'), rfq('b')], [rfq('c')]] });

    const summary = await runDibbsSync(deps, {
      commit: true,
      full: true,
      endpoints: ['rfq'],
      limit: 2,
      batchSize: 2,
    });

    expect(byEndpoint(summary, 'rfq').processed).toBe(2);
    expect(byEndpoint(summary, 'rfq').complete).toBe(false);
    // A capped run that claimed completeness would license a later
    // "everything since the window is synced" inference that is simply false.
    expect(summary.completeness).toBe('in_progress');
  });

  test('one endpoint stopping early does not make the others look incomplete', async () => {
    const { deps } = fakeDeps({ rfq: [[rfq('a')]], award: [[award('b')]] });

    const summary = await runDibbsSync(deps, { commit: true, full: true, endpoints: ['rfq', 'award'] });

    expect(byEndpoint(summary, 'rfq').complete).toBe(true);
    expect(byEndpoint(summary, 'award').complete).toBe(true);
  });

  test('an endpoint the caller did not ask for is never called', async () => {
    const { deps } = fakeDeps({ rfq: [[rfq('a')]], rfp: [[rfp('b')]], award: [[award('c')]] });

    const summary = await runDibbsSync(deps, { commit: true, full: true, endpoints: ['rfq'] });

    expect(deps.gateway.listRfps).not.toHaveBeenCalled();
    expect(deps.gateway.listAwards).not.toHaveBeenCalled();
    expect(summary.endpoints).toHaveLength(1);
  });
});

// ── The client's envelope assertion ──────────────────────────────────────────

describe('TangoDibbsClient envelope handling', () => {
  const okResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  test('a documented envelope parses, and `next` reduces to a page number', async () => {
    const client = new TangoDibbsClient({
      apiKey: 'k',
      fetchImpl: (async () =>
        okResponse({
          count: 2,
          next: 'https://tango.makegov.com/api/dibbs/rfqs/?page=3&limit=100',
          results: [{ uuid: 'a' }],
        })) as any,
    });

    const page = await client.listRfqs();
    expect(page.items).toEqual([{ uuid: 'a' }]);
    expect(page.totalCount).toBe(2);
    expect(page.nextPage).toBe(3);
  });

  test('a missing `results` array THROWS rather than reporting an empty page', async () => {
    // THE assertion of this file. An empty page is indistinguishable from a
    // clean end-of-walk, so a wrong envelope would end every run with
    // "0 records, complete" — the quietest possible way to be wrong.
    const client = new TangoDibbsClient({
      apiKey: 'k',
      fetchImpl: (async () => okResponse({ count: 2, data: [{ uuid: 'a' }] })) as any,
    });

    await expect(client.listRfqs()).rejects.toBeInstanceOf(TangoDibbsEnvelopeError);
  });

  test('a JSON array at the top level is also refused', async () => {
    const client = new TangoDibbsClient({
      apiKey: 'k',
      fetchImpl: (async () => okResponse([{ uuid: 'a' }])) as any,
    });

    await expect(client.listRfqs()).rejects.toBeInstanceOf(TangoDibbsEnvelopeError);
  });

  test('each endpoint sends its own path and its own documented filter name', async () => {
    const seen: string[] = [];
    const client = new TangoDibbsClient({
      apiKey: 'k',
      fetchImpl: (async (url: any) => {
        seen.push(String(url));
        return okResponse({ count: 0, next: null, results: [] });
      }) as any,
    });

    await client.listRfqs({ issueDateAfter: '2026-08-01' });
    await client.listRfps({ issuedDateAfter: '2026-08-02' });
    await client.listAwards({ postedDateAfter: '2026-08-03' });

    expect(seen[0]).toContain('/api/dibbs/rfqs/');
    expect(seen[0]).toContain('issue_date_after=2026-08-01');
    expect(seen[1]).toContain('/api/dibbs/rfps/');
    expect(seen[1]).toContain('issued_date_after=2026-08-02');
    expect(seen[2]).toContain('/api/dibbs/awards/');
    expect(seen[2]).toContain('posted_date_after=2026-08-03');
  });

  test('limit is clamped to the documented maximum of 100', async () => {
    const seen: string[] = [];
    const client = new TangoDibbsClient({
      apiKey: 'k',
      fetchImpl: (async (url: any) => {
        seen.push(String(url));
        return okResponse({ count: 0, next: null, results: [] });
      }) as any,
    });

    await client.listRfqs({ limit: 5000 });
    expect(seen[0]).toContain('limit=100');
  });

  test('the api key never reaches an error message, even if the provider echoes it', async () => {
    const client = new TangoDibbsClient({
      apiKey: 'super-secret-key',
      fetchImpl: (async () =>
        new Response('bad request for key=super-secret-key', { status: 400 })) as any,
    });

    await expect(client.listRfqs()).rejects.toThrow(TangoDibbsHttpError);
    await client.listRfqs().catch((error: unknown) => {
      expect(String((error as Error).message)).not.toContain('super-secret-key');
      expect(String((error as Error).message)).toContain('[REDACTED]');
    });
  });
});
