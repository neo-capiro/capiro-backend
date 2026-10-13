import {
  clientId,
  clientRow,
  day,
  deferred,
  harness,
  installHooks,
  now,
  regulationRow,
  tenantId,
  until,
} from '../../test/fixtures/intelligence-alerts.js';

installHooks();

it('comment alerts pin eager tenant client and global federal/state deadline predicates', async () => {
  const held = deferred<unknown>();
  const h = harness({ results: { clients: held.promise } });
  const pending = h.service.getCommentPeriodAlerts(tenantId);
  await h.started('stateRules');
  expect(h.calls.map((call) => call.operation)).toEqual([
    'withTenant',
    'clients',
    'documents',
    'stateRules',
  ]);
  expect(h.callsOf('clients')[0]).toMatchObject({
    scope: 'tenant',
    tenantId,
    transaction: 1,
    args: [
      {
        where: { status: { not: 'archived' }, profileStatus: 'ACTIVE' },
        select: {
          id: true,
          name: true,
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
        where: { type: { in: ['PROPOSED_RULE', 'RULE'] }, commentEndDate: { gt: now, lte: until } },
        orderBy: { commentEndDate: 'asc' },
      },
    ],
  });
  expect(h.callsOf('stateRules')[0]).toMatchObject({
    scope: 'global',
    args: [
      {
        where: { commentEndDate: { gt: now, lte: until } },
        orderBy: { commentEndDate: 'asc' },
      },
    ],
  });
  held.resolve([clientRow()]);
  expect(await pending).toEqual({ alerts: [] });
  expect(h.callsOf('changeUpsert')).toEqual([]);
});

it('comment alerts keep federal sector lineage and state keyword lineage in distinct dedupe envelopes', async () => {
  const federal = regulationRow({
    title: 'Federal rule',
    agencyNames: ['DOD', 'EPA'],
    topics: [],
    commentEndDate: new Date(now.getTime() + 4 * day),
  });
  const state = {
    id: 'state-one',
    title: 'State rule',
    abstract: 'Hypersonic permits',
    ruleType: 'proposed',
    state: 'FL',
    agency: 'State Agency',
    commentEndDate: new Date(now.getTime() + 2 * day),
  };
  const client = clientRow({
    sectorTag: 'DEFENSE',
    capabilities: [{ sector: 'EPA', name: 'Hypersonic Systems', tags: [] }],
  });
  const h = harness({ rows: { clients: [client], documents: [federal], stateRules: [state] } });
  const result = await h.service.getCommentPeriodAlerts(tenantId);
  expect(
    result.alerts.map((alert) => [alert.documentId, alert.severity, alert.relevanceScore]),
  ).toEqual([
    ['state-one', 'critical', 1.4],
    ['doc-one', 'notable', 0.75],
  ]);
  const federalWrite = h.callsOf('changeUpsert')[0]!.args[0] as {
    create: Record<string, unknown>;
    update: unknown;
    where: unknown;
  };
  expect(federalWrite).toEqual({
    where: { dedupeKey: `comment_deadline:federal_register:doc-one:${clientId}` },
    create: {
      dedupeKey: `comment_deadline:federal_register:doc-one:${clientId}`,
      source: 'federal_register',
      changeType: 'comment_deadline_approaching',
      severity: 'notable',
      title: 'Comment period closing in 4d: Federal rule',
      description:
        'PROPOSED_RULE from DOD/EPA has a comment deadline in 4 days. Relevant to Acme Defense.',
      relatedClientIds: [clientId],
      relatedIssues: ['DEF', 'HOM', 'AER', 'INT', 'ENV', 'WAT', 'CAW', 'NAT'],
      data: { documentId: 'doc-one', daysToDeadline: 4, relevanceScore: 0.75 },
    },
    update: federalWrite.create,
  });
  const stateWrite = h.callsOf('changeUpsert')[1]!.args[0] as {
    create: Record<string, unknown>;
    update: unknown;
    where: unknown;
  };
  expect(stateWrite.create).toMatchObject({
    dedupeKey: `comment_deadline:state_register:state-one:${clientId}`,
    source: 'state_register',
    relatedIssues: [],
    description:
      'proposed from FL State Agency has a comment deadline in 2 days. Relevant to Acme Defense (relevance: 140%).',
  });
  expect(federalWrite.update).toBe(federalWrite.create);
  expect(stateWrite.update).toBe(stateWrite.create);
  expect(h.callsOf('changeUpsert').every((call) => call.scope === 'global')).toBe(true);
  expect(result.alerts[1]!.agencies).toBe(federal.agencyNames);
});

it('comment alerts derive document LDA codes for keyword-only federal matches without guessing state codes', async () => {
  const h = harness({
    rows: { clients: [clientRow()], documents: [regulationRow({ agencyNames: ['DOD'] })] },
  });
  expect((await h.service.getCommentPeriodAlerts(tenantId)).alerts[0]!.relevanceScore).toBe(0.7);
  const write = h.callsOf('changeUpsert')[0]!.args[0] as { create: { relatedIssues: string[] } };
  expect(write.create.relatedIssues).toEqual(['DEF', 'HOM', 'AER', 'INT']);
});

it('comment alerts preserve reverse federal topic matching and one-way state title/abstract keywords', async () => {
  const h = harness({
    rows: {
      clients: [clientRow()],
      documents: [regulationRow({ topics: ['erson'] })],
      stateRules: [
        {
          id: 'state-one',
          title: 'erson',
          abstract: null,
          agency: 'DOD',
          state: 'FL',
          ruleType: 'proposed',
          commentEndDate: until,
        },
      ],
    },
  });
  expect(
    (await h.service.getCommentPeriodAlerts(tenantId)).alerts.map((alert) => alert.documentId),
  ).toEqual(['doc-one']);
  expect(h.callsOf('changeUpsert')).toHaveLength(1);
});

it.each<{ days: number; severity: string; score: number; rawScore: number }>([
  { days: 1.1, severity: 'critical', score: 1.4, rawScore: 1.4 },
  { days: 3, severity: 'notable', score: 1.05, rawScore: 1.0499999999999998 },
  { days: 7, severity: 'notable', score: 1.05, rawScore: 1.0499999999999998 },
  { days: 8, severity: 'info', score: 0.7, rawScore: 0.7 },
])(
  'comment alerts retain ceil countdown and severity/score boundaries at $days days',
  async (example) => {
    const h = harness({
      rows: {
        clients: [clientRow()],
        documents: [
          regulationRow({
            commentEndDate: new Date(now.getTime() + example.days * day),
          }),
        ],
      },
    });
    const alert = (await h.service.getCommentPeriodAlerts(tenantId)).alerts[0]!;
    expect(alert).toMatchObject({
      daysToDeadline: example.days === 1.1 ? 2 : example.days,
      severity: example.severity,
      relevanceScore: example.score,
    });
    const write = h.callsOf('changeUpsert')[0]!.args[0] as {
      create: { data: { relevanceScore: number } };
    };
    expect(write.create.data.relevanceScore).toBe(example.rawScore);
  },
);

it('comment alerts normalize capability sectors but ignore short/nonstring keyword tags', async () => {
  const client = clientRow({ capabilities: [{ sector: 'DoD', name: null, tags: ['abc', 42] }] });
  const h = harness({
    rows: {
      clients: [client],
      documents: [regulationRow({ agencyNames: ['DOD'], topics: [] })],
      stateRules: [
        {
          id: 'state-one',
          title: 'abc',
          abstract: null,
          ruleType: 'notice',
          agency: 'DOD',
          state: 'FL',
          commentEndDate: until,
        },
      ],
    },
  });
  expect(
    (await h.service.getCommentPeriodAlerts(tenantId)).alerts.map((alert) => alert.documentId),
  ).toEqual(['doc-one']);
});

it('comment alerts await every global change write and retain alerts when one emission fails', async () => {
  const held = deferred<unknown>();
  const h = harness({
    rows: {
      clients: [clientRow()],
      documents: [regulationRow(), regulationRow({ id: 'doc-two' })],
    },
    queues: { changeUpsert: [new Error('emit failed'), held.promise] },
  });
  const pending = h.service.getCommentPeriodAlerts(tenantId);
  await h.started('changeUpsert');
  await Promise.resolve();
  expect(h.callsOf('changeUpsert')).toHaveLength(2);
  held.resolve({});
  expect((await pending).alerts).toHaveLength(2);
  expect(h.warnings).toEqual(['Failed to emit comment-period change: emit failed']);
});

it('comment alert reruns preserve per-document/per-client keys and bound emitted title length', async () => {
  const h = harness({
    rows: {
      clients: [clientRow(), clientRow({ id: 'other-client' })],
      documents: [regulationRow({ title: 'T'.repeat(90) })],
    },
  });
  await h.service.getCommentPeriodAlerts(tenantId);
  await h.service.getCommentPeriodAlerts(tenantId);
  const writes = h
    .callsOf('changeUpsert')
    .map((call) => call.args[0] as { where: { dedupeKey: string }; create: { title: string } });
  expect(writes.map((write) => write.where.dedupeKey)).toEqual([
    `comment_deadline:federal_register:doc-one:${clientId}`,
    'comment_deadline:federal_register:doc-one:other-client',
    `comment_deadline:federal_register:doc-one:${clientId}`,
    'comment_deadline:federal_register:doc-one:other-client',
  ]);
  expect(writes[0]!.create.title).toBe(`Comment period closing in 14d: ${'T'.repeat(80)}`);
});

it.each(['clients', 'documents', 'stateRules'])(
  'comment alerts keep %s query errors fatal without emitter warnings',
  async (operation) => {
    const failure = new Error(`failed:${operation}`);
    const h = harness({ errors: { [operation]: failure } });
    await expect(h.service.getCommentPeriodAlerts(tenantId)).rejects.toBe(failure);
    expect(h.callsOf('changeUpsert')).toEqual([]);
    expect(h.warnings).toEqual([]);
  },
);

it('comment alerts preserve malformed federal JSON and null-emission-error failures', async () => {
  const h = harness({
    rows: { clients: [clientRow()], documents: [regulationRow({ agencyNames: null })] },
  });
  await expect(h.service.getCommentPeriodAlerts(tenantId)).rejects.toThrow(TypeError);
  expect(h.callsOf('changeUpsert')).toEqual([]);
  const other = harness({
    rows: { clients: [clientRow()], documents: [regulationRow()] },
    errors: { changeUpsert: null },
  });
  await expect(other.service.getCommentPeriodAlerts(tenantId)).rejects.toThrow(TypeError);
  expect(other.warnings).toEqual([]);
});
