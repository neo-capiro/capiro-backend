import {
  advocacy,
  clientId,
  harness,
  installLifecycleClock,
  matter,
  now,
  outcome,
  persisted,
  runId,
  sqlText,
  tenantId,
} from '../../test/fixtures/client-profile-fill-lifecycle-outcomes.js';

installLifecycleClock();

it('reads one tenant snapshot in source order and advances an empty cursor', async () => {
  const h = harness();
  await expect(h.gather()).resolves.toBe(0);
  expect(h.calls.map((call) => call.operation)).toEqual([
    'begin',
    'findings',
    'records',
    'events',
    'matters',
    'commit',
    'begin',
    'cursor',
    'commit',
  ]);
  expect(h.callsOf('findings')[0]!.args).toEqual([tenantId, clientId, runId]);
  expect(sqlText(h.callsOf('findings')[0]!.sql)).toContain(
    "kind = 'advocacy_record' AND status IN ('pending', 'accepted')",
  );
  expect(h.callsOf('records')[0]!.args).toEqual([tenantId, clientId]);
  expect(sqlText(h.callsOf('records')[0]!.sql)).toContain(
    'ORDER BY activity_date DESC NULLS LAST LIMIT 250',
  );
  expect(h.callsOf('events')[0]!.args).toEqual([
    {
      where: { tenantId, clientId },
      select: {
        id: true,
        kind: true,
        sourceType: true,
        sourceId: true,
        evidence: true,
        notes: true,
        observedAt: true,
      },
      orderBy: { observedAt: 'desc' },
      take: 250,
    },
  ]);
  expect(h.callsOf('matters')[0]!.args).toEqual([tenantId, clientId]);
  expect(
    h.calls
      .filter((call) => ['findings', 'records', 'events', 'matters'].includes(call.operation))
      .map((call) => call.transaction),
  ).toEqual([1, 1, 1, 1]);
  expect(h.transactions.map((tx) => [tx.tenantId, tx.status])).toEqual([
    [tenantId, 'commit'],
    [tenantId, 'commit'],
  ]);
  expect(h.cursors).toEqual([
    {
      tenantId,
      clientId,
      source: 'lifecycle_outcomes',
      watermark: { refreshedAt: now, latestOutcomeAt: null },
    },
  ]);
  expect(h.unexpected).not.toHaveBeenCalled();
});

it('gives the first pending external key priority over later pending and persisted candidates', async () => {
  const h = harness({
    findings: [
      advocacy({ externalKey: 'same', sourceId: null }),
      advocacy({ externalKey: 'same', matterId: 'matter-one' }),
    ],
    persisted: [
      persisted({ external_key: 'same', matter_id: 'matter-one' }),
      persisted({ external_key: 'unique', matter_id: 'matter-one' }),
    ],
    outcomes: [outcome({ sourceId: null, evidence: { peCode: '0601234' } })],
    matters: [matter({ primaryPeCode: '0601234' })],
  });
  await expect(h.gather()).resolves.toBe(1);
  expect(h.findings.map((finding) => finding.targetKey)).toEqual([
    'advocacy-outcome:unique:outcome-one',
  ]);
  expect(h.findings[0]!.proposedValue.matchedOn).toBe('pe_code');
});

it.each([undefined, null, '', '  '])('ignores missing external key %p', async (externalKey) => {
  const h = harness({ findings: [advocacy({ externalKey })], outcomes: [outcome()] });
  await expect(h.gather()).resolves.toBe(0);
  expect(h.callsOf('terminal')).toHaveLength(0);
  expect(h.cursors).toHaveLength(1);
});

it.each([
  [-1, 0],
  [0, 1],
  [1, 1],
])(
  'generic outcome offset %s allows equal dates and rejects earlier dates',
  async (offset, count) => {
    const h = harness({
      findings: [advocacy({ activityDate: '2026-02-01T00:00:00.000Z' })],
      outcomes: [outcome({ observedAt: new Date(Date.UTC(2026, 1, 1) + offset) })],
    });
    await expect(h.gather()).resolves.toBe(count);
    expect(h.findings).toHaveLength(count);
  },
);

it.each([null, 'invalid', new Date('2026-03-01T00:00:00.000Z')])(
  'retains parseDate coercion for activity date %p',
  async (activityDate) => {
    const h = harness({ findings: [advocacy({ activityDate })], outcomes: [outcome()] });
    await expect(h.gather()).resolves.toBe(1);
  },
);

it.each<[Record<string, unknown>, string | null, string, string, string]>([
  [{ peCode: '0601234', billNumber: 'HR99' }, '0601234', 'HR99', 'pe_code', 'Program Element'],
  [{ billNumber: 'HR99' }, null, 'HR99', 'bill_id', 'bill'],
])(
  'matches only the record own Matter with identifier priority %p',
  async (evidence, primaryPeCode, primaryBillId, matchedOn, label) => {
    const h = harness({
      findings: [advocacy({ matterId: 'matter-one', sourceId: null })],
      outcomes: [outcome({ evidence, sourceId: null })],
      matters: [
        matter({
          primaryPeCode: primaryPeCode as string | null,
          primaryBillId: primaryBillId as string,
        }),
      ],
    });
    await expect(h.gather()).resolves.toBe(1);
    expect(h.findings[0]).toMatchObject({
      runId,
      tenantId,
      clientId,
      kind: 'advocacy_outcome',
      source: 'lifecycle_outcomes',
      factKind: 'recommendation',
      currentValue: null,
      confidence: 0.95,
      status: 'pending',
      proposedValue: {
        matchedOn,
        relationship: 'strongly_aligned',
        causationClaimed: false,
        score: 0.95,
      },
    });
    expect(h.findings[0]!.evidence[0]!.label).toContain(`${label} exactly`);
    expect(h.findings[0]!.evidence[0]!.metadata).toMatchObject({
      matchedOn,
      causationClaimed: false,
    });
  },
);

it('does not borrow identifiers from a different Matter', async () => {
  const h = harness({
    findings: [advocacy({ matterId: 'matter-one', sourceId: null })],
    outcomes: [outcome({ sourceId: null, evidence: { peCode: '0601234' } })],
    matters: [matter(), matter({ id: 'other-matter', primaryPeCode: '0601234' })],
  });
  await expect(h.gather()).resolves.toBe(0);
  expect(h.findings).toEqual([]);
});

it.each<[string, string | null, string | null, number, string]>([
  ['alpha bravo charlie delta', 'alpha bravo charlie delta', null, 0.89, 'related'],
  ['alpha', 'alpha', null, 0.402, 'observed_after_advocacy'],
  ['alpha', null, 'source-one', 0.79, 'related'],
])(
  'uses the defined semantic/source score and vocabulary for %s',
  async (title, notes, sourceId, score, relationship) => {
    const event = outcome({ notes, sourceId });
    const h = harness({ findings: [advocacy({ title, sourceId })], outcomes: [event] });
    await expect(h.gather()).resolves.toBe(1);
    expect(h.findings[0]!.proposedValue).toEqual({
      advocacyExternalKey: 'advocacy:one',
      outcomeEventId: event.id,
      outcomeKind: event.kind,
      observedAt: event.observedAt.toISOString(),
      notes,
      evidence: {},
      relationship,
      matchedOn: 'semantic_and_temporal',
      causationClaimed: false,
      score,
    });
    expect(h.findings[0]!.confidence).toBe(score);
    expect(h.findings[0]!.evidence[0]).toEqual({
      label: 'Observed outcome "result" followed a related advocacy record',
      source: 'Capiro Outcome Event',
      metadata: {
        outcomeEventId: event.id,
        observedAt: event.observedAt.toISOString(),
        causationClaimed: false,
        matchedOn: 'semantic_and_temporal',
      },
    });
  },
);

it.each<[string, string, number, number | null]>([
  ['alpha bravo charlie delta echo foxtrot', 'alpha golf hotel india juliet kilo', 1, 0.348],
  [
    'alpha bravo charlie delta echo foxtrot zulu',
    'alpha golf hotel india juliet kilo lima',
    0,
    null,
  ],
])('keeps the 0.34 semantic gate for %s', async (title, notes, count, score) => {
  const h = harness({
    findings: [advocacy({ title, sourceId: null })],
    outcomes: [outcome({ notes, sourceId: null })],
  });
  await expect(h.gather()).resolves.toBe(count);
  expect(h.findings).toHaveLength(count);
  if (count) expect(h.findings[0]!.confidence).toBe(score);
});

it('counts only inserted findings toward 75 and keeps the latest-first snapshot cursor', async () => {
  const outcomes = Array.from({ length: 85 }, (_, i) =>
    outcome({
      id: `event-${i}`,
      observedAt: new Date(Date.UTC(2026, 3, 1) - i * 86_400_000),
    }),
  );
  const h = harness({
    findings: [advocacy({ activityDate: null })],
    outcomes,
    terminalAt: [1, 3],
    insertResults: [0, 0],
  });
  await expect(h.gather()).resolves.toBe(75);
  expect(h.callsOf('terminal')).toHaveLength(79);
  expect(h.attempts).toHaveLength(77);
  expect(h.findings).toHaveLength(75);
  expect(h.findings[74]!.targetKey).toBe('advocacy-outcome:advocacy:one:event-78');
  expect(h.cursors[0]!.watermark).toEqual({
    refreshedAt: now,
    latestOutcomeAt: outcomes[0]!.observedAt.toISOString(),
  });
  expect(h.callsOf('terminal')[0]!.args.slice(0, 2)).toEqual([tenantId, clientId]);
  expect(h.transactions).toHaveLength(81);
});

it('stops before reading the next record external key after reaching the cap', async () => {
  const readNext = jest.fn(() => 'advocacy:second');
  const next = advocacy();
  Object.defineProperty(next, 'externalKey', { get: readNext });
  const h = harness({
    findings: [advocacy(), next],
    outcomes: Array.from({ length: 75 }, (_, i) => outcome({ id: `event-${i}` })),
  });
  await expect(h.gather()).resolves.toBe(75);
  expect(readNext).not.toHaveBeenCalled();
});

it.each(['findings', 'records', 'events', 'matters'] as const)(
  'propagates %s snapshot failures before any finding or cursor write',
  async (snapshotFailure) => {
    const h = harness({ snapshotFailure, findings: [advocacy()], outcomes: [outcome()] });
    await expect(h.gather()).rejects.toThrow(`${snapshotFailure} failed`);
    expect(h.transactions.map((tx) => tx.status)).toEqual(['rollback']);
    expect(h.findings).toEqual([]);
    expect(h.cursorAttempts).toEqual([]);
  },
);

it('preserves prior committed findings when a later finding insert fails', async () => {
  const h = harness({
    findings: [advocacy()],
    outcomes: [outcome({ id: 'first' }), outcome({ id: 'second' })],
    failInsertAt: 2,
  });
  await expect(h.gather()).rejects.toThrow('insert failed');
  expect(h.attempts).toHaveLength(2);
  expect(h.findings.map((finding) => finding.proposedValue.outcomeEventId)).toEqual(['first']);
  expect(h.transactions.map((tx) => tx.status)).toEqual(['commit', 'commit', 'rollback']);
  expect(h.cursorAttempts).toEqual([]);
});

it('writes the cursor after findings and keeps their commits if cursor persistence fails', async () => {
  const h = harness({ findings: [advocacy()], outcomes: [outcome()], failCursor: true });
  await expect(h.gather()).rejects.toThrow('cursor failed');
  expect(h.findings).toHaveLength(1);
  expect(h.cursors).toEqual([]);
  expect(h.cursorAttempts).toHaveLength(1);
  expect(h.transactions.map((tx) => tx.status)).toEqual(['commit', 'commit', 'rollback']);
  expect(h.calls.slice(-5).map((call) => call.operation)).toEqual([
    'insert',
    'commit',
    'begin',
    'cursor',
    'rollback',
  ]);
});

it('preserves date serialization order and evaluates refreshedAt after the last insert', async () => {
  const event = outcome();
  const effects: string[] = [];
  const eventIso = event.observedAt.toISOString.bind(event.observedAt);
  const serialize = jest.spyOn(event.observedAt, 'toISOString').mockImplementation(() => {
    effects.push('event-date');
    return eventIso();
  });
  const atCursor = '2026-10-13T12:01:00.000Z';
  const h = harness({
    findings: [advocacy()],
    outcomes: [event],
    onOperation: (operation) => {
      if (operation === 'insert') {
        effects.push('insert');
        jest.setSystemTime(new Date(atCursor));
      }
      if (operation === 'cursor') effects.push('cursor');
    },
  });
  await expect(h.gather()).resolves.toBe(1);
  expect(serialize).toHaveBeenCalledTimes(3);
  expect(effects).toEqual(['event-date', 'event-date', 'insert', 'event-date', 'cursor']);
  expect(h.cursors[0]!.watermark.refreshedAt).toBe(atCursor);
});

it('uses the first snapshot event date for the cursor even when no event qualifies', async () => {
  const outcomes = [
    outcome(),
    outcome({ id: 'newer', observedAt: new Date('2026-06-01T00:00:00Z') }),
  ];
  const h = harness({ findings: [advocacy({ sourceId: null })], outcomes });
  await expect(h.gather()).resolves.toBe(0);
  expect(h.cursors[0]!.watermark).toEqual({
    refreshedAt: now,
    latestOutcomeAt: outcomes[0]!.observedAt.toISOString(),
  });
});
