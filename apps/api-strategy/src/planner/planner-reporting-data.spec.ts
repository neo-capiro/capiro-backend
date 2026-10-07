import {
  PLANNER_DEFAULT_TASK,
  PLANNER_DEFAULT_PROJECT,
  type PlannerProject,
} from '@capiro/strategy-verifier';
import { plannerReportRecords, type PlannerReportTaskRecord } from './planner-reporting-data.js';
const project = (id: string, fields: PlannerProject['fields'] = []): PlannerProject => ({
  ...PLANNER_DEFAULT_PROJECT,
  id,
  name: id,
  fields,
  ownerId: 'owner',
  version: 1,
  archived: false,
  access: 'viewer',
  createdAt: '2044-01-02T01:00:00Z',
  updatedAt: '2044-01-02T01:00:00Z',
});
const task = (projectIds: string[]): PlannerReportTaskRecord => ({
  id: 'task',
  ownerId: 'owner',
  assigneeId: null,
  projectIds,
  parentId: null,
  archived: false,
  createdAt: new Date('2044-01-02T01:00:00Z'),
  completedAt: new Date('2044-01-03T01:00:00Z'),
  data: {
    ...PLANNER_DEFAULT_TASK,
    name: 'Readable task',
    status: 'done',
    estimateMinutes: 45,
    memberships: projectIds.map((projectId) => ({ projectId, sectionId: null, position: 0 })),
    customValues: { declared: 10, unrelated: 999, hidden: 'Private value' },
  },
});
describe('Planner reporting authorized metadata preparation', () => {
  it('requires a readable declaring project on each task before including custom values', () => {
    const records = plannerReportRecords({
      tasks: [task(['first', 'private-project'])],
      projects: [
        project('first', [{ id: 'declared', name: 'Cost', type: 'number', options: [] }]),
        project('second', [
          { id: 'unrelated', name: 'Other namespace', type: 'number', options: [] },
        ]),
      ],
      resources: [],
      people: [],
      minutes: new Map(),
      timeZone: 'UTC',
    });
    expect(records[0]!.custom).toEqual({ declared: 10 });
    expect(records[0]!.projectIds).toEqual(['first']);
    expect(JSON.stringify(records)).not.toContain('Private value');
  });
  it('uses local creation/completion dates and stable shared-task contributions for effort totals', () => {
    const records = plannerReportRecords({
      tasks: [task(['first', 'second'])],
      projects: [project('first'), project('second')],
      resources: [],
      people: [],
      minutes: new Map([['task', 30]]),
      timeZone: 'America/New_York',
    });
    expect(records[0]!.dates).toMatchObject({ created: '2044-01-01', completed: '2044-01-02' });
    for (const p of records.filter((r) => r.entity === 'projects')) {
      expect(p.metrics).toMatchObject({ actual_minutes: 30, estimated_minutes: 45, progress: 100 });
      expect(p.contributions?.actual_minutes).toEqual([{ id: 'task', value: 30 }]);
    }
  });
});
