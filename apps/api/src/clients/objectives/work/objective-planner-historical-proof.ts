import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import type { Prisma } from '@prisma/client';
import { plannerResourceCalendarDate } from '@capiro/shared';
import { createPlannerApplicationCodec, createPlannerMaterializationCodec } from '@capiro/shared/objective-planner-owner-codec';
import { OBJECTIVE_CONSENT_POLICY } from '../../../auth/workload-authority/objective-consent-policy.js';
import { OBJECTIVE_WORK_BLOCKER, OBJECTIVE_WORK_PURPOSE } from '../objective-work-intent.js';
import { parseWorkCommand, workDigest, workFailure, workUuid, type WorkAuthority } from './objective-work-command.js';

type Json = Record<string, any>;
export interface ObjectivePlannerHistoricalConsentProof {
  consentId: string;
  previousConsentId: string | null;
  controlVersion: number;
  confirmedAtMs: number;
  committedAtMs: number;
  expiresAtMs: number;
}
const PLAN = 'objective.plan.prepare';
const NAMESPACE = 'capiro.objective-planner.continuation:v1';
const MAX_DURATION = 1_800_000;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const application = createPlannerApplicationCodec({ isProxy: nodeTypes.isProxy, sha256 });
const fail = (): never => workFailure('OUTCOME_UNCONFIRMED');
// Keep the original Objective stable-object JSON convention used by Planner's
// owner adapter. Receipt identity itself is delegated to the shared codec.
const objectiveDigest = (value: unknown) => sha256(JSON.stringify(JSON.parse(application.applicationJson(value))));
const materialization = createPlannerMaterializationCodec({ sha256, digest: objectiveDigest,
  canonicalRegenerationHash: application.applicationHash, plannerCalendarDate: plannerResourceCalendarDate,
  materializationError: fail });
const copy = <T>(value: T): T => JSON.parse(application.applicationJson(value)) as T;
function closed(value: unknown, keys: string[]): Json {
  application.applicationJson(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) return fail();
  return value as Json;
}
function uuid(value: unknown): string {
  if (workUuid(value) !== value) return fail();
  return value as string;
}
function integer(value: unknown, minimum = 1, maximum = 2147483647): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function hash(value: unknown): void {
  if (typeof value !== 'string' || /^[0-9a-f]{64}$/.exec(value)?.[0] !== value) fail();
}
/** PostgreSQL to_jsonb(timestamptz) retains the session offset/microseconds. */
function timestamp(value: unknown): number {
  if (typeof value !== 'string' ||
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[0] !== value) return fail();
  const result = Date.parse(value), suffix = value.slice(-6);
  const offset = value.endsWith('Z') ? 0 :
    (suffix[0] === '+' ? 1 : -1) * (Number(suffix.slice(1, 3)) * 60 + Number(suffix.slice(4, 6))) * 60_000;
  if (!Number.isSafeInteger(result) || result < 0 ||
      new Date(result + offset).toISOString().slice(0, 19) !== value.slice(0, 19)) return fail();
  return result;
}
function privateId(value: unknown): string {
  const h = application.applicationHash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function operation(value: unknown): Json {
  const op = closed(value, ['schemaVersion', 'namespace', 'tenantId', 'clerkUserId', 'membershipId',
    'work', 'original', 'state', 'lease', 'terminal']);
  const w = closed(op.work, ['canonical', 'applicationRequestId', 'generationJobId', 'generationRequestId',
    'strategyId', 'strategyVersionId', 'objectiveReceiptSha256', 'snapshotDigest', 'actorUserId', 'consentId', 'controlVersion']);
  const { actorUserId: _actor, consentId: _consent, controlVersion: _control, ...fields } = w;
  const request = application.parseCanonicalApplication({ schemaVersion: 1, ...fields });
  uuid(w.actorUserId); uuid(w.consentId); uuid(op.membershipId);
  if (!integer(w.controlVersion) || request.applicationRequestId !== application.canonicalApplicationRequestId(request.canonical, w.actorUserId) ||
      op.schemaVersion !== 1 || op.namespace !== NAMESPACE || op.tenantId !== request.canonical.tenantId ||
      typeof op.clerkUserId !== 'string' || !op.clerkUserId || op.clerkUserId.length > 128 ||
      !['failed', 'cancelled', 'applied'].includes(op.state) || op.lease !== null) fail();
  const o = closed(op.original, ['operationId', 'attemptId', 'runId', 'requestFingerprint', 'originalDeadlineAt', 'workSha256']);
  const workSha256 = application.applicationHash(w), operationId = privateId([NAMESPACE, w.applicationRequestId, w.consentId, workSha256]);
  const deadline = timestamp(o.originalDeadlineAt);
  if (new Date(deadline).toISOString() !== o.originalDeadlineAt || o.workSha256 !== workSha256 || o.operationId !== operationId ||
      o.attemptId !== privateId([NAMESPACE, 'attempt', operationId]) || o.runId !== privateId([NAMESPACE, 'run', operationId]) ||
      o.requestFingerprint !== application.applicationHash({ namespace: NAMESPACE, workSha256, clerkUserId: op.clerkUserId,
        membershipId: op.membershipId, originalDeadlineAt: o.originalDeadlineAt })) fail();
  const terminal = closed(op.terminal, ['receiptId', 'recordedAtMs']); uuid(terminal.receiptId);
  if (!integer(terminal.recordedAtMs, 0, 8_640_000_000_000_000) ||
      (op.state === 'failed' || op.state === 'cancelled') && terminal.receiptId !== operationId) fail();
  return op;
}

/** Exact receipt addresses for the caller's unfiltered tenant/id probes. IDs
 * are consistency inputs, never proof that either receipt exists or is absent. */
export function objectivePlannerHistoricalReceiptIds(rawOperation: unknown): { applicationId: string; ownerId: string } {
  try {
    const op = operation(copy(rawOperation));
    return Object.freeze({ applicationId: application.applicationReceiptId(op.tenantId, op.clerkUserId, op.work.applicationRequestId),
      ownerId: materialization.canonicalMaterializationReceiptId(op.tenantId, op.clerkUserId, op.work.applicationRequestId) });
  } catch { return fail(); }
}
const sourceKeys = ['canonical_plan_id', 'canonical_epoch', 'canonical_strategy_id', 'canonical_project_id',
  'canonical_binding_version', 'root_intent_id', 'source_revision_id', 'source_objective_version',
  'source_snapshot_hash', 'root_actor_user_id'];
const scopeKeys = ['id', 'tenant_id', 'client_id', 'objective_id', 'work_action', 'control_id', ...sourceKeys];
const consentKeys = [...scopeKeys, 'previous_consent_id', 'consenting_actor_user_id', 'consenting_membership_id',
  'consent_policy_id', 'consent_policy_revision', 'configured_duration_ms', 'effective_duration_ms',
  'stricter_expires_at', 'stricter_limit_ref', 'confirmed_at', 'expires_at', 'command_request_id', 'command_receipt_id', 'payload_digest'];
const receiptKeys = [...scopeKeys, 'actor_user_id', 'actor_membership_id', 'request_id', 'payload_digest', 'command',
  'command_kind', 'command_revision_id', 'command_objective_version', 'control_version_before', 'control_version_after',
  'target_consent_id', 'created_consent_id', 'result_consent_id', 'outcome', 'committed_at'];

/** Original native consent lineage only. The caller supplies its existing
 * Planner/Core transaction and current-authority gates. Historical memberships
 * are identity joins, never inherited active authority. An applied state still
 * requires the caller's full paired application/owner proof; a terminal label
 * or this metadata alone establishes neither an effect nor effect absence. */
export async function verifyObjectivePlannerHistoricalConsentWithinTx(tx: Prisma.TransactionClient,
  rawAuthority: WorkAuthority, rawControlId: string, rawOperation: unknown): Promise<ObjectivePlannerHistoricalConsentProof> {
  try {
    // Strict JSON validation and detachment happen before the first await.
    const a = copy(rawAuthority), controlId = uuid(rawControlId), op = operation(copy(rawOperation));
    for (const value of [a.tenantId, a.clientId, a.objectiveId]) uuid(value);
    const w = op.work, canonical = w.canonical;
    if (canonical.tenantId !== a.tenantId || canonical.clientId !== a.clientId || canonical.objectiveId !== a.objectiveId) fail();
    const rows = await tx.$queryRaw<Array<{ consent: Json; receipt: Json; intent: Json; revision: Json; clerkUserId: string }>>`
      SELECT to_jsonb(c) AS consent,to_jsonb(r) AS receipt,to_jsonb(i) AS intent,
        to_jsonb(v) AS revision,u.clerk_user_id AS "clerkUserId"
      FROM client_objective_work_consents c
      JOIN client_objective_work_command_receipts r ON r.tenant_id=c.tenant_id AND r.client_id=c.client_id
        AND r.objective_id=c.objective_id AND r.work_action=c.work_action AND r.control_id=c.control_id AND r.id=c.command_receipt_id
      JOIN client_objective_work_intents i ON i.tenant_id=c.tenant_id AND i.client_id=c.client_id AND i.objective_id=c.objective_id
        AND i.id=c.root_intent_id AND i.objective_revision_id=c.source_revision_id AND i.objective_version=c.source_objective_version
      JOIN client_objective_revisions v ON v.tenant_id=i.tenant_id AND v.client_id=i.client_id AND v.objective_id=i.objective_id
        AND v.id=i.objective_revision_id AND v.version=i.objective_version
      JOIN tenant_memberships m ON m.tenant_id=c.tenant_id AND m.id=c.consenting_membership_id AND m.user_id=c.consenting_actor_user_id
      JOIN users u ON u.id=m.user_id
      WHERE c.tenant_id=${a.tenantId}::uuid AND c.client_id=${a.clientId}::uuid AND c.objective_id=${a.objectiveId}::uuid
        AND c.work_action=${PLAN} AND c.id=${w.consentId}::uuid AND c.control_id=${controlId}::uuid
      FOR SHARE OF m,u,i,v`;
    if (rows.length !== 1) fail();
    const row = closed(rows[0], ['consent', 'receipt', 'intent', 'revision', 'clerkUserId']);
    const c = closed(row.consent, consentKeys), r = closed(row.receipt, receiptKeys);
    const i = closed(row.intent, ['id', 'tenant_id', 'client_id', 'objective_id', 'objective_revision_id',
      'objective_version', 'actor_user_id', 'purpose', 'snapshot_hash', 'state', 'blocked_reason', 'created_at']);
    const v = closed(row.revision, ['id', 'tenant_id', 'client_id', 'objective_id', 'version', 'operation', 'actor_user_id', 'snapshot', 'created_at']);
    const expectedSource = { canonical_plan_id: canonical.canonicalPlanId, canonical_epoch: canonical.epoch,
      canonical_strategy_id: canonical.canonicalStrategyId, canonical_project_id: canonical.canonicalProjectId,
      canonical_binding_version: canonical.bindingVersion, root_intent_id: canonical.requestedIntentId,
      source_revision_id: canonical.requestedObjectiveRevisionId, source_objective_version: canonical.requestedObjectiveVersion,
      source_snapshot_hash: canonical.snapshotHash, root_actor_user_id: i.actor_user_id };
    for (const record of [c, r]) {
      if (record.tenant_id !== a.tenantId || record.client_id !== a.clientId || record.objective_id !== a.objectiveId ||
          record.work_action !== PLAN || record.control_id !== controlId) fail();
      for (const [key, value] of Object.entries(expectedSource)) if (record[key] !== value) fail();
    }
    for (const value of [c.id, c.command_receipt_id, c.command_request_id, c.consenting_actor_user_id,
      c.consenting_membership_id, i.actor_user_id]) uuid(value);
    hash(c.payload_digest);
    if (c.previous_consent_id !== null) uuid(c.previous_consent_id);
    if (c.id !== w.consentId || c.previous_consent_id === c.id || c.consenting_actor_user_id !== w.actorUserId ||
        c.consenting_membership_id !== op.membershipId || r.actor_user_id !== w.actorUserId || r.actor_membership_id !== op.membershipId ||
        row.clerkUserId !== op.clerkUserId || r.id !== c.command_receipt_id || r.request_id !== c.command_request_id ||
        r.payload_digest !== c.payload_digest || r.created_consent_id !== c.id || r.result_consent_id !== c.id ||
        r.target_consent_id !== c.previous_consent_id || r.command_kind !== 'retry' || r.outcome !== 'reconsent_recorded' ||
        !integer(r.control_version_before, 0) || !integer(r.control_version_after) ||
        r.control_version_after !== r.control_version_before + 1 || r.control_version_after !== w.controlVersion) fail();
    const command = parseWorkCommand(a.clientId, a.objectiveId, r.command);
    if (command.command.command !== 'retry' || command.command.workAction !== PLAN ||
        command.command.requestId !== c.command_request_id || command.command.targetAuthorizationRequestId !== c.previous_consent_id ||
        command.command.expectedControlVersion !== r.control_version_before ||
        command.command.expectedObjectiveVersion !== canonical.requestedObjectiveVersion ||
        command.command.expectedCanonicalBindingVersion !== canonical.bindingVersion ||
        r.command_revision_id !== canonical.requestedObjectiveRevisionId || r.command_objective_version !== canonical.requestedObjectiveVersion ||
        workDigest(command) !== c.payload_digest || workDigest(command.command) !== workDigest(r.command)) fail();
    const confirmedAtMs = timestamp(c.confirmed_at), expiresAtMs = timestamp(c.expires_at), committedAtMs = timestamp(r.committed_at);
    if (c.consent_policy_id !== OBJECTIVE_CONSENT_POLICY.id || c.consent_policy_revision !== OBJECTIVE_CONSENT_POLICY.revision ||
        !integer(c.configured_duration_ms, 1, MAX_DURATION) || !integer(c.effective_duration_ms, 1, MAX_DURATION) ||
        c.effective_duration_ms > c.configured_duration_ms || expiresAtMs - confirmedAtMs !== c.effective_duration_ms ||
        committedAtMs < confirmedAtMs || committedAtMs >= expiresAtMs) fail();
    if (c.stricter_expires_at === null ? c.stricter_limit_ref !== null :
        timestamp(c.stricter_expires_at) !== expiresAtMs || typeof c.stricter_limit_ref !== 'string' ||
        !c.stricter_limit_ref.trim() || c.stricter_limit_ref.length > 128) fail();
    if (i.tenant_id !== a.tenantId || i.client_id !== a.clientId || i.objective_id !== a.objectiveId ||
        i.id !== canonical.requestedIntentId || i.objective_revision_id !== canonical.requestedObjectiveRevisionId ||
        i.objective_version !== canonical.requestedObjectiveVersion || i.snapshot_hash !== canonical.snapshotHash ||
        i.purpose !== OBJECTIVE_WORK_PURPOSE || i.state !== 'pending' || i.blocked_reason !== OBJECTIVE_WORK_BLOCKER ||
        v.tenant_id !== a.tenantId || v.client_id !== a.clientId || v.objective_id !== a.objectiveId ||
        v.id !== i.objective_revision_id || v.version !== i.objective_version || v.actor_user_id !== i.actor_user_id ||
        v.operation !== 'confirm_ready') fail();
    const snapshot = v.snapshot;
    // closed(row) checked strict finite JSON before the original kernel digest.
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || snapshot.status !== 'ready' ||
        snapshot.deletedAt !== null || snapshot.id !== a.objectiveId || snapshot.clientId !== a.clientId ||
        snapshot.version !== canonical.requestedObjectiveVersion || workDigest(snapshot) !== canonical.snapshotHash) fail();
    timestamp(i.created_at); timestamp(v.created_at);
    const deadline = timestamp(op.original.originalDeadlineAt);
    if (deadline <= confirmedAtMs || deadline > expiresAtMs || op.terminal.recordedAtMs < committedAtMs) fail();
    // Failure/cancellation can be terminal-accounted after timeout. Applied ACK
    // timing and paired immutable output custody remain the applied checker.
    return Object.freeze({ consentId: c.id, previousConsentId: c.previous_consent_id, controlVersion: r.control_version_after,
      confirmedAtMs, committedAtMs, expiresAtMs });
  } catch { return fail(); }
}
