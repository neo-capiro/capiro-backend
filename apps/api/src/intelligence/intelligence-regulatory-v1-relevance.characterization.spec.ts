import {
  clientId,
  clientRow,
  harness,
  installHooks,
  now,
  regulationRow,
  since,
  tenantId,
  until,
} from '../../test/fixtures/intelligence-alerts.js';

installHooks();

it('regulatory client relevance refuses missing clients before the global document scan', async () => {
  const h = harness({ rows: { client: null } });
  expect(await h.subject.getClientRelevantRegulations(clientId, tenantId, now)).toEqual([]);
  expect(h.calls.map((call) => call.operation)).toEqual(['withTenant', 'client']);
});

it('regulatory client relevance pins open-or-recent predicates and raw projection references', async () => {
  const agencies = ['DOD'];
  const doc = regulationRow({
    agencyNames: agencies,
    topics: null,
    commentEndDate: null,
    type: 'RULE',
    effectiveDate: since,
    htmlUrl: 'https://example.invalid/rule',
  });
  const h = harness({
    rows: { client: clientRow({ sectorTag: 'dod', capabilities: [] }), documents: [doc] },
  });
  expect(await h.subject.getClientRelevantRegulations(clientId, tenantId, now)).toEqual([
    {
      documentNumber: '2026-100',
      type: 'RULE',
      title: 'Rule title',
      agencyNames: agencies,
      publicationDate: now,
      commentEndDate: null,
      effectiveDate: since,
      htmlUrl: 'https://example.invalid/rule',
    },
  ]);
  expect(h.callsOf('client')[0]).toMatchObject({
    scope: 'tenant',
    tenantId,
    transaction: 1,
    args: [
      {
        where: { id: clientId },
        select: {
          id: true,
          sectorTag: true,
          capabilities: { select: { sector: true, tags: true, name: true } },
        },
      },
    ],
  });
  expect(h.callsOf('documents')[0]).toMatchObject({
    scope: 'global',
    args: [
      {
        where: {
          type: { in: ['PROPOSED_RULE', 'RULE'] },
          OR: [
            { commentEndDate: { gte: now } },
            { publicationDate: { gte: new Date('2026-07-15T12:00:00.000Z') } },
          ],
        },
        orderBy: { publicationDate: 'desc' },
        take: 200,
      },
    ],
  });
  expect(h.callsOf('documents')[0]!.tenantId).toBeUndefined();
});

it('regulatory client relevance preserves archived-client behavior and reverse topic-substring matching', async () => {
  const doc = regulationRow({ agencyNames: null, topics: ['erson'] });
  const h = harness({ rows: { client: clientRow({ status: 'archived' }), documents: [doc] } });
  const result = await h.subject.getClientRelevantRegulations(clientId, tenantId, now);
  expect(result[0]).toMatchObject({ documentNumber: '2026-100', agencyNames: [] });
  expect(result[0]!.publicationDate).toBe(doc.publicationDate);
});

it('regulatory client relevance keeps capability sector keywords separate from normalized agency-only matching', async () => {
  const h = harness({
    rows: {
      client: clientRow({ capabilities: [{ sector: 'DoD', tags: [], name: null }] }),
      documents: [regulationRow({ agencyNames: ['DOD'], topics: [] })],
    },
  });
  expect(await h.subject.getClientRelevantRegulations(clientId, tenantId, now)).toEqual([]);
});

it('regulatory and overdue views normalize legacy client sectors while deadline scoring retains raw sectorTag authority', async () => {
  const client = clientRow({ sectorTag: 'DoD', capabilities: [] });
  const future = regulationRow({ agencyNames: ['DOD'], topics: [], commentEndDate: until });
  const closed = regulationRow({ agencyNames: ['DOD'], topics: [], commentEndDate: since });
  const h = harness({
    rows: { client, clients: [client] },
    queues: { documents: [[future], [closed], [future]] },
  });
  expect(
    (await h.subject.getClientRelevantRegulations(clientId, tenantId, now))[0]!.documentNumber,
  ).toBe('2026-100');
  expect((await h.service.getOverdueCommentAlerts(clientId, tenantId, now, since))[0]!.id).toBe(
    'comment_overdue:doc-one',
  );
  expect(await h.service.getCommentPeriodAlerts(tenantId)).toEqual({ alerts: [] });
  expect(h.callsOf('changeUpsert')).toEqual([]);
});

it('regulatory client relevance caps the first twenty matched rows before inspecting later malformed rows', async () => {
  const docs = [
    regulationRow({ documentNumber: 'ignored', topics: [] }),
    ...Array.from({ length: 20 }, (_, index) => regulationRow({ documentNumber: `doc-${index}` })),
    regulationRow({ documentNumber: 'malformed-later', topics: [null] }),
  ];
  const h = harness({ rows: { documents: docs } });
  const result = await h.subject.getClientRelevantRegulations(clientId, tenantId, now);
  expect(result).toHaveLength(20);
  expect(result[0]!.documentNumber).toBe('doc-0');
  expect(result[19]!.documentNumber).toBe('doc-19');
  expect(h.warnings).toEqual([]);
});

it.each(['client', 'documents'])(
  'regulatory client relevance warns and rethrows %s read errors',
  async (operation) => {
    const failure = new Error(`failed:${operation}`);
    const h = harness({ errors: { [operation]: failure } });
    await expect(h.subject.getClientRelevantRegulations(clientId, tenantId, now)).rejects.toBe(
      failure,
    );
    expect(h.warnings).toEqual([
      `getClientRelevantRegulations failed for ${clientId}: failed:${operation}`,
    ]);
  },
);

it('regulatory client relevance retains malformed-topic failure and non-Error warning conversion', async () => {
  const h = harness({ errors: { documents: 'plain failure' } });
  await expect(h.subject.getClientRelevantRegulations(clientId, tenantId, now)).rejects.toBe(
    'plain failure',
  );
  expect(h.warnings).toEqual([
    `getClientRelevantRegulations failed for ${clientId}: plain failure`,
  ]);
  const other = harness({ rows: { documents: [regulationRow({ topics: [null] })] } });
  await expect(other.subject.getClientRelevantRegulations(clientId, tenantId, now)).rejects.toThrow(
    TypeError,
  );
  expect(other.warnings[0]).toContain(`getClientRelevantRegulations failed for ${clientId}:`);
});
