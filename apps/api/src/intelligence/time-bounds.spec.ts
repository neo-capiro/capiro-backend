import {
  deadlineStatus,
  daysUntil,
  normalizeDeadline,
  proposeFeasibleSchedule,
  validateSchedule,
} from '@capiro/shared';
import { addDateInZone, dateBoundsInZone, dayBoundsInZone, ymdInZone } from './time-bounds';

describe('shared schedule helpers and API delegation', () => {
  it('uses real spring and fall DST day bounds', () => {
    expect(dayBoundsInZone(new Date('2026-03-08T16:00:00Z'), 'America/New_York')).toEqual({
      start: new Date('2026-03-08T05:00:00.000Z'), end: new Date('2026-03-09T03:59:59.999Z'),
    });
    expect(dayBoundsInZone(new Date('2026-11-01T16:00:00Z'), 'America/New_York')).toEqual({
      start: new Date('2026-11-01T04:00:00.000Z'), end: new Date('2026-11-02T04:59:59.999Z'),
    });
    expect(ymdInZone(new Date('2027-01-01T02:00:00Z'), 'America/New_York')).toBe('2026-12-31');
    expect(dateBoundsInZone(new Date('2026-03-08T16:00:00Z'), 'America/New_York').start).toEqual(new Date('2026-03-08T00:00:00Z'));
    expect(addDateInZone(new Date('2026-12-31T16:00:00Z'), 1, 'UTC')).toEqual(new Date('2027-01-01T00:00:00Z'));
  });

  it('normalizes date-only deadlines to federal ET end-of-day', () => {
    const deadline = normalizeDeadline({ value: '2026-07-15', kind: 'date', source: 'grants.gov' });
    expect(deadline).toEqual({ at: '2026-07-16T03:59:59.999Z', dateOnly: '2026-07-15', timeZone: 'America/New_York', basis: 'date_only_end_of_day' });
    expect(daysUntil('2026-07-14T12:00:00Z', deadline)).toBe(2);
    expect(deadlineStatus('2026-07-16T04:00:00Z', deadline)).toBe('closed');
    expect(normalizeDeadline({ value: 'continuous', kind: 'date', source: 'grants.gov' }).basis).toBe('unknown');
  });

  it('reports schedule conflicts and compresses offsets', () => {
    expect(validateSchedule({
      asOf: '2026-09-10T00:00:00Z',
      deadlines: [{ id: 'close', label: 'Close', date: '2026-09-12T00:00:00Z' }],
      milestones: [
        { id: 'draft', label: 'Draft', date: '2026-09-13T00:00:00Z' },
        { id: 'review', label: 'Review', date: '2026-09-09T00:00:00Z', dependsOn: ['draft'] },
      ],
    }).issues.map((issue) => issue.code)).toEqual(['milestone_after_deadline', 'milestone_before_as_of', 'order_conflict', 'insufficient_runway']);
    expect(proposeFeasibleSchedule({
      asOf: '2026-09-10T00:00:00Z', deadline: '2026-09-20T17:00:00Z',
      offsets: [{ id: 'bid', label: 'Bid', daysBefore: 21 }, { id: 'dry', label: 'Dry run', daysBefore: 5 }],
    })).toMatchObject({
      feasible: true,
      milestones: [{ date: '2026-09-12', daysBefore: 8 }, { date: '2026-09-19', daysBefore: 1 }],
    });
    expect(proposeFeasibleSchedule({ asOf: '2026-09-21T00:00:00Z', deadline: '2026-09-20T00:00:00Z', offsets: [] }).feasible).toBe(false);
  });
});