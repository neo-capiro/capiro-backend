import {
  harness,
  clientId,
  tenantId,
  now,
  billRow,
  capabilityRow,
  installHooks,
  type TrackedBill,
} from '../../test/fixtures/intelligence-bills.js';

installHooks();
const matched = (identifier: string, extra: Record<string, unknown> = {}): TrackedBill => ({
  identifier,
  title: `Bill ${identifier}`,
  latestActionDate: now,
  latestActionText: 'Introduced',
  sponsorName: null,
  sponsorParty: null,
  subjectNames: [],
  ...extra,
});
const signal = capabilityRow({
  sector: null,
  name: 'Signal Research',
  tags: [],
  description: null,
  justification: null,
  districtNexus: null,
});
const sql = (args: unknown[]) =>
  (args[0] as TemplateStringsArray).join('$1').replace(/\s+/g, ' ').trim();

describe('Tracked bills optional tenant and no-term manual path', () => {
  it.each([undefined, ''])(
    'returns the original empty aggregate without any scoped/global read for tenant %p',
    async (tenant) => {
      const h = harness({ rows: { trackedBills: [{ billId: 'manual' }], capabilities: [signal] } });
      const embedding = h.override('findTrackedBillsByEmbeddings', {
        total: 1,
        bills: [matched('auto')],
      });
      expect(await h.service.getTrackedBills(clientId, tenant)).toEqual({
        total: 0,
        issueCodes: [],
        bills: [],
      });
      expect(h.calls).toEqual([]);
      expect(embedding).not.toHaveBeenCalled();
    },
  );
  it('includes hydrated manual picks with no relevance terms and skips both matchers', async () => {
    const h = harness({
      rows: { trackedBills: [{ billId: 'manual' }], billRows: [billRow({ id: 'manual' })] },
    });
    const embedding = h.override('findTrackedBillsByEmbeddings', null);
    const keyword = h.override('findTrackedBillsByKeyword', { total: 0, bills: [] });
    const out = await h.service.getTrackedBills(clientId, tenantId);
    expect(out).toMatchObject({
      total: 1,
      issueCodes: [],
      bills: [{ identifier: 'manual', isManual: true }],
    });
    expect(embedding).not.toHaveBeenCalled();
    expect(keyword).not.toHaveBeenCalled();
    expect(h.callsOf('trackedBills')[0]!.args).toEqual([
      { where: { clientId }, select: { billId: true } },
    ]);
  });
  it('does not perform global hydration for an empty manual ID set', async () => {
    const h = harness();
    expect(await h.service.getTrackedBills(clientId, tenantId)).toEqual({
      total: 0,
      issueCodes: [],
      bills: [],
    });
    expect(h.callsOf('billRows')).toEqual([]);
  });
});

describe('Tracked bill matcher authority and relevance seam', () => {
  it.each([
    { capabilities: [], floor: 0.75 },
    {
      capabilities: [
        capabilityRow({
          sector: null,
          name: null,
          tags: null,
          description: null,
          justification: null,
          districtNexus: null,
        }),
      ],
      floor: 0.65,
    },
  ])(
    'passes the original capability-presence floor even for empty capability terms: %p',
    async ({ capabilities, floor }) => {
      const h = harness({
        rows: {
          mappings: [{ externalId: '11' }],
          issueCodes: [{ code: 'DEF' }],
          issueNames: [{ name: 'Defense' }],
          capabilities,
        },
      });
      const embedding = h.override('findTrackedBillsByEmbeddings', {
        total: 99,
        bills: [matched('auto')],
      });
      const keyword = h.override('findTrackedBillsByKeyword', {
        total: 1,
        bills: [matched('keyword')],
      });
      expect(await h.service.getTrackedBills(clientId, tenantId)).toMatchObject({
        total: 1,
        issueCodes: ['DEF'],
        bills: [{ identifier: 'auto', isManual: false }],
      });
      expect(embedding).toHaveBeenCalledWith(['Defense'], floor);
      expect(keyword).not.toHaveBeenCalled();
    },
  );
  it('treats a truthy zero-row embedding result as authoritative instead of falling back', async () => {
    const h = harness({ rows: { capabilities: [signal] } });
    h.override('findTrackedBillsByEmbeddings', { total: 0, bills: [] });
    const keyword = h.override('findTrackedBillsByKeyword', {
      total: 1,
      bills: [matched('keyword')],
    });
    expect(await h.service.getTrackedBills(clientId, tenantId)).toEqual({
      total: 0,
      issueCodes: [],
      bills: [],
    });
    expect(keyword).not.toHaveBeenCalled();
  });
  it('passes rich semantic text to embeddings then precise keyword tokens only when embeddings return null', async () => {
    const h = harness({ rows: { capabilities: [signal] } });
    const embedding = h.override('findTrackedBillsByEmbeddings', null);
    const keyword = h.override('findTrackedBillsByKeyword', {
      total: 50,
      bills: [matched('keyword')],
    });
    expect(await h.service.getTrackedBills(clientId, tenantId)).toMatchObject({
      total: 1,
      bills: [{ identifier: 'keyword' }],
    });
    expect(embedding).toHaveBeenCalledWith(['Signal Research'], 0.65);
    expect(keyword).toHaveBeenCalledWith(['Signal', 'Research']);
  });
});

describe('Tracked bill relevance retains late-bound facade ownership', () => {
  it('honors a post-construction facade override while executing the original relevance reader', async () => {
    const h = harness({ rows: { capabilities: [signal] } });
    const original = h.service.getClientRelevanceTerms.bind(h.service);
    jest.spyOn(h.service, 'getClientRelevanceTerms').mockImplementation(async (...args) => {
      const terms = await original(...args);
      return {
        ...terms,
        embeddingPartsClean: [...terms.embeddingPartsClean, 'Late semantic'],
        keywordTermsExpanded: [...terms.keywordTermsExpanded, 'Late keyword'],
      };
    });
    const embedding = h.override('findTrackedBillsByEmbeddings', null);
    const keyword = h.override('findTrackedBillsByKeyword', { total: 0, bills: [] });
    await h.service.getTrackedBills(clientId, tenantId);
    expect(h.callsOf('capabilities')).toHaveLength(1);
    expect(embedding).toHaveBeenCalledWith(['Signal Research', 'Late semantic'], 0.65);
    expect(keyword).toHaveBeenCalledWith(['Signal', 'Research', 'Late keyword']);
  });
});

describe('Tracked bill merge preserves manual identity and input data', () => {
  it('hydrates only absent manual IDs, prefixes those rows, marks overlaps once and counts returned rows rather than matcher totals', async () => {
    const auto = [matched('auto', { isManual: true }), matched('shared')];
    const h = harness({
      rows: {
        capabilities: [signal],
        trackedBills: [{ billId: 'manual' }, { billId: 'shared' }, { billId: 'not-hydrated' }],
        billRows: [billRow({ id: 'manual' })],
      },
    });
    h.override('findTrackedBillsByEmbeddings', { total: 1000, bills: auto });
    const out = await h.service.getTrackedBills(clientId, tenantId);
    expect(out.total).toBe(3);
    expect(out.bills.map(({ identifier, isManual }) => ({ identifier, isManual }))).toEqual([
      { identifier: 'manual', isManual: true },
      { identifier: 'auto', isManual: false },
      { identifier: 'shared', isManual: true },
    ]);
    expect(h.callsOf('billRows')[0]!.args.slice(1)).toEqual([['manual', 'not-hydrated']]);
    expect(auto[0]!.isManual).toBe(true);
    expect(auto[1]).not.toHaveProperty('isManual');
  });
  it('does not rehydrate an already matched manual pick or reorder automatic matches', async () => {
    const h = harness({ rows: { capabilities: [signal], trackedBills: [{ billId: 'shared' }] } });
    h.override('findTrackedBillsByEmbeddings', {
      total: 2,
      bills: [matched('z'), matched('shared')],
    });
    const out = await h.service.getTrackedBills(clientId, tenantId);
    expect(out.bills.map((bill) => bill.identifier)).toEqual(['z', 'shared']);
    expect(h.callsOf('billRows')).toEqual([]);
  });
});

describe('Tracked bill failures remain caller-visible', () => {
  it('propagates relevance read failure despite available manual picks', async () => {
    const h = harness({
      rows: { trackedBills: [{ billId: 'manual' }] },
      errors: { capabilities: new Error('capability read failed') },
    });
    await expect(h.service.getTrackedBills(clientId, tenantId)).rejects.toThrow(
      'capability read failed',
    );
    expect(h.callsOf('billRows')).toEqual([]);
  });
  it('propagates a thrown embedding matcher and does not silently use keyword results', async () => {
    const h = harness({ rows: { capabilities: [signal] } });
    h.override('findTrackedBillsByEmbeddings', () => {
      throw new Error('embedding call failed');
    });
    const keyword = h.override('findTrackedBillsByKeyword', { total: 0, bills: [] });
    await expect(h.service.getTrackedBills(clientId, tenantId)).rejects.toThrow(
      'embedding call failed',
    );
    expect(keyword).not.toHaveBeenCalled();
  });
  it('propagates keyword and missing-manual hydration failures at their respective stages', async () => {
    const h = harness({ rows: { capabilities: [signal] } });
    h.override('findTrackedBillsByEmbeddings', null);
    h.override('findTrackedBillsByKeyword', () => {
      throw new Error('keyword failed');
    });
    await expect(h.service.getTrackedBills(clientId, tenantId)).rejects.toThrow('keyword failed');
    const hydrate = harness({
      rows: { trackedBills: [{ billId: 'manual' }] },
      errors: { billRows: new Error('hydration failed') },
    });
    await expect(hydrate.service.getTrackedBills(clientId, tenantId)).rejects.toThrow(
      'hydration failed',
    );
  });
});

describe('Manual ID and global bill hydration contracts', () => {
  it('returns tenant manual IDs in source order without hidden deduplication', async () => {
    const h = harness({
      rows: { trackedBills: [{ billId: 'z' }, { billId: 'a' }, { billId: 'z' }] },
    });
    expect(await h.subject.getManualTrackedBillIds(clientId, tenantId)).toEqual(['z', 'a', 'z']);
    expect(h.callsOf('trackedBills')[0]).toMatchObject({
      scope: 'tenant',
      tenantId,
      args: [{ where: { clientId }, select: { billId: true } }],
    });
  });
  it('short-circuits global bill fetching for an empty input set', async () => {
    const h = harness();
    expect(await h.subject.fetchBillsByIds([])).toEqual([]);
    expect(h.calls).toEqual([]);
  });
  it('uses exact global projection/order and preserves action/subject/date references', async () => {
    const row = billRow({
      id: 'one',
      status: 'ENACTED',
      action_texts: ['Passed House', 'Signed'],
      subjects: ['Research'],
      latest_action_date: now,
    });
    const h = harness({ rows: { billRows: [row] } });
    const out = await h.subject.fetchBillsByIds(['one', 'not-hydrated']);
    expect(out[0]).toMatchObject({
      identifier: 'one',
      status: 'ENACTED',
      actionTexts: row.action_texts,
      subjectNames: ['Research'],
      latestActionDate: now,
    });
    expect(out[0]!.actionTexts).toBe(row.action_texts);
    expect(out[0]!.subjectNames).toBe(row.subjects);
    expect(out[0]!.latestActionDate).toBe(now);
    expect(sql(h.callsOf('billRows')[0]!.args)).toBe(
      'SELECT cb.id, cb.title, cb.latest_action_date, cb.latest_action_text, cb.status, ARRAY(SELECT a.text FROM congress_bill_action a WHERE a.bill_id = cb.id) AS action_texts, cb.sponsor_name, cb.sponsor_party, cb.subjects FROM congress_bill cb WHERE cb.id = ANY($1::text[]) ORDER BY cb.latest_action_date DESC NULLS LAST',
    );
    expect(h.callsOf('billRows')[0]).toMatchObject({ scope: 'global' });
    expect(h.callsOf('billRows')[0]!.args.slice(1)).toEqual([['one', 'not-hydrated']]);
  });
  it('defaults nullable subjects only and retains absent optional status/actions as undefined fields', async () => {
    const row = billRow({
      id: 'one',
      subjects: null,
      status: undefined,
      action_texts: undefined,
      latest_action_date: null,
    });
    const h = harness({ rows: { billRows: [row] } });
    const out = await h.subject.fetchBillsByIds(['one']);
    expect(out[0]).toMatchObject({
      subjectNames: [],
      status: undefined,
      actionTexts: undefined,
      latestActionDate: null,
    });
    expect(Object.prototype.hasOwnProperty.call(out[0], 'status')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(out[0], 'actionTexts')).toBe(true);
  });
});
