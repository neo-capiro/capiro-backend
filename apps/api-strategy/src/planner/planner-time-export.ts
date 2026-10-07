import { plannerCalendarDate } from '@capiro/strategy-verifier';
import { fail, keys, uuid } from './planner.validation.js';

export type PlannerTimeExportQuery = {
  scope?: string;
  fromOn?: string;
  throughOn?: string;
  userId?: string;
  projectId?: string;
  cursor?: string;
  revision?: string;
};
export function plannerTimeExportQuery(query: PlannerTimeExportQuery) {
  keys(query, ['scope', 'fromOn', 'throughOn', 'userId', 'projectId', 'cursor', 'revision']);
  if (Object.values(query).some((value) => typeof value !== 'string'))
    fail('Invalid time export query');
  if (!['personal', 'review', 'project', 'organization'].includes(query.scope ?? ''))
    fail('Choose a time export scope');
  if (
    !plannerCalendarDate(query.fromOn) ||
    !plannerCalendarDate(query.throughOn) ||
    query.fromOn! > query.throughOn!
  )
    fail('Choose a valid date range with its start before its end');
  if (query.scope === 'project') uuid(query.projectId);
  else if (query.projectId !== undefined) fail('A project requires a project export');
  if (
    query.userId !== undefined &&
    (query.scope !== 'personal' ||
      typeof query.userId !== 'string' ||
      !query.userId ||
      query.userId.length > 200)
  )
    fail('Choose a valid time submitter');
  if (query.revision !== undefined && !/^[a-f0-9]{64}$/.test(query.revision))
    fail('Invalid export revision');
  if (query.cursor !== undefined) {
    uuid(query.cursor);
    if (!query.revision) fail('Time export paging requires its data revision');
  }
  return {
    ...query,
    scope: query.scope as 'personal' | 'review' | 'project' | 'organization',
    fromOn: query.fromOn!,
    throughOn: query.throughOn!,
  };
}
