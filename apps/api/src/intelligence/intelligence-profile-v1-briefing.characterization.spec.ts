import {
  harness,
  clientId,
  tenantId,
  userId,
  now,
  installHooks,
  profileSpine,
} from '../../test/fixtures/intelligence-profile-v1.js';

installHooks();
const day = 86_400_000;
const deadline = (documentId: string, daysToDeadline = 3, extra: Record<string, unknown> = {}) => ({
  documentId,
  clientId,
  clientName: 'Acme',
  title: `Document ${documentId}`,
  severity: 'info',
  agencies: [],
  commentEndDate: new Date(now.getTime() + daysToDeadline * day),
  daysToDeadline,
  ...extra,
});
const event = (id: string) => ({
  id,
  title: `Event ${id}`,
  changeType: 'legislation',
  severity: 'info',
  source: 'Source',
  detectedAt: now,
});
const tracked = (total: number) => ({ total, bills: [], issueCodes: [] });

describe('Profile daily briefing summary choice', () => {
  it('prefers a trimmed nonempty AI summary without changing aggregate timestamps and CTA', async () => {
    const h = harness({
      sourceResults: {
        getClientProfile: profileSpine({ aiSummary: ' \n Strategic outlook.  ' }),
        getChanges: [event('one')],
      },
    });
    expect((await h.profile()).sections.snapshot.dailyBriefing).toMatchObject({
      summary: 'Strategic outlook.',
      generatedAt: now.toISOString(),
      eventCount: 1,
      ctaHref: `/intelligence/changes?clientId=${encodeURIComponent(clientId)}`,
    });
  });
  it.each([null, ' \n ', 42])(
    'uses deterministic fallback copy for empty or non-string AI summary %p',
    async (aiSummary) => {
      const h = harness({ sourceResults: { getClientProfile: profileSpine({ aiSummary }) } });
      expect((await h.profile()).sections.snapshot.dailyBriefing.summary).toBe(
        'No new intelligence changes detected this week.',
      );
    },
  );
  it('uses singular nouns for one deadline, tracked bill and intelligence change', async () => {
    const h = harness({
      sourceResults: {
        getCommentPeriodAlerts: { alerts: [deadline('one')] },
        getTrackedBills: tracked(1),
        getChanges: [event('one')],
      },
    });
    expect((await h.profile()).sections.snapshot.dailyBriefing.summary).toBe(
      '1 comment deadline due within 7 days. 1 bill currently tracked. 1 intelligence change detected this week.',
    );
  });
  it('uses plural nouns for multiple deadlines, tracked bills and changes', async () => {
    const h = harness({
      sourceResults: {
        getCommentPeriodAlerts: { alerts: [deadline('one'), deadline('two')] },
        getTrackedBills: tracked(2),
        getChanges: [event('one'), event('two')],
      },
    });
    expect((await h.profile()).sections.snapshot.dailyBriefing.summary).toBe(
      '2 comment deadlines due within 7 days. 2 bills currently tracked. 2 intelligence changes detected this week.',
    );
  });
});

describe('Profile daily briefing highlights and underlying signal counts', () => {
  it('emits the four highlights in canonical order with rounded TTM spending', async () => {
    const h = harness({
      sourceResults: {
        getCommentPeriodAlerts: { alerts: [deadline('one')] },
        getTrackedBills: tracked(3),
        getChanges: [event('one'), event('two')],
        getLobbyingRoi: { lobbySpend: 123.6, contractWins: 0, roi: null, gap: 0 },
      },
    });
    expect((await h.profile()).sections.snapshot.dailyBriefing.highlights).toEqual([
      { label: 'Deadlines', value: '1 due ≤7d', tone: 'critical' },
      { label: 'Bills tracked', value: 3, tone: 'notable' },
      { label: 'Lobbying TTM', value: 124, tone: 'info' },
      { label: 'New events (7d)', value: 2, tone: 'info' },
    ]);
  });
  it('uses the neutral monitoring highlight when every signal is empty', async () => {
    const h = harness();
    expect((await h.profile()).sections.snapshot.dailyBriefing.highlights).toEqual([
      { label: 'Status', value: 'Monitoring for new intelligence signals', tone: 'neutral' },
    ]);
  });
  it('counts only this client’s deadlines at or within seven days, independent of severity', async () => {
    const alerts = [
      deadline('at-seven', 7),
      deadline('overdue', -1),
      deadline('after-seven', 8),
      deadline('unknown', 0, { daysToDeadline: null }),
      deadline('other-client', 0, { clientId: 'other-client' }),
    ];
    const h = harness({ sourceResults: { getCommentPeriodAlerts: { alerts } } });
    expect((await h.profile()).sections.snapshot.dailyBriefing.highlights).toEqual([
      { label: 'Deadlines', value: '2 due ≤7d', tone: 'critical' },
    ]);
  });
  it('keeps briefing signal counts when per-user dismissal hides all corresponding alerts', async () => {
    const h = harness({
      rows: {
        alertStates: [
          { alertId: 'comment:one', state: 'dismissed', snoozedUntil: null },
          { alertId: 'change:one', state: 'dismissed', snoozedUntil: null },
        ],
      },
      sourceResults: {
        getCommentPeriodAlerts: { alerts: [deadline('one')] },
        getChanges: [event('one')],
      },
    });
    const snapshot = (await h.profile(userId)).sections.snapshot;
    expect(snapshot.topAlerts).toEqual([]);
    expect(snapshot.changes7dCount).toBe(1);
    expect(snapshot.dailyBriefing).toMatchObject({
      eventCount: 1,
      summary: '1 comment deadline due within 7 days. 1 intelligence change detected this week.',
      highlights: [
        { label: 'Deadlines', value: '1 due ≤7d', tone: 'critical' },
        { label: 'New events (7d)', value: 1, tone: 'info' },
      ],
    });
  });
  it('does not invent a lobbying highlight for zero or negative spend', async () => {
    const h = harness({
      sourceResults: { getLobbyingRoi: { lobbySpend: -10, contractWins: 0, roi: null, gap: 0 } },
    });
    expect((await h.profile()).sections.snapshot.dailyBriefing.highlights).toEqual([
      { label: 'Status', value: 'Monitoring for new intelligence signals', tone: 'neutral' },
    ]);
  });
});

describe('Profile snapshot activity clock and nullable timestamps', () => {
  it('returns fourteen ordered UTC-day buckets including today and thirteen days back', async () => {
    const activity = (await harness().profile()).sections.snapshot.activity14d;
    expect(activity).toHaveLength(14);
    expect(activity[0]!.date).toBe('2026-09-30');
    expect(activity[13]!.date).toBe('2026-10-13');
    expect(
      activity.every(
        (row: Record<string, unknown>) =>
          row.meetings === 0 &&
          row.emails === 0 &&
          row.tasks === 0 &&
          row.debriefs === 0 &&
          row.outreach === 0,
      ),
    ).toBe(true);
  });
  it('groups each activity kind by UTC date, skips nullable timestamps and ignores dates outside the buckets', async () => {
    const first = new Date('2026-09-30T00:01:00Z');
    const today = new Date('2026-10-13T00:01:00Z');
    const h = harness({
      rows: {
        meetings: [
          { startsAt: first },
          { startsAt: first },
          { startsAt: today },
          { startsAt: new Date(now.getTime() - 14 * day) },
          { startsAt: new Date(now.getTime() + day) },
        ],
        mailThreads: [{ lastMessageAt: null }, { lastMessageAt: today }],
        doneTasks: [{ updatedAt: today }, { updatedAt: today }],
        debriefs: [{ createdAt: today }],
        outreachRecords: [{ sentAt: null }, { sentAt: today }],
      },
    });
    const activity = (await h.profile()).sections.snapshot.activity14d;
    expect(activity[0]).toEqual({
      date: '2026-09-30',
      meetings: 2,
      emails: 0,
      tasks: 0,
      debriefs: 0,
      outreach: 0,
    });
    expect(activity[13]).toEqual({
      date: '2026-10-13',
      meetings: 1,
      emails: 1,
      tasks: 2,
      debriefs: 1,
      outreach: 1,
    });
    expect(activity.reduce((sum: number, row: { meetings: number }) => sum + row.meetings, 0)).toBe(
      3,
    );
  });
});

describe('Profile activity query scope and aggregate clock', () => {
  it('uses the original lookback date and exact tenant model fields/status for all five activity reads', async () => {
    const h = harness();
    await h.profile();
    const cutoff = new Date(now.getTime() - 14 * day);
    expect(h.tenantTx.meeting.findMany).toHaveBeenCalledWith({
      where: { clientId, startsAt: { gte: cutoff } },
      select: { startsAt: true },
      orderBy: { startsAt: 'asc' },
    });
    expect(h.tenantTx.mailThread.findMany).toHaveBeenCalledWith({
      where: { clientId, lastMessageAt: { gte: cutoff } },
      select: { lastMessageAt: true },
      orderBy: { lastMessageAt: 'asc' },
    });
    expect(h.tenantTx.engagementTask.findMany).toHaveBeenCalledWith({
      where: { clientId, status: 'done', updatedAt: { gte: cutoff } },
      select: { updatedAt: true },
      orderBy: { updatedAt: 'asc' },
    });
    expect(h.tenantTx.meetingDebrief.findMany).toHaveBeenCalledWith({
      where: { clientId, createdAt: { gte: cutoff } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(h.tenantTx.outreachRecord.findMany).toHaveBeenCalledWith({
      where: { clientId, sentAt: { gte: cutoff } },
      select: { sentAt: true },
      orderBy: { sentAt: 'asc' },
    });
    expect(
      ['meetings', 'mailThreads', 'doneTasks', 'debriefs', 'outreachRecords'].every(
        (operation) => h.callsOf(operation)[0]!.tenantId === tenantId,
      ),
    ).toBe(true);
  });
  it('keeps one aggregate clock even if a resolved source advances the ambient clock', async () => {
    const h = harness({
      sourceResults: {
        getChanges: () => {
          jest.setSystemTime(new Date(now.getTime() + day));
          return [];
        },
      },
    });
    const output = await h.profile();
    expect(output.generatedAt).toBe(now.toISOString());
    expect(output.meta.generatedAt).toBe(now.toISOString());
    expect(output.sections.snapshot.dailyBriefing.generatedAt).toBe(now.toISOString());
    expect(output.sections.snapshot.activity14d[13]!.date).toBe('2026-10-13');
  });
});

describe('Profile mapping-derived snapshot metadata', () => {
  it('counts distinct confirmed sources and every unresolved mapping row, including null external IDs', async () => {
    const mappings = [
      { source: 'lda', confirmed: true, externalId: '1' },
      { source: 'lda', confirmed: true, externalId: '2' },
      { source: 'fec_employer', confirmed: true, externalId: null },
      { source: 'fara', confirmed: false, externalId: 'pending-one' },
      { source: 'fara', confirmed: false, externalId: null },
    ];
    const h = harness({ rows: { mappings } });
    const output = await h.profile();
    expect(output.meta).toMatchObject({
      schema: 'client-profile-v1',
      sourceCount: 2,
      unresolvedMappings: 2,
      generatedAt: now.toISOString(),
      sectionOrder: ['snapshot', 'financialFootprint', 'legislativeRegulatory', 'relationships'],
    });
    expect(h.tenantTx.clientIntelMapping.findMany).toHaveBeenCalledWith({
      where: { clientId },
      select: { source: true, confirmed: true, externalId: true },
    });
    expect(h.callsOf('mappings')[0]).toMatchObject({ scope: 'tenant', tenantId });
  });
  it('reports zero confirmed sources for an empty mapping ledger rather than fan-out source count', async () => {
    expect((await harness().profile()).meta).toMatchObject({
      sourceCount: 0,
      unresolvedMappings: 0,
    });
  });
});
