import { PLANNER_DEFAULT_TIME_OPTIONS } from '@capiro/strategy-verifier';
import { plannerTimeOptions } from './planner-time-policy.js';
import {
  plannerTimeReviewView,
  plannerTimeReviewRows,
  plannerTimeSubmissionDue,
} from './planner-time-review.js';
import type { PlannerTimesheet } from '@capiro/strategy-verifier';

describe('Time review filters and calendar submission reminders', () => {
  it('validates distinct private filters and orders visible totals with deterministic ties', () => {
    const view = plannerTimeReviewView({
      people: ['b', 'a'],
      statuses: ['draft'],
      sort: 'total',
      direction: 'desc',
    });
    const rows = [
      { userId: 'c', status: 'draft', totalMinutes: 900 },
      { userId: 'b', status: 'draft', totalMinutes: 60 },
      { userId: 'a', status: 'draft', totalMinutes: 60 },
      { userId: 'd', status: 'approved', totalMinutes: 1000 },
    ] as PlannerTimesheet[];
    expect(plannerTimeReviewRows(rows, view, new Map()).map((r) => r.userId)).toEqual(['a', 'b']);
    expect(rows[0]!.userId).toBe('c');
    expect(() => plannerTimeReviewView({ people: ['a', 'a'] })).toThrow();
    expect(() => plannerTimeReviewView({ statuses: ['hidden'] })).toThrow();
    expect(() => plannerTimeReviewView({ ownerId: 'another-person' })).toThrow();
  });
  it('keeps reminders off by default and validates their exact calendar settings', () => {
    expect(plannerTimeSubmissionDue(PLANNER_DEFAULT_TIME_OPTIONS)).toBeNull();
    for (const reminder of [
      { weekday: 0, time: '09:00', week: 'current' },
      { weekday: 8, time: '09:00', week: 'current' },
      { weekday: 1, time: '24:00', week: 'current' },
      { weekday: 1, time: '09:00', week: 'all' },
      { weekday: 1, time: '09:00', week: 'current', userId: 'someone' },
    ])
      expect(() => plannerTimeOptions({ submissionReminder: reminder })).toThrow();
  });
  it('uses the organization week across UTC Monday and delivers once its local deadline is due', () => {
    const options = plannerTimeOptions({
      timeZone: 'America/New_York',
      submissionReminder: { weekday: 7, time: '17:00', week: 'current' },
    });
    expect(plannerTimeSubmissionDue(options, new Date('2026-11-02T00:00:00Z'))).toEqual({
      weekOn: '2026-10-26',
      scheduledOn: '2026-11-01',
      deadlineAt: '2026-11-01T22:00:00.000Z',
    });
    expect(plannerTimeSubmissionDue(options, new Date('2026-11-01T21:59:59Z'))).toBeNull();
    expect(plannerTimeSubmissionDue(options, new Date('2026-11-02T05:00:00Z'))).toBeNull();
    expect(
      plannerTimeSubmissionDue(
        { ...options, timeTrackingEnabled: false },
        new Date('2026-11-02T00:00:00Z'),
      ),
    ).toBeNull();
  });
  it('targets the previous sheet and observes daylight saving in its scheduled instant', () => {
    const options = plannerTimeOptions({
      timeZone: 'America/New_York',
      submissionReminder: { weekday: 1, time: '09:00', week: 'previous' },
    });
    expect(plannerTimeSubmissionDue(options, new Date('2026-03-09T13:00:00Z'))).toEqual({
      weekOn: '2026-03-02',
      scheduledOn: '2026-03-09',
      deadlineAt: '2026-03-09T13:00:00.000Z',
    });
  });
});
