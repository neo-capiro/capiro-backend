import type {
  ObjectiveOperationalActor,
  ObjectiveOperationalBinding,
  ObjectiveOperationalResource,
  ObjectiveOperationalSelection,
  ObjectiveOperationalSourceRead,
  ObjectiveOperationalStrategyType,
  ObjectiveOperationalTaskObservation,
  ObjectiveOperationalTx,
} from './objective-operational-resource.js';
import {
  plannerProjectAccessDecision,
  plannerTaskAccessDecision,
  type PlannerResourceProjectAccess,
  type PlannerResourceRole,
  type PlannerResourceTaskAccess,
} from './planner-resource-access.js';
import {
  plannerResourceCalendarDate,
  plannerResourceTaskOverdue,
  plannerResourceTime,
  plannerResourceTimeZone,
  type PlannerResourceSchedule,
} from './planner-resource-schedule.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES: readonly string[] = ['admin', 'editor', 'commenter', 'viewer'];
const STRATEGY_TYPES: readonly string[] = [
  'appropriations',
  'authorization',
  'regulatory',
  'coalition',
  'procurement',
  'earmark',
  'amendment',
];
interface PlannerRow {
  id: string;
  tenantId: string;
  ownerId: string;
  data: unknown;
  version: number;
  archived: boolean;
  createdAt: Date | string;
}
interface PlannerEnvelope extends PlannerRow {
  rowKind: 'selected_project' | 'task' | 'project';
}
interface Project extends PlannerResourceProjectAccess {
  id: string;
  tenantId: string;
  version: number;
  archived: boolean;
  data: PlannerResourceProjectAccess['data'] & { name: string; clientId: string | null };
}
interface Task extends PlannerResourceTaskAccess {
  id: string;
  tenantId: string;
  version: number;
  archived: boolean;
  createdAt: string;
  data: PlannerResourceTaskAccess['data'] &
    PlannerResourceSchedule & {
      name: string;
      clientId: string | null;
      status: string;
      subtype: string;
      approval: string;
    };
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function identity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
}
function id(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
function nullableId(value: unknown): value is string | null {
  return value === null || id(value);
}
function timestamp(value: unknown): string | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function choice(value: unknown, choices: readonly string[]): value is string {
  return typeof value === 'string' && choices.includes(value);
}
function plannerRow(row: PlannerRow, tenantId: string): boolean {
  return (
    id(row.id) &&
    row.tenantId === tenantId &&
    identity(row.ownerId) &&
    Number.isInteger(row.version) &&
    row.version > 0 &&
    row.version <= 2147483647 &&
    typeof row.archived === 'boolean'
  );
}
/** Decode only needed metadata and grants; never cast unknown stored JSON into an ACL. */
function project(row: PlannerRow, tenantId: string): Project | null {
  const data = record(row.data);
  if (!data || !plannerRow(row, tenantId)) return null;
  const name = data.name === undefined ? '' : data.name;
  const privacy = data.privacy === undefined ? 'private' : data.privacy;
  const clientId = data.clientId === undefined ? null : data.clientId;
  const members = data.members === undefined ? [] : data.members;
  if (
    typeof name !== 'string' ||
    !choice(privacy, ['private', 'team']) ||
    !nullableId(clientId) ||
    !Array.isArray(members)
  )
    return null;
  const grants: { userId: string; role: PlannerResourceRole }[] = [];
  for (const raw of members) {
    const member = record(raw);
    if (!member || !identity(member.userId) || !choice(member.role, ROLES)) return null;
    grants.push({ userId: member.userId, role: member.role as PlannerResourceRole });
  }
  return {
    ...row,
    data: {
      name,
      clientId: clientId === null ? null : clientId.toLowerCase(),
      privacy: privacy as 'private' | 'team',
      members: grants,
    },
  };
}
function task(row: PlannerRow, tenantId: string): Task | null {
  const data = record(row.data);
  const createdAt = timestamp(row.createdAt);
  if (!data || !plannerRow(row, tenantId) || !createdAt) return null;
  const name = data.name === undefined ? '' : data.name;
  const clientId = data.clientId === undefined ? null : data.clientId;
  const status = data.status === undefined ? 'todo' : data.status;
  const subtype = data.subtype === undefined ? 'task' : data.subtype;
  const approval = data.approval === undefined ? 'pending' : data.approval;
  const dueOn = data.dueOn === undefined ? null : data.dueOn;
  const dueTime = data.dueTime === undefined ? null : data.dueTime;
  const timeZone = data.timeZone === undefined ? null : data.timeZone;
  const assigneeId = data.assigneeId === undefined ? null : data.assigneeId;
  const collaborators = data.collaborators === undefined ? [] : data.collaborators;
  const memberships = data.memberships === undefined ? [] : data.memberships;
  if (
    typeof name !== 'string' ||
    !nullableId(clientId) ||
    !choice(status, ['todo', 'in_progress', 'blocked', 'done']) ||
    !choice(subtype, ['task', 'milestone', 'approval']) ||
    !choice(approval, ['pending', 'approved', 'rejected', 'changes_requested']) ||
    (dueOn !== null && !plannerResourceCalendarDate(dueOn)) ||
    (dueTime !== null && (!plannerResourceTime(dueTime) || !dueOn)) ||
    (timeZone !== null && !plannerResourceTimeZone(timeZone)) ||
    (dueTime !== null && !timeZone) ||
    (assigneeId !== null && !identity(assigneeId)) ||
    !Array.isArray(collaborators) ||
    !collaborators.every(identity) ||
    !Array.isArray(memberships)
  )
    return null;
  const links: { projectId: string }[] = [];
  for (const raw of memberships) {
    const membership = record(raw);
    if (!membership || !id(membership.projectId)) return null;
    links.push({ projectId: membership.projectId });
  }
  return {
    ...row,
    createdAt,
    data: {
      name,
      clientId: clientId === null ? null : clientId.toLowerCase(),
      status,
      subtype,
      approval,
      dueOn: dueOn as string | null,
      dueTime: dueTime as string | null,
      timeZone: timeZone as string | null,
      assigneeId: assigneeId as string | null,
      collaborators,
      memberships: links,
    },
  };
}
function resource(
  selection: ObjectiveOperationalSelection,
  title: string,
  version: number,
  observedAt: string,
): ObjectiveOperationalResource {
  return { selection, title, ownerVersion: { kind: 'counter', value: version }, observedAt };
}

/**
 * New writes call this BEFORE Core membership/client/Objective/state locks.
 * Planner writers already acquire this tenant gate before project/task edits.
 * Strategy writers lock the same exact parent row before edits/archive/restore.
 * Missing parent rows are resolved as unavailable by the later authority read.
 */
export async function lockObjectivePlanResource(
  tx: ObjectiveOperationalTx,
  actor: ObjectiveOperationalActor,
  selection: ObjectiveOperationalSelection,
): Promise<void> {
  if (!id(actor.tenantId) || !id(selection.id)) return;
  if (selection.kind === 'strategy') {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM sp_strategy
      WHERE tenant_id=${actor.tenantId}::uuid AND id=${selection.id}::uuid FOR SHARE
    `;
  } else if (selection.kind === 'planner_project' || selection.kind === 'planner_task') {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`planner:${actor.tenantId}`}, 0))`;
    if (selection.kind === 'planner_project') {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM sp_planner_projects
        WHERE tenant_id=${actor.tenantId}::uuid AND id=${selection.id}::uuid FOR SHARE
      `;
    } else {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM sp_planner_tasks
        WHERE tenant_id=${actor.tenantId}::uuid AND id=${selection.id}::uuid FOR SHARE
      `;
    }
  }
}

async function plannerSnapshot(
  tx: ObjectiveOperationalTx,
  actor: ObjectiveOperationalActor,
  binding: ObjectiveOperationalBinding,
  selection: ObjectiveOperationalSelection,
): Promise<PlannerEnvelope[]> {
  // One statement observes resource metadata, every eligible task and all exact
  // parent grants at the same MVCC snapshot. Ordinary reads take no row/advisory
  // locks: saveProject updates tasks before its project and must never wait on a
  // read that holds a project row while waiting on one of those tasks.
  // Canonical task grants include archived/cross-client referenced projects;
  // those rows are ACL inputs only and their metadata is never returned publicly.
  return tx.$queryRaw<PlannerEnvelope[]>`
    WITH requested AS (
      SELECT ${actor.tenantId}::uuid AS tenant_id,${binding.clientId}::text AS client_id,
        ${selection.id}::uuid AS resource_id,${selection.kind}::text AS kind
    ), selected_project AS (
      SELECT p.id,p.tenant_id,p.owner_id,p.data,p.version,p.archived,p.created_at
      FROM sp_planner_projects p JOIN requested s ON p.tenant_id=s.tenant_id AND p.id=s.resource_id
      WHERE s.kind='planner_project' AND p.archived=false AND lower(p.data->>'clientId')=s.client_id
    ), candidate_tasks AS (
      SELECT t.id,t.tenant_id,t.owner_id,t.data,t.version,t.archived,t.created_at
      FROM sp_planner_tasks t JOIN requested s ON t.tenant_id=s.tenant_id
      WHERE t.archived=false AND lower(t.data->>'clientId')=s.client_id AND (
        (s.kind='planner_task' AND t.id=s.resource_id) OR
        (s.kind='planner_project' AND EXISTS (SELECT 1 FROM selected_project) AND (
          s.resource_id=ANY(t.project_ids) OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE
              WHEN jsonb_typeof(t.data->'memberships')='array' THEN t.data->'memberships'
              ELSE '[]'::jsonb END) AS candidate_membership(value)
            WHERE lower(candidate_membership.value->>'projectId')=s.resource_id::text
          )
        ))
      )
    ), project_grants AS (
      SELECT p.id,p.tenant_id,p.owner_id,p.data,p.version,p.archived,p.created_at
      FROM sp_planner_projects p JOIN requested s ON p.tenant_id=s.tenant_id
      WHERE EXISTS (
        SELECT 1 FROM candidate_tasks t
        CROSS JOIN LATERAL jsonb_array_elements(CASE
          WHEN jsonb_typeof(t.data->'memberships')='array' THEN t.data->'memberships'
          ELSE '[]'::jsonb END) AS membership(value)
        WHERE membership.value->>'projectId'=p.id::text
      )
    )
    SELECT 'selected_project'::text AS "rowKind",p.id,p.tenant_id AS "tenantId",
      p.owner_id AS "ownerId",p.data,p.version,p.archived,p.created_at AS "createdAt"
    FROM selected_project p
    UNION ALL
    SELECT 'task'::text AS "rowKind",t.id,t.tenant_id AS "tenantId",
      t.owner_id AS "ownerId",t.data,t.version,t.archived,t.created_at AS "createdAt"
    FROM candidate_tasks t
    UNION ALL
    SELECT 'project'::text AS "rowKind",p.id,p.tenant_id AS "tenantId",
      p.owner_id AS "ownerId",p.data,p.version,p.archived,p.created_at AS "createdAt"
    FROM project_grants p
  `;
}
function taskObservation(
  row: Task,
  projects: Project[],
  actor: ObjectiveOperationalActor,
  binding: ObjectiveOperationalBinding,
  observedAt: string,
  asOf: Date,
): ObjectiveOperationalTaskObservation {
  const projectIds = [
    ...new Set(
      row.data.memberships.flatMap((membership) => {
        const p = projects.find((p) => p.id === membership.projectId);
        return p &&
          !p.archived &&
          p.data.clientId === binding.clientId &&
          plannerProjectAccessDecision(p, actor.clerkUserId)
          ? [p.id]
          : [];
      }),
    ),
  ].sort();
  return {
    resource: resource(
      { kind: 'planner_task', id: row.id },
      row.data.name,
      row.version,
      observedAt,
    ),
    createdAt: row.createdAt,
    status: row.data.status,
    subtype: row.data.subtype,
    approval: row.data.approval,
    overdue: plannerResourceTaskOverdue(row.data, asOf),
    projectIds,
  };
}

/**
 * Owner-local metadata only. Caller must establish current Core Objective authority;
 * the final write additionally holds lockObjectivePlanResource's gate in this tx.
 * Reads acquire no owner row/advisory locks after Core authority.
 * No current-user authorization, discovery scan, provider or generated receipt is stored.
 */
export async function readObjectivePlanResource(
  tx: ObjectiveOperationalTx,
  actor: ObjectiveOperationalActor,
  binding: ObjectiveOperationalBinding,
  selection: ObjectiveOperationalSelection,
  observedAt: string,
  asOf: string,
): Promise<ObjectiveOperationalSourceRead | null> {
  if (
    !id(actor.tenantId) ||
    !identity(actor.clerkUserId) ||
    !id(binding.clientId) ||
    !id(selection.id)
  )
    return null;
  const cutoff = new Date(asOf);
  if (!Number.isFinite(cutoff.getTime()) || !Number.isFinite(new Date(observedAt).getTime()))
    return null;
  if (selection.kind === 'strategy') {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        tenantId: string;
        clientId: string;
        title: string;
        type: string;
        updatedAt: Date | string;
      }>
    >`
      SELECT id,tenant_id AS "tenantId",client_id AS "clientId",title,type,updated_at AS "updatedAt"
      FROM sp_strategy WHERE tenant_id=${actor.tenantId}::uuid AND id=${selection.id}::uuid
        AND client_id=${binding.clientId}::uuid AND archived_at IS NULL
        AND EXISTS (
          SELECT 1 FROM tenants t WHERE t.id=sp_strategy.tenant_id
            AND jsonb_typeof(t.settings_jsonb)='object'
            AND jsonb_typeof(t.settings_jsonb->'clioFeatureFlags')='object'
            AND t.settings_jsonb->'clioFeatureFlags'->'strategyPlanner.enabled'='true'::jsonb
        )
    `;
    const row = rows[0];
    if (
      !row ||
      row.id !== selection.id ||
      row.tenantId !== actor.tenantId ||
      row.clientId !== binding.clientId ||
      typeof row.title !== 'string' ||
      !choice(row.type, STRATEGY_TYPES)
    )
      return null;
    const updatedAt = row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt);
    if (!Number.isFinite(updatedAt.getTime())) return null;
    return {
      resource: {
        selection,
        title: row.title,
        ownerVersion: { kind: 'timestamp', value: updatedAt.toISOString() },
        observedAt,
      },
      strategyType: row.type as ObjectiveOperationalStrategyType,
    };
  }
  if (selection.kind !== 'planner_project' && selection.kind !== 'planner_task') return null;
  const snapshot = await plannerSnapshot(tx, actor, binding, selection);
  let selectedProject: Project | null = null;
  if (selection.kind === 'planner_project') {
    const selected = snapshot.find((row) => row.rowKind === 'selected_project');
    selectedProject = selected ? project(selected, actor.tenantId) : null;
    if (
      !selectedProject ||
      selectedProject.id !== selection.id ||
      selectedProject.archived ||
      selectedProject.data.clientId !== binding.clientId ||
      !plannerProjectAccessDecision(selectedProject, actor.clerkUserId)
    )
      return null;
  }
  const tasks = new Map<string, Task>();
  let taskSourceUnavailable = false;
  for (const row of snapshot.filter((row) => row.rowKind === 'task')) {
    const parsed = task(row, actor.tenantId);
    // A malformed matching source cannot silently become an apparently complete count.
    if (!parsed) {
      if (!selectedProject) return null;
      taskSourceUnavailable = true;
      continue;
    }
    if (parsed.archived || parsed.data.clientId !== binding.clientId) continue;
    if (selection.kind === 'planner_task' && parsed.id !== selection.id) continue;
    if (
      selectedProject &&
      !parsed.data.memberships.some((m) => m.projectId === selectedProject!.id)
    ) {
      // DTOs accept uppercase UUID text, while the owner's canonical task ACL
      // compares raw membership strings. Discover those candidates without
      // granting a relation that the existing owner would not recognize.
      if (parsed.data.memberships.some((m) => m.projectId.toLowerCase() === selectedProject!.id))
        taskSourceUnavailable = true;
      continue;
    }
    tasks.set(parsed.id, parsed);
  }
  const referencedIds = new Set(
    [...tasks.values()].flatMap((row) =>
      row.data.memberships.map((membership) => membership.projectId),
    ),
  );
  const projects = snapshot
    .filter((row) => row.rowKind === 'project' && referencedIds.has(row.id))
    .map((row) => project(row, actor.tenantId))
    .filter((row): row is Project => row !== null);
  if (selectedProject && !projects.some((p) => p.id === selectedProject!.id))
    projects.push(selectedProject);
  const observations = [...tasks.values()]
    .filter((row) => {
      const readable = !!plannerTaskAccessDecision(row, projects, actor.clerkUserId);
      if (!readable) taskSourceUnavailable = true;
      return readable;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((row) => taskObservation(row, projects, actor, binding, observedAt, cutoff));
  if (selectedProject)
    return {
      resource: resource(selection, selectedProject.data.name, selectedProject.version, observedAt),
      tasks: observations,
      ...(taskSourceUnavailable ? { taskSourceUnavailable: true } : {}),
    };
  const selectedTask = observations.find((row) => row.resource.selection.id === selection.id);
  return selectedTask ? { resource: selectedTask.resource, tasks: [selectedTask] } : null;
}
