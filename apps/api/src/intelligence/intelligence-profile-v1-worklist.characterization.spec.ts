import {
  harness,
  clientId,
  tenantId,
  userId,
  now,
  installHooks,
  trackedBill,
  internalAlert,
} from '../../test/fixtures/intelligence-profile-v1.js';

installHooks();
const day = 86_400_000;
const comment = (
  documentId: string,
  daysToDeadline: number | null = 3,
  extra: Record<string, unknown> = {},
) => ({
  documentId,
  title: `Document ${documentId}`,
  clientId,
  clientName: 'Acme',
  commentEndDate: new Date(now.getTime() + (daysToDeadline ?? 0) * day),
  daysToDeadline,
  severity: 'notable',
  agencies: ['Agency A', 'Agency B', 'Agency C'],
  ...extra,
});
const change = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Change ${id}`,
  source: 'Source',
  changeType: 'legislation',
  severity: 'notable',
  detectedAt: now,
  ...extra,
});
const tracked = (rows: ReturnType<typeof trackedBill>[]) => ({
  total: rows.length,
  issueCodes: [],
  bills: rows,
});
const ids = (rows: ReadonlyArray<Record<string, unknown>>) => rows.map((row) => row.id);

describe('Profile worklist tracked-bill movement time and labels', () => {
  it.each([
    { date: new Date(now.getTime() - 14 * day), included: true },
    { date: new Date(now.getTime() - 14 * day - 1), included: false },
    { date: now, included: true },
    { date: new Date(now.getTime() + 1), included: false },
    { date: new Date('invalid'), included: false },
    { date: null, included: false },
  ])(
    'uses the exact inclusive fourteen-day/present window and excludes invalid dates: %p',
    async ({ date, included }) => {
      const bill = trackedBill({
        identifier: '119-hr-22',
        latestActionDate: date,
        latestActionText: 'Introduced',
      });
      const h = harness({ sourceResults: { getTrackedBills: tracked([bill]) } });
      expect(ids((await h.profile(userId)).sections.snapshot.topAlerts)).toEqual(
        included ? ['bill:119-hr-22'] : [],
      );
    },
  );
  it.each(['vote', 'floor', 'PASSED', 'enacted', 'markup', 'reported', 'signed'])(
    'escalates the hot action word %s using a whole-word case-insensitive match',
    async (word) => {
      const h = harness({
        sourceResults: {
          getTrackedBills: tracked([
            trackedBill({ latestActionDate: now, latestActionText: `Committee ${word} today` }),
          ]),
        },
      });
      expect((await h.profile(userId)).sections.snapshot.topAlerts[0]!.severity).toBe('critical');
    },
  );
  it('keeps partial action words notable and distinguishes manually tracked titles', async () => {
    const bill = trackedBill({
      identifier: '119-hr-22',
      latestActionDate: new Date(now.getTime() - 2 * day),
      latestActionText: 'Voteable floorboard signedness',
      isManual: true,
    });
    const h = harness({ sourceResults: { getTrackedBills: tracked([bill]) } });
    expect((await h.profile(userId)).sections.snapshot.topAlerts[0]).toMatchObject({
      id: 'bill:119-hr-22',
      type: 'bill_movement',
      severity: 'notable',
      title: '119-HR-22 moved (tracked)',
      subtitle: bill.latestActionText,
      countdownDays: null,
      countdownLabel: '2d ago',
      state: null,
    });
  });
  it('uses the bill title when its action text is null and escapes the bill drill route', async () => {
    const bill = trackedBill({
      identifier: '119-hr-22/part',
      title: 'Research authorization',
      latestActionDate: now,
      latestActionText: null,
      isManual: false,
    });
    const h = harness({ sourceResults: { getTrackedBills: tracked([bill]) } });
    expect((await h.profile(userId)).sections.snapshot.topAlerts[0]).toMatchObject({
      title: '119-HR-22/PART moved',
      subtitle: 'Research authorization',
      countdownLabel: 'Today',
      href: `/intelligence/bills/119-hr-22%2Fpart?clientId=${encodeURIComponent(clientId)}`,
    });
  });
});

describe('Profile worklist comment and change presentation', () => {
  it.each([
    { days: -2, label: 'Overdue 2d' },
    { days: 0, label: 'Due today' },
    { days: 1, label: '1d left' },
    { days: 7, label: '7d left' },
    { days: null, label: null },
  ])(
    'retains deadline countdown %p and limits the agency subtitle to two names',
    async ({ days, label }) => {
      const h = harness({
        sourceResults: {
          getCommentPeriodAlerts: {
            alerts: [comment('one', days), comment('other', 0, { clientId: 'another-client' })],
          },
        },
      });
      expect((await h.profile(userId)).sections.snapshot.topAlerts).toHaveLength(1);
      expect((await h.profile(userId)).sections.snapshot.topAlerts[0]).toMatchObject({
        id: 'comment:one',
        type: 'comment_deadline',
        subtitle: 'Agency A / Agency B',
        countdownDays: days,
        countdownLabel: label,
      });
    },
  );
  it.each([
    { age: 0, label: 'Today' },
    { age: 1, label: '1d ago' },
    { age: 2.9, label: '2d ago' },
    { age: -1, label: 'Today' },
  ])('uses floored nonnegative recency for change age %p', async ({ age, label }) => {
    const h = harness({
      sourceResults: {
        getChanges: [change('event', { detectedAt: new Date(now.getTime() - age * day) })],
      },
    });
    expect((await h.profile(userId)).sections.snapshot.topAlerts[0]).toMatchObject({
      id: 'change:event',
      subtitle: 'Source',
      countdownDays: null,
      countdownLabel: label,
    });
  });
});

describe('Profile worklist ranking and source feed merging', () => {
  it('ranks severity before deadline type and urgency', async () => {
    const h = harness({
      sourceResults: {
        getCommentPeriodAlerts: { alerts: [comment('due', 0)] },
        getChanges: [
          change('critical', {
            severity: 'critical',
            detectedAt: new Date(now.getTime() - 40 * day),
          }),
        ],
      },
    });
    expect(ids((await h.profile(userId)).sections.snapshot.topAlerts)).toEqual([
      'change:critical',
      'comment:due',
    ]);
  });
  it('ranks type before urgency when severity ties', async () => {
    const h = harness({
      sourceResults: {
        getCommentPeriodAlerts: { alerts: [comment('distant', 90)] },
        getChanges: [change('fresh')],
      },
    });
    expect(ids((await h.profile(userId)).sections.snapshot.topAlerts)).toEqual([
      'comment:distant',
      'change:fresh',
    ]);
  });
  it('ranks urgency before timestamp and timestamp descending for exact score ties', async () => {
    const old = new Date(now.getTime() - day).toISOString();
    const h = harness({
      sourceResults: {
        getHearingAlerts: [
          internalAlert({
            id: 'urgent-old',
            severity: 'notable',
            _typeRank: 1,
            _urgencyScore: 100,
            when: old,
          }),
          internalAlert({
            id: 'tie-old',
            severity: 'notable',
            _typeRank: 1,
            _urgencyScore: 10,
            when: old,
          }),
        ],
        getContractAwardAlerts: [
          internalAlert({
            id: 'tie-new',
            severity: 'notable',
            _typeRank: 1,
            _urgencyScore: 10,
            when: now.toISOString(),
          }),
        ],
      },
    });
    expect(ids((await h.profile(userId)).sections.snapshot.topAlerts)).toEqual([
      'urgent-old',
      'tie-new',
      'tie-old',
    ]);
  });
});

describe('Profile worklist source feed order and immutable inputs', () => {
  it('merges all seven alert feeds and retains their stable source order for equal rank/time', async () => {
    const normalized = (id: string) =>
      internalAlert({
        id,
        severity: 'notable',
        _typeRank: 1,
        _urgencyScore: 40,
        when: now.toISOString(),
      });
    const h = harness({
      sourceResults: {
        getCommentPeriodAlerts: { alerts: [comment('comment', 60)] },
        getChanges: [change('change')],
        getHearingAlerts: [normalized('hearing')],
        getTrackedBills: tracked([
          trackedBill({
            identifier: '119-hr-22',
            latestActionDate: now,
            latestActionText: 'Introduced',
          }),
        ]),
        getOverdueCommentAlerts: [normalized('overdue')],
        getCompetitorLdaAlerts: [normalized('competitor')],
        getContractAwardAlerts: [normalized('award')],
      },
    });
    expect(ids((await h.profile(userId)).sections.snapshot.topAlerts)).toEqual([
      'comment:comment',
      'bill:119-hr-22',
      'change:change',
      'hearing',
      'overdue',
      'competitor',
      'award',
    ]);
  });
  it('preserves original input arrays/objects while sorting derived visible alerts and removing private rank fields', async () => {
    const rows = Object.freeze([
      change('z', { detectedAt: new Date(now.getTime() - day) }),
      change('a'),
    ]);
    const feed = Object.freeze([
      Object.freeze(internalAlert({ id: 'source-z', _urgencyScore: 1 })),
      Object.freeze(internalAlert({ id: 'source-a', _urgencyScore: 2 })),
    ]);
    const h = harness({ sourceResults: { getChanges: rows, getHearingAlerts: feed } });
    const output = (await h.profile(userId)).sections.snapshot.topAlerts;
    expect(ids(rows)).toEqual(['z', 'a']);
    expect(ids(feed)).toEqual(['source-z', 'source-a']);
    expect(
      output.every(
        (row: Record<string, unknown>) => !('_typeRank' in row) && !('_urgencyScore' in row),
      ),
    ).toBe(true);
    expect(feed[0]).not.toHaveProperty('state');
    expect(
      output.indexOf(output.find((row: Record<string, unknown>) => row.id === 'change:a')!),
    ).toBeLessThan(
      output.indexOf(output.find((row: Record<string, unknown>) => row.id === 'change:z')!),
    );
  });
});

describe('Profile worklist per-user states', () => {
  it('queries the exact client/user state selection and preserves an acknowledged row', async () => {
    const h = harness({
      rows: { alertStates: [{ alertId: 'change:one', state: 'acknowledged', snoozedUntil: null }] },
      sourceResults: { getChanges: [change('one')] },
    });
    const output = await h.profile(userId);
    expect(h.tenantTx.alertState.findMany).toHaveBeenCalledWith({
      where: { userId, clientId },
      select: { alertId: true, state: true, snoozedUntil: true },
    });
    expect(output.sections.snapshot.topAlerts[0]!.state).toBe('acknowledged');
  });
  it('ignores stored per-user rows entirely when the caller omits userId', async () => {
    const h = harness({
      rows: { alertStates: [{ alertId: 'change:one', state: 'dismissed', snoozedUntil: null }] },
      sourceResults: { getChanges: [change('one')] },
    });
    expect(
      (await h.service.getClientProfileV1(clientId, tenantId)).sections.snapshot.topAlerts[0]!
        .state,
    ).toBeNull();
    expect(h.tenantTx.alertState.findMany).not.toHaveBeenCalled();
  });
  it.each([
    { until: null, visible: false },
    { until: new Date(now.getTime() + 1), visible: false },
    { until: now, visible: true },
    { until: new Date(now.getTime() - 1), visible: true },
  ])('hides snoozed rows only for absent or future deadlines: %p', async ({ until, visible }) => {
    const h = harness({
      rows: { alertStates: [{ alertId: 'change:one', state: 'snoozed', snoozedUntil: until }] },
      sourceResults: { getChanges: [change('one')] },
    });
    expect(ids((await h.profile(userId)).sections.snapshot.topAlerts)).toEqual(
      visible ? ['change:one'] : [],
    );
  });
  it.each([
    { states: ['dismissed', 'acknowledged'], visible: true },
    { states: ['acknowledged', 'dismissed'], visible: false },
  ])('uses the final duplicate state row for an alert: %p', async ({ states, visible }) => {
    const h = harness({
      rows: {
        alertStates: states.map((state) => ({ alertId: 'change:one', state, snoozedUntil: null })),
      },
      sourceResults: { getChanges: [change('one')] },
    });
    const output = (await h.profile(userId)).sections.snapshot.topAlerts;
    expect(ids(output)).toEqual(visible ? ['change:one'] : []);
    if (visible) expect(output[0]!.state).toBe('acknowledged');
  });
  it('keeps unknown states visible with a null flag and ignores states for expired alerts', async () => {
    const h = harness({
      rows: {
        alertStates: [
          { alertId: 'change:one', state: 'unknown', snoozedUntil: null },
          { alertId: 'expired', state: 'dismissed', snoozedUntil: null },
        ],
      },
      sourceResults: { getChanges: [change('one')] },
    });
    expect((await h.profile(userId)).sections.snapshot.topAlerts[0]!.state).toBeNull();
  });
});

describe('Profile worklist pagination metadata', () => {
  it('returns twenty visible rows while computing hidden count from the full visible set minus five', async () => {
    const rows = Array.from({ length: 25 }, (_, index) => comment(`document-${index}`, index));
    const h = harness({ sourceResults: { getCommentPeriodAlerts: { alerts: rows } } });
    const snapshot = (await h.profile(userId)).sections.snapshot;
    expect(snapshot.topAlerts).toHaveLength(20);
    expect(snapshot.alertsHiddenCount).toBe(20);
    expect(rows).toHaveLength(25);
  });
  it('computes hidden count after dismissal and floors a short visible list at zero', async () => {
    const h = harness({
      rows: { alertStates: [{ alertId: 'change:hide', state: 'dismissed', snoozedUntil: null }] },
      sourceResults: { getChanges: [change('hide'), change('keep')] },
    });
    const snapshot = (await h.profile(userId)).sections.snapshot;
    expect(ids(snapshot.topAlerts)).toEqual(['change:keep']);
    expect(snapshot.alertsHiddenCount).toBe(0);
  });
});
