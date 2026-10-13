import {
  clientId,
  clientRow,
  deferred,
  harness,
  installHooks,
  now,
  regulationRow,
  tenantId,
  until,
} from '../../test/fixtures/intelligence-alerts.js';

installHooks();

it.each(['missing', 'archived'])(
  'regulatory profile refuses %s tenant clients before either source starts',
  async (kind) => {
    const h = harness({
      rows: { client: kind === 'missing' ? null : clientRow({ status: 'archived' }) },
    });
    await expect(h.service.getClientRegulatoryProfile(clientId, tenantId)).rejects.toMatchObject({
      status: 404,
      message: 'Client not found',
    });
    expect(h.calls.map((call) => call.operation)).toEqual(['withTenant', 'client']);
    expect(h.callsOf('client')[0]!.args).toEqual([
      {
        where: { id: clientId },
        select: { id: true, status: true },
      },
    ]);
  },
);

it('regulatory profile runs real relevance and lifecycle helpers with lazy source-budget receiver seams', async () => {
  const doc = regulationRow({ htmlUrl: 'https://example.invalid/open' });
  const h = harness({ rows: { documents: [doc] } });
  const relevant = jest.spyOn(h.subject, 'getClientRelevantRegulations');
  const lifecycle = jest.spyOn(h.subject, 'buildRegulatoryLifecycle');
  const budget = jest.spyOn(h.subject, 'withSourceBudget');
  const result = await h.service.getClientRegulatoryProfile(clientId, tenantId);
  expect(result).toMatchObject({
    clientId,
    generatedAt: now.toISOString(),
    partial: false,
    sources: [
      { name: 'Tracked-bill regulations', status: 'available' },
      { name: 'Client-relevant regulations', status: 'available' },
    ],
    regulatoryLifecycle: {
      totalLinkedBills: 0,
      totalRegulations: 1,
      rails: [
        {
          documentNumber: '2026-100',
          linkedBills: [],
          currentStage: 'nprm',
          deadline: until,
          htmlUrl: 'https://example.invalid/open',
          stages: [
            { key: 'notice', label: 'Notice' },
            { key: 'nprm', label: 'NPRM' },
            { key: 'comment_closed', label: 'Comment closed' },
            { key: 'final', label: 'Final rule' },
            { key: 'effective', label: 'Effective' },
          ],
        },
      ],
    },
  });
  expect(relevant).toHaveBeenCalledWith(clientId, tenantId, now);
  expect(h.ports.links.mock.contexts[0]).toBe(h.service);
  expect(budget.mock.contexts).toEqual([h.service, h.service]);
  expect(budget.mock.calls.map((call) => call.slice(0, 2))).toEqual([
    ['billRegulationLinks', clientId],
    ['clientRelevantRegulations', clientId],
  ]);
  expect(h.ports.links.mock.invocationCallOrder[0]!).toBeLessThan(
    budget.mock.invocationCallOrder[0]!,
  );
  expect(relevant.mock.invocationCallOrder[0]!).toBeLessThan(budget.mock.invocationCallOrder[1]!);
  expect(lifecycle.mock.contexts[0]).toBe(h.service);
  expect(lifecycle.mock.calls[0]![1]).toBe(await relevant.mock.results[0]!.value);
  expect(result.regulatoryLifecycle).toBe(lifecycle.mock.results[0]!.value);
  expect(jest.getTimerCount()).toBe(0);
});

it('regulatory profile starts both sources before waiting and preserves its entry clock', async () => {
  const links = deferred<unknown>();
  const docs = deferred<unknown>();
  const h = harness({ results: { 'port:links': links.promise, documents: docs.promise } });
  const pending = h.service.getClientRegulatoryProfile(clientId, tenantId);
  await h.started('documents');
  expect(h.ports.links).toHaveBeenCalledTimes(1);
  jest.setSystemTime(new Date('2026-10-14T12:00:00.000Z'));
  links.resolve({ links: [], totalBills: 0, totalRegulations: 0 });
  docs.resolve([]);
  expect((await pending).generatedAt).toBe(now.toISOString());
});

it.each(['port:links', 'documents'])(
  'regulatory profile keeps the surviving source and ordered coverage after %s failure',
  async (operation) => {
    const failure = new Error(`failed:${operation}`);
    const h = harness({ rows: { documents: [regulationRow()] }, errors: { [operation]: failure } });
    const result = await h.service.getClientRegulatoryProfile(clientId, tenantId);
    expect(result.partial).toBe(true);
    expect(result.sources).toEqual([
      {
        name: 'Tracked-bill regulations',
        status: operation === 'port:links' ? 'unavailable' : 'available',
      },
      {
        name: 'Client-relevant regulations',
        status: operation === 'documents' ? 'unavailable' : 'available',
      },
    ]);
    expect(result.regulatoryLifecycle.totalRegulations).toBe(operation === 'port:links' ? 1 : 0);
    const label =
      operation === 'port:links' ? 'Tracked-bill regulations' : 'Client-relevant regulations';
    expect(h.warnings.at(-1)).toBe(
      `regulatory-profile source ${label} failed for client ${clientId}: Error: failed:${operation}`,
    );
  },
);

it('regulatory profile warns in source order and fails closed when both sources reject', async () => {
  const h = harness({
    errors: { 'port:links': new Error('links unavailable'), documents: 'docs unavailable' },
  });
  await expect(h.service.getClientRegulatoryProfile(clientId, tenantId)).rejects.toMatchObject({
    status: 503,
    message: 'Regulatory sources are unavailable. Please retry.',
  });
  expect(h.warnings.slice(-2)).toEqual([
    `regulatory-profile source Tracked-bill regulations failed for client ${clientId}: Error: links unavailable`,
    `regulatory-profile source Client-relevant regulations failed for client ${clientId}: docs unavailable`,
  ]);
});

it('regulatory profile retains the real source budget and reports unavailable pending work', async () => {
  const never = deferred<unknown>();
  const h = harness({ results: { 'port:links': never.promise } });
  const pending = h.service.getClientRegulatoryProfile(clientId, tenantId);
  await h.started('documents');
  await jest.advanceTimersByTimeAsync(20_000);
  const result = await pending;
  expect(result.partial).toBe(true);
  expect(result.sources[0]!.status).toBe('unavailable');
  expect(h.warnings).toContain(
    `regulatory-profile source Tracked-bill regulations failed for client ${clientId}: Error: exceeded its 20000ms budget (still running)`,
  );
  expect(jest.getTimerCount()).toBe(0);
  never.resolve({ links: [], totalBills: 0, totalRegulations: 0 });
});
