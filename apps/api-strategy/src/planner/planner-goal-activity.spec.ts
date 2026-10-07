import type {
  PlannerGoalReminder,
  PlannerResource,
  PlannerGoalData,
  PlannerEvent,
} from '@capiro/strategy-verifier';
import { plannerGoalReminderDue, plannerGoalNextReminder } from './planner-goals.js';
import {
  plannerGoalSnapshotDetails,
  plannerGoalActivityView,
  validatePlannerGoalUpdate,
} from './planner-goal-activity.js';
const reminder = (patch: Partial<PlannerGoalReminder> = {}): PlannerGoalReminder => ({
  cadence: 'weekly',
  anchorOn: '2026-01-31',
  time: '09:00',
  timeZone: 'America/New_York',
  ...patch,
});
describe('Planner goal reminder calendar semantics', () => {
  it('honors the first date and exact local time, coalesces missed intervals and chooses the next future date', () => {
    const r = reminder();
    expect(plannerGoalReminderDue(r, new Date('2026-01-31T13:59:59Z'))).toBeNull();
    expect(plannerGoalNextReminder(r, new Date('2026-01-20T12:00:00Z')).date).toBe('2026-01-31');
    expect(plannerGoalReminderDue(r, new Date('2026-01-31T14:00:00Z'))?.date).toBe('2026-01-31');
    expect(plannerGoalNextReminder(r, new Date('2026-01-31T14:00:00Z')).date).toBe('2026-02-07');
    expect(plannerGoalReminderDue(r, new Date('2026-03-15T12:00:00Z'))?.date).toBe('2026-03-14');
    expect(
      plannerGoalReminderDue(reminder({ cadence: 'biweekly' }), new Date('2026-03-15T12:00:00Z'))
        ?.date,
    ).toBe('2026-03-14');
  });
  it('clamps month ends without drifting and crosses leap years and quarter boundaries', () => {
    const r = reminder({ cadence: 'monthly' });
    expect(plannerGoalReminderDue(r, new Date('2026-02-28T14:00:00Z'))?.date).toBe('2026-02-28');
    expect(plannerGoalNextReminder(r, new Date('2026-02-28T14:00:00Z')).date).toBe('2026-03-31');
    expect(plannerGoalReminderDue(r, new Date('2028-02-29T14:00:00Z'))?.date).toBe('2028-02-29');
    const q = reminder({ cadence: 'quarterly', anchorOn: '2025-11-30' });
    expect(plannerGoalReminderDue(q, new Date('2026-02-28T14:00:00Z'))?.date).toBe('2026-02-28');
    expect(plannerGoalNextReminder(q, new Date('2026-02-28T14:00:00Z')).date).toBe('2026-05-30');
  });
  it('uses established DST gap/fold behavior at local reminder times', () => {
    const gap = reminder({ anchorOn: '2026-03-08', time: '02:30' });
    expect(plannerGoalReminderDue(gap, new Date('2026-03-08T06:59:59Z'))).toBeNull();
    expect(
      plannerGoalNextReminder(gap, new Date('2026-03-08T06:00:00Z')).instant.toISOString(),
    ).toBe('2026-03-08T07:30:00.000Z');
    const fold = reminder({ anchorOn: '2026-11-01', time: '01:30' });
    expect(
      plannerGoalNextReminder(fold, new Date('2026-11-01T04:00:00Z')).instant.toISOString(),
    ).toBe('2026-11-01T05:30:00.000Z');
  });
});
describe('Planner historical goal privacy', () => {
  it('captures transitive contributing grants and excludes unrelated links and raw source metadata from views', () => {
    const data = {
      progress: 'subgoal_percentage',
      status: 'on_track',
      current: 0,
      target: 100,
      unit: '%',
      projectIds: ['unrelated'],
    } as PlannerGoalData;
    const child = {
      id: 'child',
      data: { ...data, progress: 'task_list_completion' },
      goalProgress: { value: 100, percentage: 100, sources: [{ id: 'task', kind: 'task' }] },
    } as unknown as PlannerResource;
    const root = {
      id: 'root',
      data,
      goalProgress: { value: 100, percentage: 100, sources: [{ id: 'child', kind: 'goal' }] },
    } as unknown as PlannerResource;
    const details = plannerGoalSnapshotDetails(root, [root, child], new Set(['unrelated']));
    expect(details.sourceRefs).toEqual({ goals: ['child'], projects: [], tasks: ['task'] });
    const event = { resourceId: 'root', text: 'Author text' } as PlannerEvent;
    const visible = plannerGoalActivityView(event, details, {
      goals: ['child'],
      projects: [],
      tasks: ['task'],
    });
    expect(visible.goalSnapshot?.percentage).toBe(100);
    expect(JSON.stringify(visible)).not.toContain('sourceRefs');
    expect(JSON.stringify(visible)).not.toContain('child');
    const hidden = plannerGoalActivityView(event, details, {
      goals: ['child'],
      projects: [],
      tasks: [],
    });
    expect(hidden.goalSnapshot?.value).toBeUndefined();
    expect(hidden.goalSnapshot?.percentage).toBeUndefined();
    expect(hidden.text).toBe('Author text');
    expect(hidden.goalSnapshot?.target).toBe(100);
  });
  it('bounds structured authored posts and rejects arbitrary details or duplicate identities', () => {
    const section = {
      id: '30000000-0000-4000-8000-000000000001',
      title: 'Summary',
      text: '**Ready**',
    };
    expect(
      validatePlannerGoalUpdate({
        version: 2,
        title: 'Weekly update',
        status: 'on_track',
        sections: [section],
      }).text,
    ).toContain('## Summary');
    expect(() =>
      validatePlannerGoalUpdate({ title: 'Test', sections: [section, section] }),
    ).toThrow();
    expect(() =>
      validatePlannerGoalUpdate({ title: 'Test', sections: [section], goalSnapshot: {} }),
    ).toThrow();
    expect(() =>
      validatePlannerGoalUpdate({
        title: 'Test',
        sections: [{ ...section, text: 'a'.repeat(20000) }],
      }),
    ).toThrow();
  });
});
