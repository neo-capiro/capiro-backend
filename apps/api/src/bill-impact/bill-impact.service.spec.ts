import {
  BillImpactService,
  IMPACT_CLIENT_SQL,
  IMPACT_STATE_SQL,
  IMPACT_FEDERAL_SQL,
} from './bill-impact.service.js';
jest.mock('@capiro/shared', () => ({
  ...jest.requireActual('@capiro/shared'),
  recordAiUsageEvent: jest.fn(async () => undefined),
}));
const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
} as never;
const clientId = '00000000-0000-4000-8000-000000000003';
const input = { clientId, versionId: 'v1', revision: 'hash' };
function harness(federal = false) {
  const client = {
    id: clientId,
    name: 'Example',
    description: 'Manufactures composite aircraft structures for domestic defense programs.',
    productDescription: null,
  };
  const lifecycle = {
    title: 'Supplier qualification',
    latestAction: 'Laid on table; companion became law.',
    actionDate: '2026-04-01',
    sourceUrl: 'https://flsenate.gov/x',
  };
  const version: any = federal
    ? {
        id: 'v1',
        revision: 'hash',
        label: 'ih',
        sourceUrl: 'https://govinfo.gov/text',
        publishedDate: '2026-01-01',
        completeness: 'complete',
        text: 'Supplier qualification may be supported.\n\nThis does not appropriate funds.',
      }
    : {
        id: 'v1',
        revision: 'hash',
        label: 'Introduced',
        sourceUrl: 'https://flsenate.gov/text',
        publishedDate: '2026-01-01',
        coverage: 'complete_document',
        extractionState: 'extracted',
        sections: [
          {
            locator: 'Section 1',
            hash: 'x',
            text: 'Supplier qualification may be supported. This does not appropriate funds.',
          },
        ],
      };
  const tenantQuery = jest.fn(async (sql: string) =>
    sql.includes('intel_feature_flag') ? [{ enabled: true }] : [client],
  );
  const query = jest.fn(async (sql: string) =>
    sql.includes('legiwatch_research_document_source') || sql.includes('federal_evidence_current')
      ? [version]
      : [lifecycle],
  );
  const prisma = {
    withTenant: jest.fn(async (_: string, fn: any) => fn({ $queryRawUnsafe: tenantQuery })),
    $queryRawUnsafe: query,
  };
  const complete = jest
    .fn()
    .mockResolvedValueOnce({
      text: JSON.stringify({
        impacts: [
          {
            evidenceIds: ['E1'],
            clientIds: ['C1'],
            possibleImplication: 'The client might review whether its composite products qualify.',
            assumptions: 'Funding and eligibility remain unverified.',
            verificationStep: 'Check requirements against the product specifications.',
          },
        ],
        limitations: 'Draft analysis of selected text only.',
      }),
      raw: {},
      truncated: false,
    })
    .mockResolvedValueOnce({
      text: JSON.stringify({ verdicts: [{ index: 0, supported: true }] }),
      raw: {},
      truncated: false,
    });
  const resolveProvider = jest.fn(async () => ({
    apiKey: 'fixture',
    model: 'fixture',
    usedTenantKey: true,
  }));
  const service = new BillImpactService(
    prisma as never,
    { resolveProvider } as never,
    { complete } as never,
  );
  return { service, client, lifecycle, version, tenantQuery, query, complete, resolveProvider };
}
describe('bill impact review-only generation', () => {
  it('allows no supported client connection without fabricating a mandatory impact', async () => {
    const h = harness();
    h.complete.mockReset().mockResolvedValue({ text: '{"impacts":[]}', raw: {} });
    const result = await h.service.generate(ctx, 'fl-2026-hb1211', input);
    expect(result.impacts).toEqual([]);
    expect(result.reviewRequired).toBe(true);
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(result.limitations).toContain('require human review');
  });
  it('bounds the whole request and cancels provider work before the browser deadline', async () => {
    jest.useFakeTimers();
    try {
      const h = harness();
      let providerSignal: AbortSignal | undefined;
      h.complete.mockReset().mockImplementation((request: any) => {
        providerSignal = request.signal;
        return new Promise(() => undefined);
      });
      const pending = h.service.generate(ctx, 'fl-2026-hb1211', input);
      const rejected = expect(pending).rejects.toThrow(/timed out/);
      await jest.advanceTimersByTimeAsync(145_000);
      await rejected;
      expect(providerSignal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
  it.each([false, true])(
    'uses exact complete %s source without accepting browser-authored text',
    async (federal) => {
      const h = harness(federal);
      const id = federal ? '119-hr-10' : 'fl-2026-hb1211';
      const result = await h.service.generate(ctx, id, input);
      expect(result.reviewRequired).toBe(true);
      expect(result.version.revision).toBe('hash');
      expect(result.lifecycle.latestAction).toBe(h.lifecycle.latestAction);
      expect(h.complete).toHaveBeenCalledTimes(2);
      expect(h.query).toHaveBeenCalledWith(
        federal ? IMPACT_FEDERAL_SQL : IMPACT_STATE_SQL,
        ...[id, ...(!federal ? ['2026'] : [])],
      );
      expect(h.complete.mock.calls[0]![0].userStatic).toContain('does not appropriate funds');
    },
  );
  it('does not select a version automatically', async () => {
    const h = harness();
    await expect(
      h.service.generate(ctx, 'fl-2026-hb1211', { ...input, versionId: '' }),
    ).rejects.toThrow(/selected text/);
    expect(h.complete).not.toHaveBeenCalled();
  });
  it.each(['partial', 'metadata'])('withholds %s source before provider lookup', async (kind) => {
    const h = harness();
    if (kind === 'partial') h.version.coverage = 'partial';
    else h.version.sections = [];
    await expect(h.service.generate(ctx, 'fl-2026-hb1211', input)).rejects.toThrow(
      /complete retained/,
    );
    expect(h.resolveProvider).not.toHaveBeenCalled();
  });
  it('rejects stale revision before generation', async () => {
    const h = harness();
    await expect(
      h.service.generate(ctx, 'fl-2026-hb1211', { ...input, revision: 'old' }),
    ).rejects.toThrow(/changed/);
    expect(h.complete).not.toHaveBeenCalled();
  });
  it('requires meaningful client context before model work', async () => {
    const h = harness();
    h.client.description = 'Defense';
    await expect(h.service.generate(ctx, 'fl-2026-hb1211', input)).rejects.toThrow(/substantive/);
    expect(h.complete).not.toHaveBeenCalled();
  });
  it('passes only trusted tenant/user/client identity into the restrictive access query', async () => {
    const h = harness();
    await h.service.options(ctx, 'fl-2026-hb1211', clientId);
    expect(h.tenantQuery).toHaveBeenCalledWith(
      IMPACT_CLIENT_SQL,
      (ctx as any).tenantId,
      (ctx as any).userId,
      clientId,
    );
  });
  it('holds inaccessible clients before reading public evidence or calling model', async () => {
    const h = harness();
    h.tenantQuery.mockImplementation(async (sql) =>
      sql.includes('intel_feature_flag') ? [{ enabled: true }] : [],
    );
    await expect(h.service.options(ctx, 'fl-2026-hb1211', clientId)).rejects.toThrow(
      /Client unavailable/,
    );
    expect(h.query).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
  });
  it('honors an explicit disabled feature even for the internal tenant', async () => {
    const h = harness();
    h.tenantQuery.mockImplementation(async () => [{ enabled: false }]);
    await expect(h.service.options(ctx, 'fl-2026-hb1211', clientId)).rejects.toThrow(/unavailable/);
    expect(h.query).not.toHaveBeenCalled();
  });
  it.each(['truncated', 'refusal', 'unsupported'])(
    'withholds %s generation/review',
    async (mode) => {
      const h = harness();
      if (mode === 'unsupported')
        h.complete
          .mockReset()
          .mockResolvedValueOnce({
            text: JSON.stringify({
              impacts: [
                {
                  evidenceIds: ['E1'],
                  clientIds: ['C1'],
                  possibleImplication: 'The client will receive a $50M award.',
                  assumptions: 'None.',
                  verificationStep: 'Spend the award.',
                },
              ],
              limitations: 'None.',
            }),
            raw: {},
          })
          .mockResolvedValueOnce({ text: '{"verdicts":[{"index":0,"supported":false}]}', raw: {} });
      else
        h.complete.mockReset().mockResolvedValue({
          text: '{}',
          raw: {},
          truncated: mode === 'truncated',
          stopReason: mode,
        });
      await expect(h.service.generate(ctx, 'fl-2026-hb1211', input)).rejects.toThrow(
        /could not be verified/,
      );
    },
  );
  it('rechecks client access after generation and withholds on revocation', async () => {
    const h = harness();
    let access = 0;
    h.tenantQuery.mockImplementation(async (sql) =>
      sql.includes('intel_feature_flag') ? [{ enabled: true }] : ++access === 1 ? [h.client] : [],
    );
    await expect(h.service.generate(ctx, 'fl-2026-hb1211', input)).rejects.toThrow(
      /Client unavailable/,
    );
  });
  it('rechecks exact retained source after generation', async () => {
    const h = harness();
    let reads = 0;
    h.query.mockImplementation(async (sql) =>
      sql.includes('legiwatch_research_document_source')
        ? [{ ...h.version, revision: ++reads === 1 ? 'hash' : 'changed' }]
        : [h.lifecycle],
    );
    await expect(h.service.generate(ctx, 'fl-2026-hb1211', input)).rejects.toThrow(/changed/);
  });
  it('returns a safe conflict when the selected source is removed during generation', async () => {
    const h = harness();
    let reads = 0;
    h.query.mockImplementation(async (sql) =>
      sql.includes('legiwatch_research_document_source')
        ? ++reads === 1
          ? [h.version]
          : []
        : [h.lifecycle],
    );
    await expect(h.service.generate(ctx, 'fl-2026-hb1211', input)).rejects.toThrow(/changed/);
  });
});
