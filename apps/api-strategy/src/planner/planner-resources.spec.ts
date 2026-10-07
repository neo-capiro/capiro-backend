import { BadRequestException } from '@nestjs/common';
import { PLANNER_DEFAULT_TASK, type PlannerRuleData } from '@capiro/strategy-verifier';
import { validateResource, applyPlannerRule } from './planner-resources.js';
const P = '20000000-0000-4000-8000-000000000001';
const task = {
  ...PLANNER_DEFAULT_TASK,
  name: 'Task',
  memberships: [{ projectId: P, sectionId: null, position: 0 }],
};
const rule: PlannerRuleData = {
  enabled: true,
  trigger: 'status_changed',
  conditions: { status: 'in_progress' },
  actions: { priority: 'high', assigneeId: 'user_owner' },
};
describe('Planner rules and management validation', () => {
  it('rejects dangling or duplicated personal placements and sharing fields', () => {
    const personal = {
      sections: [{ id: P, name: 'Today' }],
      placements: [{ taskId: P, sectionId: P, position: 0 }],
    };
    expect(validateResource('my_tasks', personal)).toEqual(personal);
    expect(() => validateResource('my_tasks', { ...personal, privacy: 'team' })).toThrow(
      BadRequestException,
    );
    expect(() =>
      validateResource('my_tasks', {
        ...personal,
        placements: [...personal.placements, ...personal.placements],
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      validateResource('my_tasks', {
        ...personal,
        placements: [{ taskId: P, sectionId: 'missing', position: 0 }],
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      validateResource('my_tasks', {
        ...personal,
        placements: [{ taskId: P, sectionId: P, position: 1.5 }],
      }),
    ).toThrow(BadRequestException);
  });
  it('runs only when the trigger and all conditions match', () => {
    expect(applyPlannerRule(task, task, P, rule)).toEqual(task);
    expect(applyPlannerRule({ ...task, status: 'in_progress' }, task, P, rule)).toMatchObject({
      priority: 'high',
      assigneeId: 'user_owner',
    });
    expect(applyPlannerRule({ ...task, status: 'done' }, task, P, rule).priority).toBe('none');
  });
  it('does not act on an unrelated project or while paused', () => {
    expect(applyPlannerRule({ ...task, status: 'in_progress' }, task, 'other', rule).priority).toBe(
      'none',
    );
    expect(
      applyPlannerRule({ ...task, status: 'in_progress' }, task, P, { ...rule, enabled: false })
        .priority,
    ).toBe('none');
  });
  it('moves only the rule’s own project membership', () => {
    const data = {
      ...task,
      memberships: [...task.memberships, { projectId: 'other', sectionId: null, position: 1 }],
    };
    const next = applyPlannerRule(data, null, P, {
      ...rule,
      trigger: 'created',
      conditions: {},
      actions: { sectionId: P },
    });
    expect(next.memberships[1]).toEqual(data.memberships[1]);
    expect(next.memberships[0]!.sectionId).toBe(P);
  });
  it('rejects arbitrary rule actions and empty actions', () => {
    expect(() => validateResource('rule', { ...rule, actions: { clientId: P } })).toThrow(
      BadRequestException,
    );
    expect(() => validateResource('rule', { ...rule, actions: {} })).toThrow(BadRequestException);
  });
  it('requires a positive goal target and valid calendar date', () => {
    const goal = {
      description: '',
      privacy: 'private',
      members: [],
      projectIds: [],
      ownerId: null,
      dueOn: '2026-02-30',
      status: 'on_track',
      progress: 'manual',
      current: 0,
      target: 100,
      unit: '%',
    };
    expect(() => validateResource('goal', goal)).toThrow(BadRequestException);
    expect(() => validateResource('goal', { ...goal, dueOn: null, target: 0 })).toThrow(
      BadRequestException,
    );
  });
  it('does not allow a form to set unrelated live links or project grants', () => {
    expect(() =>
      validateResource('form', {
        description: '',
        enabled: true,
        fields: [
          { id: P, label: 'Name', type: 'text', required: true, options: [], taskField: 'name' },
        ],
        defaults: {
          assigneeId: null,
          status: 'todo',
          priority: 'none',
          estimateMinutes: 0,
          clientId: P,
        },
      }),
    ).toThrow(BadRequestException);
  });
  it('rejects form type mismatches, duplicate mappings and a missing name', () => {
    const form = {
      description: '',
      enabled: true,
      fields: [
        { id: P, label: 'Name', type: 'date', required: true, options: [], taskField: 'name' },
      ],
      defaults: { assigneeId: null, status: 'todo', priority: 'none', estimateMinutes: 0 },
    };
    expect(() => validateResource('form', form)).toThrow(BadRequestException);
    expect(() => validateResource('form', { ...form, fields: [] })).toThrow(BadRequestException);
  });
});
