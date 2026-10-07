import type {
  PlannerEvent,
  PlannerGoalData,
  PlannerGoalSnapshot,
  PlannerGoalUpdateSection,
  PlannerResource,
} from '@capiro/strategy-verifier';
import { fail, keys, object, uuid } from './planner.validation.js';

export type PlannerGoalSourceRefs = { goals: string[]; projects: string[]; tasks: string[] };
export type PlannerGoalEventDetails = {
  goalSnapshot: PlannerGoalSnapshot;
  sourceRefs: PlannerGoalSourceRefs;
  goalUpdate?: { title: string; sections: PlannerGoalUpdateSection[] };
};

/** Capture only the work represented by the author's authorized rollup. A later
 * viewer must still hold every captured grant before seeing historical numbers. */
export function plannerGoalSnapshotDetails(
  goal: PlannerResource,
  views: PlannerResource[],
  activeProjects: Set<string>,
): PlannerGoalEventDetails {
  const data = goal.data as unknown as PlannerGoalData;
  const byId = new Map(views.map((g) => [g.id, g]));
  const refs = { goals: new Set<string>(), projects: new Set<string>(), tasks: new Set<string>() };
  const pending = [goal.id],
    seen = new Set<string>();
  for (let i = 0; i < pending.length; i++) {
    const id = pending[i]!;
    if (seen.has(id)) continue;
    seen.add(id);
    const current = byId.get(id);
    if (!current) continue;
    const config = current.data as unknown as PlannerGoalData;
    if (config.progress === 'task_completion')
      config.projectIds.filter((p) => activeProjects.has(p)).forEach((p) => refs.projects.add(p));
    else if (config.progress !== 'manual')
      for (const source of current.goalProgress?.sources ?? []) {
        if (source.kind === 'goal') {
          refs.goals.add(source.id);
          pending.push(source.id);
        } else refs[source.kind === 'project' ? 'projects' : 'tasks'].add(source.id);
      }
  }
  return {
    goalSnapshot: {
      status: data.status,
      measurement: data.progress,
      target: data.target,
      startValue: data.startValue ?? 0,
      direction: data.direction ?? 'increase',
      unit: data.unit,
      value: goal.goalProgress?.value ?? data.current,
      percentage: goal.goalProgress?.percentage ?? 0,
    },
    sourceRefs: {
      goals: [...refs.goals].sort(),
      projects: [...refs.projects].sort(),
      tasks: [...refs.tasks].sort(),
    },
  };
}

export function plannerGoalActivityView(
  event: PlannerEvent,
  raw: unknown,
  allowed: PlannerGoalSourceRefs,
): PlannerEvent {
  // Do not spread raw details: the stored source IDs are private authorization metadata.
  const details = raw as Partial<PlannerGoalEventDetails> | null;
  if (!event.resourceId || !details?.goalSnapshot || !details.sourceRefs) return event;
  const refs = details.sourceRefs;
  const readable = (['goals', 'projects', 'tasks'] as const).every(
    (kind) => Array.isArray(refs[kind]) && refs[kind].every((id) => allowed[kind].includes(id)),
  );
  const snapshot = details.goalSnapshot;
  return {
    ...event,
    goalSnapshot: {
      status: snapshot.status,
      measurement: snapshot.measurement,
      target: snapshot.target,
      startValue: snapshot.startValue,
      direction: snapshot.direction,
      unit: snapshot.unit,
      ...(readable ? { value: snapshot.value, percentage: snapshot.percentage } : {}),
    },
    ...(details.goalUpdate
      ? {
          goalUpdate: {
            title: details.goalUpdate.title,
            sections: details.goalUpdate.sections.map(({ id, title, text }) => ({
              id,
              title,
              text,
            })),
          },
        }
      : {}),
  };
}

export function validatePlannerGoalUpdate(raw: unknown) {
  const dto = object(raw);
  keys(dto, ['version', 'status', 'current', 'title', 'sections', 'reminder', 'timeZone']);
  if (typeof dto.title !== 'string' || !dto.title.trim() || dto.title.length > 500)
    fail('A goal update title is required');
  if (!Array.isArray(dto.sections) || !dto.sections.length || dto.sections.length > 20)
    fail('Choose 1-20 update sections');
  const sections = dto.sections.map((raw) => {
    const s = object(raw);
    keys(s, ['id', 'title', 'text']);
    uuid(s.id);
    if (
      typeof s.title !== 'string' ||
      !s.title.trim() ||
      s.title.length > 200 ||
      typeof s.text !== 'string' ||
      s.text.length > 20000
    )
      fail('Invalid goal update section');
    return { id: String(s.id), title: s.title, text: s.text };
  });
  if (new Set(sections.map((s) => s.id)).size !== sections.length) fail('Duplicate update section');
  const text = [dto.title, ...sections.map((s) => `## ${s.title}\n${s.text}`)].join('\n\n');
  if (text.length > 20000) fail('Goal update is too long');
  return {
    version: dto.version,
    status: dto.status,
    current: dto.current,
    reminder: dto.reminder,
    timeZone: dto.timeZone,
    title: dto.title,
    sections,
    text,
  };
}
