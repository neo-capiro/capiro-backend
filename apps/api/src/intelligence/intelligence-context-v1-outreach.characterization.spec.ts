import {
  clientId,
  day,
  deferred,
  harness,
  healthOperations,
  installHooks,
  now,
  tenantId,
} from '../../test/fixtures/intelligence-context.js';

installHooks();

it('always returns engagement health when every optional context section is empty', async () => {
  const h = harness();
  await expect(h.service.getOutreachContext(clientId, tenantId)).resolves.toEqual({
    context: 'ENGAGEMENT HEALTH: 0/100 (stable)',
  });
  expect(h.callsOf('confirmedLdaIds')[0]!.args).toEqual([clientId, tenantId]);
  expect(h.callsOf('issueCodes')[0]!.args).toEqual([[]]);
  expect(h.callsOf('trackedBills')[0]!.args).toEqual([clientId, tenantId]);
  expect(h.callsOf('coverageRegistrants')).toHaveLength(0);
});

it('awaits confirmed identities then their full issue set before launching the five-way context bundle', async () => {
  const ids = deferred<number[]>();
  const issues = deferred<string[]>();
  const gate = deferred<unknown>();
  const confirmed = [4, 2, 4];
  const codes = ['DEF', 'SCI'];
  const h = harness({
    results: {
      confirmedLdaIds: ids.promise,
      issueCodes: issues.promise,
      trackedBills: gate.promise.then(() => ({ bills: [] })),
      hearings: gate.promise,
      changes: gate.promise,
      commentPeriods: gate.promise,
      meetings: gate.promise.then(() => 0),
    },
  });
  const pending = h.service.getOutreachContext(clientId, tenantId);
  expect(h.calls.map((call) => call.operation)).toEqual(['confirmedLdaIds']);
  ids.resolve(confirmed);
  await h.started('issueCodes');
  expect(h.calls.map((call) => call.operation)).toEqual(['confirmedLdaIds', 'issueCodes']);
  expect(h.callsOf('issueCodes')[0]!.args[0]).toBe(confirmed);
  issues.resolve(codes);
  await h.started('outreach');
  expect(h.calls.map((call) => call.operation)).toEqual([
    'confirmedLdaIds',
    'issueCodes',
    'trackedBills',
    'hearings',
    'changes',
    'commentPeriods',
    ...healthOperations,
    ...healthOperations,
  ]);
  expect(h.callsOf('changes')[0]!.args).toEqual([
    {
      where: {
        OR: [{ relatedClientIds: { has: clientId } }, { relatedIssues: { hasSome: codes } }],
        detectedAt: { gte: new Date(now.getTime() - 7 * day) },
      },
      orderBy: { detectedAt: 'desc' },
      take: 5,
    },
  ]);
  gate.resolve([]);
  await expect(pending).resolves.toEqual({ context: 'ENGAGEMENT HEALTH: 0/100 (stable)' });
});

it('uses exact global federal hearing, change and comment selectors with an Eastern calendar-day floor', async () => {
  const h = harness();
  await h.service.getOutreachContext(clientId, tenantId);
  expect(h.callsOf('hearings')[0]).toMatchObject({
    scope: 'global',
    transaction: undefined,
    tenantId: undefined,
    args: [
      {
        where: {
          AND: [
            { canonicalHearingId: null },
            { OR: [{ geographicJurisdiction: 'US' }, { geographicJurisdiction: null }] },
            {
              date: {
                gte: new Date('2026-10-12T00:00:00.000Z'),
                lte: new Date('2026-10-27T02:00:00.000Z'),
              },
            },
          ],
        },
        orderBy: { date: 'asc' },
        take: 5,
      },
    ],
  });
  expect(h.callsOf('changes')[0]).toMatchObject({
    scope: 'global',
    args: [
      {
        where: {
          OR: [{ relatedClientIds: { has: clientId } }],
          detectedAt: { gte: new Date('2026-10-06T02:00:00.000Z') },
        },
        orderBy: { detectedAt: 'desc' },
        take: 5,
      },
    ],
  });
  expect(h.callsOf('commentPeriods')[0]).toMatchObject({
    scope: 'global',
    args: [
      {
        where: {
          type: { in: ['PROPOSED_RULE', 'RULE'] },
          commentEndDate: { gt: now, lte: new Date('2026-10-27T02:00:00.000Z') },
        },
        orderBy: { commentEndDate: 'asc' },
        take: 5,
        select: { title: true, commentEndDate: true, agencyNames: true },
      },
    ],
  });
  expect(h.transactions).toHaveLength(10);
});

it('captures outreach time before identity awaits while real health captures a fresh post-await time', async () => {
  const identities = deferred<number[]>();
  const h = harness({ results: { confirmedLdaIds: identities.promise } });
  const pending = h.service.getOutreachContext(clientId, tenantId);
  jest.setSystemTime(new Date('2026-10-14T02:00:00.000Z'));
  identities.resolve([]);
  await pending;
  expect(h.callsOf('changes')[0]!.args).toEqual([
    {
      where: {
        OR: [{ relatedClientIds: { has: clientId } }],
        detectedAt: { gte: new Date('2026-10-06T02:00:00.000Z') },
      },
      orderBy: { detectedAt: 'desc' },
      take: 5,
    },
  ]);
  expect(h.callsOf('meetings')[0]!.args).toEqual([
    { where: { clientId, startsAt: { gte: new Date('2026-10-07T02:00:00.000Z') } } },
  ]);
  const commentWhere = (
    h.callsOf('commentPeriods')[0]!.args[0] as {
      where: { commentEndDate: { gt: Date; lte: Date } };
    }
  ).where;
  expect(commentWhere.commentEndDate.gt).toEqual(now);
  expect(commentWhere.commentEndDate.lte).toEqual(new Date('2026-10-27T02:00:00.000Z'));
});

it('formats all sections in the original order using raw 60/40-character truncation and real health', async () => {
  const h = harness({
    results: {
      trackedBills: {
        bills: [{ identifier: 'HR 1', title: 'B'.repeat(61), latestActionText: 'A'.repeat(41) }],
      },
      hearings: [
        {
          committeeName: 'Armed Services',
          title: 'H'.repeat(61),
          date: new Date('2026-10-14T03:00:00.000Z'),
          chamber: 'Senate',
        },
      ],
      changes: [{ changeType: 'bill_action', title: 'Untruncated change title' }],
      commentPeriods: [
        {
          title: 'R'.repeat(61),
          commentEndDate: new Date('2026-10-13T03:00:00.000Z'),
          agencyNames: ['DOD', 'NASA', 'DOE'],
        },
      ],
    },
    queues: { meetings: [1, 0] },
  });
  expect(await h.service.getOutreachContext(clientId, tenantId)).toEqual({
    context:
      `TRACKED BILLS:\n- HR 1: ${'B'.repeat(60)} [${'A'.repeat(40)}]\n\n` +
      `UPCOMING HEARINGS (14d):\n- Armed Services: "${'H'.repeat(60)}" (in 2d, Senate)\n\n` +
      'RECENT INTELLIGENCE (7d):\n- [bill_action] Untruncated change title\n\n' +
      `COMMENT PERIOD DEADLINES:\n- "${'R'.repeat(60)}", 1d left (DOD/NASA)\n\n` +
      'ENGAGEMENT HEALTH: 15/100 (improving)',
  });
});

it('locally caps tracked bill display at five and omits falsey action text', async () => {
  const bills = [
    { identifier: 'B1', title: 'One', latestActionText: '' },
    { identifier: 'B2', title: 'Two', latestActionText: null },
    { identifier: 'B3', title: 'Three', latestActionText: 'Action' },
    { identifier: 'B4', title: 'Four' },
    { identifier: 'B5', title: 'Five' },
    { identifier: 'B6', title: 'Six' },
  ];
  const h = harness({ results: { trackedBills: { bills } } });
  expect((await h.service.getOutreachContext(clientId, tenantId)).context).toBe(
    'TRACKED BILLS:\n- B1: One\n- B2: Two\n- B3: Three [Action]\n- B4: Four\n- B5: Five\n\nENGAGEMENT HEALTH: 0/100 (stable)',
  );
});

it('does not add local five-row caps to hearing, change or comment responses', async () => {
  const h = harness({
    results: {
      hearings: Array.from({ length: 6 }, (_, index) => ({
        committeeName: `C${index}`,
        title: 'H',
        date: now,
        chamber: 'House',
      })),
      changes: Array.from({ length: 6 }, (_, index) => ({
        changeType: 'raw',
        title: `Change ${index}`,
      })),
      commentPeriods: Array.from({ length: 6 }, (_, index) => ({
        title: `Rule ${index}`,
        commentEndDate: now,
        agencyNames: [],
      })),
    },
  });
  const { context } = await h.service.getOutreachContext(clientId, tenantId);
  expect(context).toContain('- C5: "H" (in 0d, House)');
  expect(context).toContain('- [raw] Change 5');
  expect(context).toContain('- "Rule 5", 0d left ()');
  expect(context.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(18);
});

it('retains negative day calculations, string hearing dates and untruncated intelligence titles', async () => {
  const title = 'x'.repeat(200);
  const h = harness({
    results: {
      hearings: [
        {
          committeeName: 'Committee',
          title: 'Past',
          date: '2026-10-11T02:00:00.000Z',
          chamber: null,
        },
      ],
      changes: [{ changeType: 'raw', title }],
    },
  });
  expect((await h.service.getOutreachContext(clientId, tenantId)).context).toBe(
    `UPCOMING HEARINGS (14d):\n- Committee: "Past" (in -2d, null)\n\nRECENT INTELLIGENCE (7d):\n- [raw] ${title}\n\nENGAGEMENT HEALTH: 0/100 (stable)`,
  );
});

it.each(['confirmedLdaIds', 'issueCodes'] as const)(
  'propagates %s failures before starting any bundle read',
  async (operation) => {
    const error = new Error(`${operation} failed`);
    const h = harness({ errors: { [operation]: error } });
    await expect(h.service.getOutreachContext(clientId, tenantId)).rejects.toBe(error);
    expect(h.callsOf('trackedBills')).toHaveLength(0);
    expect(h.callsOf('hearings')).toHaveLength(0);
    expect(h.transactions).toHaveLength(0);
  },
);

it.each(['trackedBills', 'hearings', 'changes', 'commentPeriods', 'meetings'] as const)(
  'keeps the %s bundle failure fatal after eagerly launching every branch',
  async (operation) => {
    const error = new Error(`${operation} failed`);
    const h = harness({ errors: { [operation]: error } });
    await expect(h.service.getOutreachContext(clientId, tenantId)).rejects.toBe(error);
    expect(h.calls.map((call) => call.operation)).toEqual([
      'confirmedLdaIds',
      'issueCodes',
      'trackedBills',
      'hearings',
      'changes',
      'commentPeriods',
      ...healthOperations,
      ...healthOperations,
    ]);
    expect(h.callsOf('coverageRegistrants')).toHaveLength(0);
  },
);
