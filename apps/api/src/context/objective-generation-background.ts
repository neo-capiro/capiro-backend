import { createHash } from 'node:crypto';
import { projectFillRunState } from '../clients/client-profile-fill-completion-projection.js';

/** Retained client-owned research artifacts, not a raw source/mailbox read or
 * a claim that historical accepted values still equal current canonical facts. */
export const OBJECTIVE_BACKGROUND_FIELDS: Record<string, string[]> = {
  profile_fill_corpus: ['id', 'policy', 'counts', 'enumerationComplete'],
  profile_fill_runs: ['id', 'status', 'stage', 'pending', 'progress', 'reportedSources', 'startedAt', 'updatedAt'],
  profile_fill_tasks: ['id', 'runId', 'lane', 'taskType', 'status', 'updatedAt'],
  profile_fill_findings: ['id', 'runId', 'status', 'factKind', 'disposition', 'contentHash', 'createdAt', 'updatedAt'],
};
export class BackgroundSnapshotError extends Error {
  constructor() { super('Retained background context could not be completely observed'); }
}
interface BackgroundTx {
  $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}
type Row = Record<string, any>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_STATUSES = ['queued', 'running', 'completed', 'failed', 'skipped', 'cancelled'];
const RUN_STATUSES = ['running', 'completed', 'partial', 'failed', 'cancelled'];
const RUN_STAGES = ['preparing', 'research', 'review_ready', 'applying', 'completed', 'failed', 'cancelled'];
const FINDING_STATUSES = ['accepted', 'pending', 'rejected', 'informational'];
const fail = (): never => { throw new BackgroundSnapshotError(); };
function text(v: unknown, max: number): string {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : fail();
}
function uuid(v: unknown): string {
  return typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : fail();
}
function choice(v: unknown, values: string[]): string {
  return typeof v === 'string' && values.includes(v) ? v : fail();
}
function date(v: unknown, nullable = false): string | null {
  if (v === null && nullable) return null;
  if (typeof v !== 'string') return fail();
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.exec(v);
  if (!parts || !Number.isFinite(Date.parse(v))) return fail();
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  if (month! < 1 || month! > 12 || day! < 1 ||
      day! > new Date(Date.UTC(year!, month!, 0)).getUTCDate() ||
      hour! > 23 || minute! > 59 || second! > 59) return fail();
  return new Date(v).toISOString();
}
function json(v: unknown, depth = 0): any {
  if (depth > 64) return fail();
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : fail();
  if (Array.isArray(v)) return v.map(x => json(x, depth + 1));
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, json((v as Row)[k], depth + 1)]));
  return fail();
}
function rows(v: unknown, tenantId: string, clientId: string, taskLanes = false): Row[] {
  if (!Array.isArray(v)) return fail();
  const ids = new Set<string>();
  return v.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        uuid(row.tenantId) !== tenantId || uuid(row.clientId) !== clientId) return fail();
    const id = uuid(row.id);
    const key = taskLanes ? `${choice(row.lane, ['core', 'extension'])}:${id}` : id;
    if (ids.has(key)) return fail();
    ids.add(key);
    return { ...row, id };
  }).sort((a, b) => `${taskLanes ? a.lane : ''}:${a.id}`.localeCompare(`${taskLanes ? b.lane : ''}:${b.id}`));
}

/** Pure, lossless enumeration with explicit redaction. There is no latest-run
 * shortcut: older accepted/rejected history is retained by the Fill owner. */
export function projectObjectiveBackground(raw: unknown, tenant: string, client: string) {
  const tenantId = uuid(tenant), clientId = uuid(client);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  const input = raw as Row;
  const rawRuns = rows(input.runs, tenantId, clientId);
  const runIds = new Set(rawRuns.map(r => r.id));
  const rawTasks = rows(input.tasks, tenantId, clientId, true);
  const tasks = rawTasks.map(row => {
    const runId = uuid(row.runId);
    if (!runIds.has(runId)) return fail();
    return { id: row.id, runId, lane: choice(row.lane, ['core', 'extension']),
      taskType: text(row.taskType, 40), status: choice(row.status, TASK_STATUSES),
      updatedAt: date(row.updatedAt) };
  });
  const runs = rawRuns.map(row => {
    const core = tasks.filter(t => t.runId === row.id && t.lane === 'core');
    const extension = tasks.filter(t => t.runId === row.id && t.lane === 'extension');
    const recordedStatus = choice(row.status, RUN_STATUSES);
    const recordedStage = choice(row.stage, RUN_STAGES);
    const recordedCompletedAt = date(row.completedAt, true);
    // The owner merges only when an extension ledger exists. A legacy running
    // run with no tasks must never become an invented review_ready snapshot.
    const merged = projectFillRunState(recordedStatus, core, extension);
    const projected = extension.length ? merged : {
      status: recordedStatus, stage: recordedStage,
      pending: recordedStatus === 'running', progress: merged.progress,
    };
    if (!Number.isInteger(row.workflowVersion) || row.workflowVersion < 1 ||
        !Array.isArray(row.requestedSources) || !Array.isArray(row.reportedSources)) return fail();
    const sourceNames = new Set<string>();
    const reportedSources = row.reportedSources.map((source: Row) => {
      if (!source || typeof source !== 'object') return fail();
      const name = text(source.source, 40);
      if (!/^[a-z][a-z0-9_]*$/.test(name) || sourceNames.has(name)) return fail();
      sourceNames.add(name);
      return { source: name, status: source.status === null ? null : text(source.status, 32) };
    }).sort((a: { source: string }, b: { source: string }) => a.source.localeCompare(b.source));
    return { id: row.id, workflowVersion: row.workflowVersion, recordedStatus, recordedStage, recordedCompletedAt,
      projection: extension.length ? 'merged_completion' : 'stored_core',
      requestedSources: row.requestedSources.map((s: unknown) => text(s, 40)).sort(),
      reportedSources,
      ...projected, startedAt: date(row.startedAt),
      completedAt: extension.length && projected.pending ? null : recordedCompletedAt, updatedAt: date(row.updatedAt) };
  });
  const counts: Record<string, number> = { accepted: 0, pending: 0, rejected: 0, informational: 0 };
  const findings = rows(input.findings, tenantId, clientId).map(row => {
    const runId = uuid(row.runId);
    if (!runIds.has(runId)) return fail();
    const status = choice(row.status, FINDING_STATUSES);
    counts[status] = counts[status]! + 1;
    const factKind = choice(row.factKind, ['fact', 'recommendation']);
    if (typeof row.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.contentHash)) return fail();
    const base = { id: row.id, runId, status, factKind, contentHash: row.contentHash,
      createdAt: date(row.createdAt), updatedAt: date(row.updatedAt) };
    if (status === 'rejected' || status === 'informational') {
      // Even targetKey/source/kind can identify a private person or source.
      return { ...base, disposition: 'withheld_not_supporting' };
    }
    if (typeof row.confidence !== 'number' || !Number.isFinite(row.confidence) ||
        row.confidence < 0 || row.confidence > 1 || !Array.isArray(row.evidence)) return fail();
    const reviewedAt = date(row.reviewedAt, status === 'pending');
    const appliedAt = date(row.appliedAt, status === 'pending');
    if (status === 'pending' && (reviewedAt !== null || appliedAt !== null)) return fail();
    return { ...base,
      disposition: status === 'pending' ? 'candidate_unverified' : 'historical_reviewed_applied',
      kind: text(row.kind, 32), targetKey: text(row.targetKey, 160), source: text(row.source, 32),
      currentValue: json(row.currentValue), proposedValue: json(row.proposedValue),
      evidence: json(row.evidence), confidence: row.confidence, reviewedAt, appliedAt };
  });
  const groups = {
    profile_fill_corpus: [{ id: clientId, policy: {
      observation: 'retained_client_artifacts_as_of_observation',
      accepted: 'historical_reviewed_applied_not_current_canonical_truth',
      pending: 'candidate_unverified_never_verified_fact',
      rejected: 'withheld_never_supports_claim', informational: 'withheld_never_supports_claim',
      factKind: 'recommendations_are_not_facts',
      currentCanonicalFacts: 'authoritative_over_historical_findings',
      rawSourceAuthority: 'not_granted_by_retained_artifact_read',
    }, counts: { ...counts, runs: runs.length, coreTasks: tasks.filter(t => t.lane === 'core').length,
      extensionTasks: tasks.filter(t => t.lane === 'extension').length }, enumerationComplete: true }],
    profile_fill_runs: runs, profile_fill_tasks: tasks, profile_fill_findings: findings,
  };
  // No fresh observation clock: compile/recheck hash exactly the same content.
  const digest = createHash('sha256').update(JSON.stringify(json(groups))).digest('hex');
  return { groups, digest };
}

export class ObjectivePacketBudgetError extends Error {
  readonly group: string;
  constructor(group: string) {
    super('Required fields exceed the approved context budget');
    this.group = group;
  }
}
export const OBJECTIVE_EMPTY_STEERING = '(no approved steering items selected)';
/** Count the actual typed prompt parts, never parse delimiter text inside data.
 * Existing bounds are unchanged; successful projection never slices a record. */
export function objectivePacketAddition(
  groups: Record<string, unknown[]>, intent: unknown,
  original: { retrieval: string; steering: string },
) {
  const blocks: string[] = [];
  for (const [group, records] of Object.entries(groups)) {
    if (group === 'relationship_history') continue;
    for (const record of records) {
      const text = `[${group}]\n${JSON.stringify(record)}`;
      if (text.length > 1600) throw new ObjectivePacketBudgetError(group);
      blocks.push(text);
    }
  }
  const recordsText = blocks.join('\n\n');
  const intentText = `SAVED OBJECTIVE INTENT (data):\n${JSON.stringify(intent)}`;
  const retrievalLength = recordsText.length + original.retrieval.length +
    (recordsText && original.retrieval ? 1 : 0);
  const steeringLength = intentText.length + 1 + (original.steering || OBJECTIVE_EMPTY_STEERING).length;
  if (retrievalLength > 24000 || steeringLength > 12000)
    throw new ObjectivePacketBudgetError('government_targets');
  return { recordsText, intentText };
}

/** Call only after current Objective/client authority, within the same scoped
 * tenant read. One SELECT snapshot; no stale-run mutation, refresh or dispatch. */
export async function readObjectiveBackground(tx: BackgroundTx, tenantId: string, clientId: string) {
  const result = await tx.$queryRaw<Array<{ background: unknown }>>`
    /* objective_background_evidence */
    SELECT jsonb_build_object(
      'runs', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', r.id, 'tenantId', r.tenant_id, 'clientId', r.client_id, 'status', r.status,
        'workflowVersion', r.workflow_version, 'stage', r.stage, 'requestedSources', r.requested_sources,
        'reportedSources', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'source', s.key, 'status', s.value->'status') ORDER BY s.key)
          FROM jsonb_each(r.source_states_jsonb) s), '[]'::jsonb),
        'startedAt', r.started_at, 'completedAt', r.completed_at, 'updatedAt', r.updated_at) ORDER BY r.id)
        FROM client_profile_fill_run r WHERE r.tenant_id=${tenantId}::uuid AND r.client_id=${clientId}::uuid), '[]'::jsonb),
      'tasks', COALESCE((SELECT jsonb_agg(t.value ORDER BY t.lane, t.id) FROM (
        SELECT 'core' AS lane, t.id, jsonb_build_object('id', t.id, 'tenantId', t.tenant_id,
          'clientId', t.client_id, 'runId', t.run_id, 'lane', 'core', 'taskType', t.task_type,
          'status', t.status, 'updatedAt', t.updated_at) AS value FROM client_profile_fill_task t
          WHERE t.tenant_id=${tenantId}::uuid AND t.client_id=${clientId}::uuid
        UNION ALL
        SELECT 'extension', t.id, jsonb_build_object('id', t.id, 'tenantId', t.tenant_id,
          'clientId', t.client_id, 'runId', t.run_id, 'lane', 'extension', 'taskType', t.task_type,
          'status', t.status, 'updatedAt', t.updated_at) FROM client_profile_fill_extension_task t
          WHERE t.tenant_id=${tenantId}::uuid AND t.client_id=${clientId}::uuid
      ) t), '[]'::jsonb),
      'findings', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', f.id, 'tenantId', f.tenant_id, 'clientId', f.client_id, 'runId', f.run_id,
        'status', f.status, 'factKind', f.fact_kind, 'contentHash', f.content_hash,
        'createdAt', f.created_at, 'updatedAt', f.updated_at) || CASE WHEN f.status IN ('accepted','pending')
        THEN jsonb_build_object('kind', f.kind, 'targetKey', f.target_key, 'source', f.source,
          'currentValue', f.current_value_jsonb, 'proposedValue', f.proposed_value_jsonb,
          'evidence', f.evidence_jsonb, 'confidence', f.confidence,
          'reviewedAt', f.reviewed_at, 'appliedAt', f.applied_at) ELSE '{}'::jsonb END ORDER BY f.id)
        FROM client_profile_fill_finding f WHERE f.tenant_id=${tenantId}::uuid AND f.client_id=${clientId}::uuid), '[]'::jsonb)
    ) AS background`.catch(() => fail());
  if (!Array.isArray(result) || result.length !== 1) return fail();
  return projectObjectiveBackground(result[0]?.background, tenantId, clientId);
}
