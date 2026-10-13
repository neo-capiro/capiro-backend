import {
  clientId,
  clientRow,
  harness,
  installHooks,
  now,
  regulationRow,
  since,
  tenantId,
} from '../../test/fixtures/intelligence-alerts.js';

installHooks();

it('overdue alerts keep missing-client early return before global expired-document reads', async () => {
  const h = harness({ rows: { client: null } });
  expect(await h.service.getOverdueCommentAlerts(clientId, tenantId, now, since)).toEqual([]);
  expect(h.calls.map((call) => call.operation)).toEqual(['withTenant', 'client']);
});

it('overdue alerts pin tenant relevance fields and the closed half-open global window', async () => {
  const h = harness({
    rows: {
      client: clientRow({ status: 'archived' }),
      documents: [regulationRow({ commentEndDate: since, agencyNames: null })],
    },
  });
  const countdown = jest.spyOn(h.subject, 'alertCountdownLabel');
  expect(await h.service.getOverdueCommentAlerts(clientId, tenantId, now, since)).toEqual([
    {
      id: 'comment_overdue:doc-one',
      type: 'comment_overdue',
      severity: 'notable',
      title: 'Deadline closed: Rule title',
      subtitle: 'Federal Register',
      when: since.toISOString(),
      countdownDays: -7,
      countdownLabel: 'Overdue 7d',
      href: `/intelligence/changes?clientId=${clientId}&source=comment_overdue`,
      _urgencyScore: 30,
      _typeRank: 2,
    },
  ]);
  expect(h.callsOf('client')[0]).toMatchObject({
    tenantId,
    transaction: 1,
    scope: 'tenant',
    args: [
      {
        where: { id: clientId },
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
        where: {
          type: { in: ['PROPOSED_RULE', 'RULE'] },
          commentEndDate: { gte: since, lt: now },
        },
        orderBy: { commentEndDate: 'desc' },
        take: 40,
      },
    ],
  });
  expect(countdown).toHaveBeenCalledWith(-7);
});

it('overdue alerts retain source row order, title/agency caps and a five-row output cap', async () => {
  const docs = Array.from({ length: 6 }, (_, index) =>
    regulationRow({
      id: `doc-${index}`,
      title: 'T'.repeat(150),
      agencyNames: ['One', 'Two', 'Three'],
      commentEndDate: since,
    }),
  );
  const h = harness({ rows: { documents: docs } });
  const result = await h.service.getOverdueCommentAlerts('client/one', tenantId, now, since);
  expect(result.map((alert) => alert.id)).toEqual([
    'comment_overdue:doc-0',
    'comment_overdue:doc-1',
    'comment_overdue:doc-2',
    'comment_overdue:doc-3',
    'comment_overdue:doc-4',
  ]);
  expect(result[0]!.title).toHaveLength(140);
  expect(result[0]!.subtitle).toBe('One / Two');
  expect(result[0]!.href).toContain('clientId=client%2Fone');
});

it('overdue alerts inspect rows beyond the five-visible cap and discard partial output on malformed topics', async () => {
  const h = harness({
    rows: {
      documents: [
        ...Array.from({ length: 5 }, () => regulationRow({ commentEndDate: since })),
        regulationRow({ id: 'malformed-sixth', topics: [null], commentEndDate: since }),
      ],
    },
  });
  expect(await h.service.getOverdueCommentAlerts(clientId, tenantId, now, since)).toEqual([]);
  expect(h.warnings[0]).toContain(`getOverdueCommentAlerts failed for ${clientId}:`);
});

it.each(['client', 'documents'])(
  'overdue alerts warn and return empty after %s read errors',
  async (operation) => {
    const h = harness({ errors: { [operation]: new Error(`failed:${operation}`) } });
    expect(await h.service.getOverdueCommentAlerts(clientId, tenantId, now, since)).toEqual([]);
    expect(h.warnings).toEqual([
      `getOverdueCommentAlerts failed for ${clientId}: failed:${operation}`,
    ]);
  },
);
