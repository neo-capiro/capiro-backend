import {
  activityCommandHash,
  activityCommandInput,
  plannerPayload,
  resumeVersion,
} from './activity-command.input.js';
const id = '20000000-0000-4000-8000-000000000001';
const input = { requestId: id, activity: { kind: 'note', title: 'A note' } };
describe('bounded activity command input and date semantics', () => {
  it.each([{ tenantId: id }, { sourceId: id }, { metadata: {} }, { objectiveId: id }])(
    'rejects caller-owned lineage %j',
    (extra) => {
      expect(() => activityCommandInput({ ...input, ...extra })).toThrow();
    },
  );
  it.each([
    { title: '' },
    { title: ' '.repeat(4) },
    { title: 'x'.repeat(301) },
    { body: 'x'.repeat(5001) },
    { kind: 'meeting' },
    { personId: 'user_clerk' },
    { sourceType: 'email' },
    { owedBy: 'client' },
    { metadata: { chain: {} } },
    { occurredAt: '2026-10-11' },
    { occurredAt: '2026-10-11T12:00:00' },
    { occurredAt: '2026-02-30T12:00:00Z' },
    { dueAt: '2026-10-11T12:00:00Z' },
  ])('rejects invalid or unsupported activity %j', (extra) => {
    expect(() =>
      activityCommandInput({ ...input, activity: { ...input.activity, ...extra } }),
    ).toThrow();
  });
  it.each([
    { dueOn: '2026-02-30', timeZone: 'UTC' },
    { dueOn: '2026-10-11' },
    { dueTime: '12:00' },
    { timeZone: 'UTC' },
    { dueOn: '2026-10-11', dueTime: '24:00', timeZone: 'UTC' },
    { dueOn: '2026-10-11', timeZone: 'Not/AZone' },
    { dueOn: '2026-10-11', timeZone: '+01:00' },
    { clientId: id },
    { title: 'Private client text' },
    { assigneeUserId: 'user_clerk' },
  ])('rejects unsupported Planner input %j', (extra) => {
    expect(() =>
      activityCommandInput({ ...input, followUp: { assigneeUserId: id, ...extra } }),
    ).toThrow();
  });
  it('preserves explicit activity instants and date-only Planner data across a DST transition', () => {
    const parsed = activityCommandInput({
      ...input,
      activity: {
        kind: 'commitment',
        title: '  Promise  ',
        occurredAt: '2026-10-11T12:00:00-04:00',
        dueAt: '2026-11-01T01:30:00-04:00',
      },
      followUp: {
        assigneeUserId: id,
        dueOn: '2026-11-01',
        dueTime: '01:30',
        timeZone: 'America/New_York',
      },
    });
    expect(parsed.activity.dueAt).toBe('2026-11-01T01:30:00-04:00');
    expect(plannerPayload(parsed.followUp!, 'user_assignee')).toEqual({
      name: 'Follow up on logged activity',
      description: '',
      assigneeId: 'user_assignee',
      dueOn: '2026-11-01',
      dueTime: '01:30',
      timeZone: 'America/New_York',
      clientId: null,
      meetingId: null,
      parentId: null,
      memberships: [],
      collaborators: [],
    });
  });
  it('canonicalizes omitted defaults, whitespace and input field order before hashing', () => {
    expect(activityCommandHash(activityCommandInput(input))).toBe(
      activityCommandHash(
        activityCommandInput({
          activity: { personId: null, dueAt: null, body: null, title: ' A note ', kind: 'note' },
          requestId: id,
        }),
      ),
    );
  });
  it.each([-1, 1.5, '1', 2147483647, undefined])(
    'rejects invalid resume version %s',
    (expectedVersion) => {
      expect(() => resumeVersion({ expectedVersion })).toThrow();
    },
  );
});
