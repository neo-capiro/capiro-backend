import type {
  ObjectiveOperationalActor,
  ObjectiveOperationalResource,
  ObjectiveOperationalSourceRead,
  ObjectiveOperationalTaskObservation,
} from '@capiro/shared';
import type { OperationalLinkRecord } from './objective-operational.store.js';
import { ObjectiveOperationalCursors } from './objective-operational.cursor.js';
import {
  canonicalJson,
  operationalDigest,
  operationalFailure,
} from './objective-operational.rules.js';
import type {
  OperationalAction,
  OperationalCycle,
  OperationalDecisionRow,
  OperationalMeetingRow,
  OperationalProjectRow,
  OperationalProvenance,
  OperationalReadRequest,
  OperationalReadResponse,
  OperationalResource,
  OperationalScope,
  OperationalSection,
  OperationalSectionName,
  OperationalStrategyRow,
} from './objective-operational.types.js';

export interface OperationalProjectionInput {
  actor: ObjectiveOperationalActor;
  scope: OperationalScope;
  setVersion: number;
  request: OperationalReadRequest;
  asOf: string;
  observedAt: string;
  observations: Array<{
    link: OperationalLinkRecord;
    source: ObjectiveOperationalSourceRead | null;
  }>;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function resourceOrder(
  left: { resource: ObjectiveOperationalResource },
  right: { resource: ObjectiveOperationalResource },
): number {
  return (
    compare(left.resource.title ?? '', right.resource.title ?? '') ||
    compare(left.resource.selection.id, right.resource.selection.id)
  );
}
function publicResource<Kind extends OperationalResource['selection']['kind']>(
  resource: ObjectiveOperationalResource,
  kind: Kind,
): OperationalResource<Kind> {
  return {
    selection: { kind, id: resource.selection.id.toLowerCase() },
    title: resource.title,
    ownerVersion: { ...resource.ownerVersion },
    observedAt: resource.observedAt,
  };
}
function provenance(link: OperationalLinkRecord): OperationalProvenance {
  return {
    kind: 'manual',
    associationId: link.id,
    linkedRevision: { id: link.linkedRevisionId, version: link.linkedObjectiveVersion },
    linkedAt: link.linkedAt.toISOString(),
    via: { kind: link.resourceKind, id: link.resourceId },
  };
}
function mergeProvenance(target: OperationalProvenance[], incoming: OperationalProvenance): void {
  if (!target.some((entry) => canonicalJson(entry) === canonicalJson(incoming)))
    target.push(incoming);
  target.sort((left, right) => compare(canonicalJson(left), canonicalJson(right)));
}
function mergeCycles(target: OperationalCycle[], incoming: OperationalCycle[]): void {
  const identities = new Set(target.map((entry) => canonicalJson(entry)));
  for (const entry of incoming) {
    const identity = canonicalJson(entry);
    if (!identities.has(identity)) {
      target.push({ ...entry, context: entry.context === null ? null : { ...entry.context } });
      identities.add(identity);
    }
  }
  target.sort((left, right) => compare(canonicalJson(left), canonicalJson(right)));
}

/** Observation times change on every fresh owner read; owner content and authority do not. */
function stableResource(resource: ObjectiveOperationalResource) {
  return {
    selection: resource.selection,
    title: resource.title,
    ownerVersion: resource.ownerVersion,
  };
}
function stableTask(task: ObjectiveOperationalTaskObservation) {
  return {
    resource: stableResource(task.resource),
    status: task.status,
    subtype: task.subtype,
    approval: task.approval,
    overdue: task.overdue,
    createdAt: task.createdAt,
  };
}
function ownerWitness(input: OperationalProjectionInput): string {
  const witnesses = input.observations
    .filter(({ link }) => link.removedAt === null)
    .map(({ link, source }) => ({
      link: {
        id: link.id,
        kind: link.resourceKind,
        resourceId: link.resourceId,
        linkedRevisionId: link.linkedRevisionId,
        linkedObjectiveVersion: link.linkedObjectiveVersion,
        linkedAt: link.linkedAt.toISOString(),
        cycles: link.cycles.map((entry) => canonicalJson(entry)).sort(),
      },
      source:
        source === null
          ? null
          : {
              resource: stableResource(source.resource),
              strategyType: source.strategyType ?? null,
              tasks:
                source.tasks === undefined
                  ? null
                  : source.tasks
                      .map((task) => ({
                        ...stableTask(task),
                        projectIds: [...new Set(task.projectIds)].sort(),
                      }))
                      .sort((left, right) => compare(canonicalJson(left), canonicalJson(right))),
              taskSourceUnavailable: source.taskSourceUnavailable === true,
              pendingProposals: (source.pendingProposals ?? [])
                .map((proposal) => ({ ...proposal }))
                .sort((left, right) => compare(canonicalJson(left), canonicalJson(right))),
              decisionSourceUnavailable: source.decisionSourceUnavailable === true,
              startsAt: source.startsAt ?? null,
              endsAt: source.endsAt ?? null,
            },
    }))
    .sort((left, right) => compare(canonicalJson(left), canonicalJson(right)));
  return operationalDigest(witnesses);
}

function withoutObservationTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry: unknown) => withoutObservationTimes(entry));
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== 'observedAt') result[key] = withoutObservationTimes(entry);
  }
  return result;
}
function snapshotId(section: OperationalSectionName, rows: unknown[], witness: string): string {
  const digest = operationalDigest({ section, rows: withoutObservationTimes(rows), witness });
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function page<Row>(
  input: OperationalProjectionInput,
  cursors: ObjectiveOperationalCursors,
  section: OperationalSectionName,
  rows: Row[],
  incomplete: boolean,
  witness: string,
): OperationalSection<Row> {
  const token = input.request.cursors[section];
  if (incomplete && rows.length === 0) {
    if (token !== null) operationalFailure('CURSOR_STALE');
    return {
      observedAt: input.observedAt,
      coverage: 'unavailable',
      snapshotId: null,
      reasons: ['source_unverifiable'],
      total: null,
      nextCursor: null,
      items: [],
    };
  }
  const snapshot = snapshotId(section, rows, witness);
  const offset =
    token === null
      ? 0
      : cursors.check(
          token,
          input.actor.tenantId,
          input.actor.userId,
          input.scope,
          input.setVersion,
          section,
          snapshot,
          input.asOf,
          input.request.limit,
        );
  if (offset !== 0 && offset >= rows.length) operationalFailure('CURSOR_STALE');
  const items = rows.slice(offset, offset + input.request.limit);
  const nextOffset = offset + items.length;
  const nextCursor =
    nextOffset < rows.length
      ? cursors.encode(
          input.actor.tenantId,
          input.actor.userId,
          input.scope,
          input.setVersion,
          section,
          snapshot,
          input.asOf,
          input.request.limit,
          nextOffset,
        )
      : null;
  if (incomplete)
    return {
      observedAt: input.observedAt,
      coverage: 'partial',
      snapshotId: snapshot,
      reasons: ['source_unverifiable'],
      total: null,
      nextCursor,
      items,
    };
  return {
    observedAt: input.observedAt,
    coverage: 'complete',
    snapshotId: snapshot,
    reasons: [],
    total: rows.length,
    nextCursor,
    items,
  };
}

interface TaskEntry {
  task: ObjectiveOperationalTaskObservation;
  provenance: OperationalProvenance[];
  conflict: boolean;
}

/** Pure receiving projection. Every input source has already passed its current owner gate. */
export function assembleOperationalProjection(
  input: OperationalProjectionInput,
  cursors: ObjectiveOperationalCursors,
): OperationalReadResponse {
  if (
    input.request.clientId !== input.scope.clientId ||
    input.request.objectiveId !== input.scope.objectiveId
  ) {
    operationalFailure('MALFORMED_REQUEST');
  }
  const cutoff = Date.parse(input.asOf);
  if (
    !Number.isFinite(cutoff) ||
    !Number.isInteger(input.request.limit) ||
    input.request.limit < 1 ||
    input.request.limit > 100
  )
    operationalFailure('MALFORMED_REQUEST');
  const strategies = new Map<string, OperationalStrategyRow>();
  const projects = new Map<string, OperationalProjectRow>();
  const meetings = new Map<string, OperationalMeetingRow>();
  const tasks = new Map<string, TaskEntry>();
  let strategyIncomplete = false;
  let plannerIncomplete = false;
  let decisionIncomplete = false;
  let meetingIncomplete = false;

  for (const { link, source } of input.observations) {
    if (link.removedAt !== null) continue;
    const matches =
      source !== null &&
      source.resource.selection.kind === link.resourceKind &&
      source.resource.selection.id.toLowerCase() === link.resourceId.toLowerCase();
    if (!matches || source === null) {
      if (link.resourceKind === 'strategy') strategyIncomplete = true;
      if (link.resourceKind === 'planner_project' || link.resourceKind === 'planner_task')
        plannerIncomplete = decisionIncomplete = true;
      if (link.resourceKind === 'outreach_session') decisionIncomplete = true;
      if (link.resourceKind === 'meeting') meetingIncomplete = true;
      continue;
    }
    const via = provenance(link);
    const id = source.resource.selection.id.toLowerCase();
    if (link.resourceKind === 'strategy') {
      if (source.strategyType === undefined) {
        strategyIncomplete = true;
        continue;
      }
      let row = strategies.get(id);
      if (!row) {
        row = {
          resource: publicResource(source.resource, 'strategy'),
          provenance: [],
          cycles: [],
          savedVersions: [],
          strategyType: source.strategyType,
        };
        strategies.set(id, row);
      }
      mergeProvenance(row.provenance, via);
      mergeCycles(row.cycles, link.cycles);
    } else if (link.resourceKind === 'planner_project' || link.resourceKind === 'planner_task') {
      if (link.resourceKind === 'planner_project') {
        let row = projects.get(id);
        if (!row) {
          row = { resource: publicResource(source.resource, 'planner_project'), provenance: [] };
          projects.set(id, row);
        }
        mergeProvenance(row.provenance, via);
      }
      if (source.taskSourceUnavailable === true || source.tasks === undefined) {
        plannerIncomplete = decisionIncomplete = true;
      }
      for (const task of source.tasks ?? []) {
        const taskId = task.resource.selection.id.toLowerCase();
        const inherited =
          link.resourceKind === 'planner_project' &&
          task.projectIds.some(
            (projectId) => projectId.toLowerCase() === link.resourceId.toLowerCase(),
          );
        const direct =
          link.resourceKind === 'planner_task' && taskId === link.resourceId.toLowerCase();
        if (
          task.resource.selection.kind !== 'planner_task' ||
          (!inherited && !direct) ||
          !Number.isFinite(Date.parse(task.createdAt))
        ) {
          plannerIncomplete = decisionIncomplete = true;
          continue;
        }
        let entry = tasks.get(taskId);
        if (!entry) {
          entry = { task, provenance: [], conflict: false };
          tasks.set(taskId, entry);
        } else if (canonicalJson(stableTask(entry.task)) !== canonicalJson(stableTask(task))) {
          entry.conflict = true;
          plannerIncomplete = decisionIncomplete = true;
        }
        mergeProvenance(entry.provenance, via);
      }
    } else if (link.resourceKind === 'outreach_session') {
      // This owner's current port has neither a canonical pending title nor owner
      // creation time. A pending record cannot become an invented ordered decision.
      if (
        source.decisionSourceUnavailable === true ||
        source.pendingProposals === undefined ||
        source.pendingProposals.length > 0
      )
        decisionIncomplete = true;
    } else if (link.resourceKind === 'meeting') {
      if (
        source.startsAt === undefined ||
        !Number.isFinite(Date.parse(source.startsAt)) ||
        (source.endsAt !== undefined &&
          source.endsAt !== null &&
          !Number.isFinite(Date.parse(source.endsAt)))
      ) {
        meetingIncomplete = true;
        continue;
      }
      if (Date.parse(source.startsAt) < cutoff) continue;
      let row = meetings.get(id);
      if (!row) {
        row = {
          resource: publicResource(source.resource, 'meeting'),
          provenance: [],
          startsAt: source.startsAt,
          endsAt: source.endsAt ?? null,
        };
        meetings.set(id, row);
      }
      mergeProvenance(row.provenance, via);
    }
  }

  const decisionRows: Array<{ createdAt: string; row: OperationalDecisionRow }> = [];
  for (const entry of tasks.values()) {
    if (
      !entry.conflict &&
      entry.task.subtype === 'approval' &&
      entry.task.approval === 'pending' &&
      entry.task.status !== 'done'
    ) {
      decisionRows.push({
        createdAt: entry.task.createdAt,
        row: {
          kind: 'planner_approval',
          task: publicResource(entry.task.resource, 'planner_task'),
          approval: 'pending',
          provenance: entry.provenance,
        },
      });
    }
  }
  decisionRows.sort(
    (left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      compare(left.row.kind, right.row.kind) ||
      compare(
        left.row.kind === 'planner_approval'
          ? left.row.task.selection.id
          : `${left.row.session.selection.id}/${left.row.proposalId}`,
        right.row.kind === 'planner_approval'
          ? right.row.task.selection.id
          : `${right.row.session.selection.id}/${right.row.proposalId}`,
      ),
  );
  const witness = ownerWitness(input);
  const strategySection = page(
    input,
    cursors,
    'strategies',
    [...strategies.values()].sort(resourceOrder),
    strategyIncomplete,
    witness,
  );
  const projectSection = page(
    input,
    cursors,
    'projects',
    [...projects.values()].sort(resourceOrder),
    plannerIncomplete,
    witness,
  );
  const decisionSection = page(
    input,
    cursors,
    'decisions',
    decisionRows.map(({ row }) => row),
    decisionIncomplete,
    witness,
  );
  // Withhold a putative next event unless complete coverage proves the global minimum.
  const meetingRows = meetingIncomplete
    ? []
    : [...meetings.values()].sort(
        (left, right) =>
          Date.parse(left.startsAt) - Date.parse(right.startsAt) ||
          compare(left.resource.selection.id, right.resource.selection.id),
      );
  const meetingSection = page(
    input,
    cursors,
    'engagements',
    meetingRows,
    meetingIncomplete,
    witness,
  );
  const actions: OperationalAction[] = [
    { kind: 'edit_objective', expectedObjectiveVersion: input.scope.objectiveVersion },
  ];
  const opened = new Set<string>();
  function open(resource: ObjectiveOperationalResource): void {
    const identity = `${resource.selection.kind}/${resource.selection.id}`;
    if (opened.has(identity)) return;
    opened.add(identity);
    actions.push({
      kind: 'open_resource',
      resource: { ...resource.selection },
      ownerVersion: { ...resource.ownerVersion },
      contentView: 'current',
    });
  }
  for (const row of [...strategySection.items, ...projectSection.items, ...meetingSection.items])
    open(row.resource);
  for (const row of decisionSection.items) {
    if (row.kind === 'planner_approval') {
      open(row.task);
      if (row.task.ownerVersion.kind === 'counter')
        actions.push({
          kind: 'review_planner_approval',
          taskId: row.task.selection.id,
          taskVersion: row.task.ownerVersion.value,
        });
    }
  }
  const allTasks = [...tasks.values()]
    .filter((entry) => !entry.conflict)
    .map((entry) => entry.task);
  const response: Omit<OperationalReadResponse, 'projectionDigest'> = {
    schemaVersion: 1,
    observedAt: input.observedAt,
    asOf: input.asOf,
    scope: { ...input.scope },
    associationSetVersion: input.setVersion,
    automation: { availability: 'not_implemented', projection: null },
    sections: {
      strategies: strategySection,
      projects: projectSection,
      decisions: decisionSection,
      questions: {
        observedAt: input.observedAt,
        coverage: 'not_implemented',
        snapshotId: null,
        reasons: ['unsupported_question_lifecycle'],
        total: null,
        nextCursor: null,
        items: [],
      },
      engagements: meetingSection,
    },
    plannerMetrics: {
      observedAt: input.observedAt,
      asOf: input.asOf,
      coverage: plannerIncomplete ? 'partial' : 'complete',
      reasons: plannerIncomplete ? ['source_unverifiable'] : [],
      taskCount: plannerIncomplete ? null : allTasks.length,
      doneCount: plannerIncomplete
        ? null
        : allTasks.filter((task) => task.status === 'done').length,
      overdueCount: plannerIncomplete
        ? null
        : allTasks.filter((task) => task.status !== 'done' && task.overdue).length,
    },
    actions,
  };
  return { ...response, projectionDigest: operationalDigest(response) };
}
