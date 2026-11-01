import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { requireClientObjectiveAccess, type ClientObjectiveDestinationTx } from './client-objective-destination.js';
import { createPlannerApplicationCodec } from './objective-planner-owner-codec.js';

/** Private server contract. A reservation excludes legacy work; it is not a
 * canonical admission, workload grant, or evidence of a Meri dispatch. */
export const OBJECTIVE_STRATEGY_TYPES = ['appropriations', 'authorization', 'regulatory', 'coalition',
  'procurement', 'earmark', 'amendment'] as const;
export type ObjectiveStrategyType = (typeof OBJECTIVE_STRATEGY_TYPES)[number];
export interface ObjectiveStrategyDraftRequest {
  requestId: string; clientId: string; objective: { objectiveId: string; objectiveVersion: number };
  type: ObjectiveStrategyType;
}
export interface ObjectiveStrategySource {
  clientId: string; objectiveId: string; objectiveVersion: number; objectiveRevisionId: string;
}
export interface ObjectiveStrategyReservation {
  schemaVersion: 1; intakeId: string; consentId: string; commandReceiptId: string; wrapperSha256: string;
}
export class ObjectiveStrategyIntakeUnavailable extends Error {
  constructor() { super('Objective Strategy intake unavailable'); }
}
const fail = (): never => { throw new ObjectiveStrategyIntakeUnavailable(); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const canonicalHash = createPlannerApplicationCodec({ isProxy: types.isProxy,
  sha256: text => createHash('sha256').update(text).digest('hex') }).applicationHash;
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === 'string' && pattern.exec(value)?.[0] === value;

/** One implementation of the existing Objective request/hash/envelope dialect.
 * SHA and application errors are injected into this codec. This preserves the original sorted-object JSON algorithm,
 * including its Date and JavaScript numeric-key behavior. */
export function createObjectiveStrategyRequestCodec(deps: {
  sha256(text: string): string; invalidRequest(): never; isProxy?(value: unknown): boolean;
}) {
  const invalid = deps.invalidRequest;
  function closed(raw: unknown, keys: readonly string[]): Record<string, any> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || deps.isProxy?.(raw) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return invalid();
    const own = Reflect.ownKeys(raw);
    if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k))) return invalid();
    const result: Record<string, any> = {};
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(raw, key);
      if (!d?.enumerable || !('value' in d)) return invalid();
      result[key] = d.value;
    }
    return result;
  }
  function digest(value: unknown): string {
    const stable = (v: any): any => v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.map(stable) :
      v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
    return deps.sha256(JSON.stringify(stable(value)));
  }
  function parseObjectiveDraft(raw: unknown): ObjectiveStrategyDraftRequest {
    const r = closed(raw, ['requestId', 'clientId', 'objective', 'type']);
    const o = closed(r.objective, ['objectiveId', 'objectiveVersion']);
    if (![r.requestId, r.clientId, o.objectiveId].every(v => exact(UUID, v)) ||
        !Number.isInteger(o.objectiveVersion) || o.objectiveVersion < 1 || o.objectiveVersion > 2147483647 ||
        !OBJECTIVE_STRATEGY_TYPES.includes(r.type)) return invalid();
    return { requestId: r.requestId.toLowerCase(), clientId: r.clientId.toLowerCase(),
      objective: { objectiveId: o.objectiveId.toLowerCase(), objectiveVersion: o.objectiveVersion }, type: r.type };
  }
  function requestKey(tenant: string, actor: string, requestId: string): string {
    return `objective-v1:${digest([tenant, actor, requestId])}`;
  }
  function pendingReceipt(request: ObjectiveStrategyDraftRequest, source: ObjectiveStrategySource) {
    return { schemaVersion: 1 as const, requestId: request.requestId, source,
      context: { reobservedAt: null, state: 'pending' as const, packetId: null, compiledAt: null,
        sourceDigest: null, coverageDigest: null, inputDigest: null, issues: [] as never[] }, result: null, failure: null };
  }
  function parseReservation(raw: unknown): Readonly<ObjectiveStrategyReservation> {
    const r = closed(raw, ['schemaVersion', 'intakeId', 'consentId', 'commandReceiptId', 'wrapperSha256']);
    if (r.schemaVersion !== 1 || ![r.intakeId, r.consentId, r.commandReceiptId]
      .every(v => exact(UUID, v) && v === v.toLowerCase()) || !exact(SHA, r.wrapperSha256)) return invalid();
    return Object.freeze(r) as unknown as Readonly<ObjectiveStrategyReservation>;
  }
  return Object.freeze({ digest, parseObjectiveDraft, requestKey, pendingReceipt, parseReservation });
}

export interface ObjectiveStrategyIntakeTx {
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>;
}
/** Scoped type hint for preserving an existing Strategy. The existing canonical
 * admission and frozen-basis fences still prove ownership and current version. */
export async function readObjectiveCanonicalStrategyTypeWithinTx(tx: ObjectiveStrategyIntakeTx,
  tenantId: string, clientId: string, objectiveId: string): Promise<ObjectiveStrategyType | null> {
  const rows = await tx.$queryRawUnsafe<Array<{ type: ObjectiveStrategyType }>>(`SELECT s.type::text AS type
    FROM client_objective_canonical_plans p JOIN sp_strategy s ON s.tenant_id=p.tenant_id
      AND s.client_id=p.client_id AND s.id=p.canonical_strategy_id
    WHERE p.tenant_id=$1::uuid AND p.client_id=$2::uuid AND p.objective_id=$3::uuid AND s.archived_at IS NULL`,
    tenantId, clientId, objectiveId);
  if (!Array.isArray(rows) || rows.length > 1 || rows[0] && !OBJECTIVE_STRATEGY_TYPES.includes(rows[0].type)) return fail();
  return rows[0]?.type ?? null;
}
export interface ObjectiveStrategyJobRow {
  readonly id: string; readonly tenantId: string; readonly clientId: string; readonly ownerUserId: string;
  readonly status: string; readonly attempt: number; readonly claimedBy: string | null;
  readonly claimedAt: unknown; readonly strategyId: string | null; readonly requestKey: string;
  readonly input: unknown; readonly deadlineAtMs: string;
}
declare const inventoryBrand: unique symbol;
export interface ObjectiveStrategyJobInventory {
  readonly jobs: readonly ObjectiveStrategyJobRow[];
  readonly [inventoryBrand]: true;
}
const held = new WeakMap<object, { tx: ObjectiveStrategyIntakeTx; tenantId: string }>();
/** Every production job INSERT path takes this gate before any native scope
 * locks. Workers do not insert jobs, and continue using their original locks. */
export async function lockObjectiveStrategyJobCreatorsWithinTx(tx: ObjectiveStrategyIntakeTx, tenantId: string): Promise<void> {
  if (!exact(UUID, tenantId) || tenantId !== tenantId.toLowerCase()) return fail();
  // Prisma cannot deserialize PostgreSQL's void result; keep the same lock
  // expression and return its supported text representation instead.
  await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text',
    `capiro.objective-strategy.job-creators:v1:${tenantId}`);
}
/** Calls the SAME native function enforced by all Strategy/version identity
 * writers. The UUID lock namespace exists only in that SQL owner. No row
 * visibility or caller-selected ID becomes absence authority from this lock. */
export async function lockObjectiveStrategyOutputWithinTx(tx: ObjectiveStrategyIntakeTx, strategyId: string): Promise<void> {
  if (!exact(UUID, strategyId) || strategyId !== strategyId.toLowerCase()) return fail();
  const rows = await tx.$queryRawUnsafe<Array<{ acquired: boolean }>>(
    'SELECT public.objective_strategy_output_gate($1::uuid) AS acquired', strategyId);
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.acquired !== true) return fail();
}
/** Must precede ALL Core/native/control locks. NOWAIT avoids inversion with
 * unordered multirow legacy sweeps. No SKIP LOCKED or filtered absence. */
export async function lockObjectiveStrategyIntakeWithinTx(tx: ObjectiveStrategyIntakeTx, tenantId: string): Promise<ObjectiveStrategyJobInventory> {
  await lockObjectiveStrategyJobCreatorsWithinTx(tx, tenantId);
  const rows = await tx.$queryRawUnsafe<ObjectiveStrategyJobRow[]>(`SELECT id::text AS id,tenant_id::text AS "tenantId",
    client_id::text AS "clientId",owner_user_id AS "ownerUserId",status::text AS status,attempt,
    claimed_by AS "claimedBy",claimed_at AS "claimedAt",strategy_id::text AS "strategyId",request_key AS "requestKey",input,
    floor(extract(epoch FROM deadline_at)*1000)::text AS "deadlineAtMs"
    FROM sp_draft_job WHERE tenant_id=$1::uuid ORDER BY id LIMIT 129 FOR UPDATE NOWAIT`, tenantId);
  if (!Array.isArray(rows) || rows.length > 128 || rows.some(r => !r || !exact(UUID, r.id) || r.tenantId !== tenantId) ||
      new Set(rows.map(r => r.id)).size !== rows.length) return fail();
  const freeze = (v: any): any => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
  const inventory = freeze({ jobs: JSON.parse(JSON.stringify(rows)) }) as ObjectiveStrategyJobInventory;
  held.set(inventory, { tx, tenantId });
  return inventory;
}
/** A plain object or a capability from another transaction is never evidence
 * that the complete job inventory was locked before Core scope. */
export function requireObjectiveStrategyJobInventory(tx: ObjectiveStrategyIntakeTx, tenantId: string,
  inventory: ObjectiveStrategyJobInventory): readonly ObjectiveStrategyJobRow[] {
  const proof = held.get(inventory);
  if (!proof || proof.tx !== tx || proof.tenantId !== tenantId) return fail();
  return inventory.jobs;
}
export interface ObjectiveStrategyNativeIntake {
  intake: Record<string, any>; consent: Record<string, any>; receipt: Record<string, any>;
  snapshot: Record<string, any>; deadlineMs: string; reservedMs: string; consentExpiresMs: string;
}
/** Reads the actual immutable native association, not a marker-supplied scope.
 * Native receipt/consent constraints and the owning transaction supply its
 * provenance; callers still compare every relevant field and current fence.
 * Immutable rows need no FOR SHARE (the restricted role cannot UPDATE them). */
export async function readObjectiveStrategyIntakeWithinTx(tx: ObjectiveStrategyIntakeTx, tenantId: string,
  intakeId: string): Promise<ObjectiveStrategyNativeIntake> {
  if (![tenantId, intakeId].every(v => exact(UUID, v) && v === v.toLowerCase())) return fail();
  const rows = await tx.$queryRawUnsafe<ObjectiveStrategyNativeIntake[]>(`SELECT to_jsonb(i) AS intake,
    to_jsonb(c) AS consent,to_jsonb(receipt) AS receipt,v.snapshot,
    floor(extract(epoch FROM i.original_deadline_at)*1000)::text AS "deadlineMs",
    ceil(extract(epoch FROM i.reserved_at)*1000)::text AS "reservedMs",
    floor(extract(epoch FROM c.expires_at)*1000)::text AS "consentExpiresMs"
    FROM client_objective_strategy_intakes i JOIN client_objective_work_consents c
      ON c.tenant_id=i.tenant_id AND c.client_id=i.client_id AND c.objective_id=i.objective_id
      AND c.work_action=i.work_action AND c.control_id=i.control_id AND c.id=i.consent_id
      AND c.command_receipt_id=i.command_receipt_id
    JOIN client_objective_work_command_receipts receipt ON receipt.tenant_id=i.tenant_id
      AND receipt.client_id=i.client_id AND receipt.objective_id=i.objective_id AND receipt.work_action=i.work_action
      AND receipt.id=i.command_receipt_id AND receipt.request_id=i.command_request_id
      AND receipt.control_id=i.control_id AND receipt.created_consent_id=i.consent_id
    JOIN client_objective_revisions v ON v.tenant_id=i.tenant_id AND v.client_id=i.client_id AND v.objective_id=i.objective_id
      AND v.id=i.source_revision_id AND v.version=i.source_objective_version
    WHERE i.tenant_id=$1::uuid AND i.id=$2::uuid`, tenantId, intakeId);
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]?.intake || !rows[0].consent || !rows[0].receipt ||
      !rows[0].snapshot || rows[0].intake.id !== intakeId || rows[0].intake.tenant_id !== tenantId) return fail();
  return rows[0];
}

/** Service-authenticated discovery only: return no cross-tenant content or authority. */
export async function objectiveStrategyJobTenantWithinSystemTx(tx: ObjectiveStrategyIntakeTx, jobId: string): Promise<string> {
  if (!exact(UUID, jobId)) return fail();
  const rows = await tx.$queryRawUnsafe<Array<{ tenantId: string }>>(
    'SELECT tenant_id::text AS "tenantId" FROM sp_draft_job WHERE id=$1::uuid', jobId);
  if (rows.length !== 1 || !exact(UUID, rows[0]?.tenantId)) return fail();
  return rows[0].tenantId;
}

export interface ObjectiveStrategyJobSubject {
  generationJobId: string; tenantId: string; clientId: string; actorUserId: string; clerkUserId: string;
  tenantSlug: string; role: string; consentId: string; controlVersion: number; checkedAtMs: number; effectExpiresAtMs: number;
  status: string; attempt: number; claimedBy: string | null;
}

/** Saved consent supplies the background subject. No body principal or user bearer is accepted.
 * Job -> native member/client/Objective -> control lock order matches the generation writer.
 * Retained reads authorize current visibility only; they do not renew an original effect. */
export async function readObjectiveStrategyJobSubjectWithinTx(
  tx: ObjectiveStrategyIntakeTx & ClientObjectiveDestinationTx,
  input: { tenantId: string; generationJobId: string; effect: boolean },
): Promise<ObjectiveStrategyJobSubject> {
  if (![input.tenantId, input.generationJobId].every(v => exact(UUID, v)) || typeof input.effect !== 'boolean') return fail();
  const jobs = await tx.$queryRawUnsafe<ObjectiveStrategyJobRow[]>(`SELECT id::text AS id,tenant_id::text AS "tenantId",
    client_id::text AS "clientId",owner_user_id AS "ownerUserId",status::text AS status,attempt,
    claimed_by AS "claimedBy",claimed_at AS "claimedAt",strategy_id::text AS "strategyId",request_key AS "requestKey",input,
    floor(extract(epoch FROM deadline_at)*1000)::text AS "deadlineAtMs"
    FROM sp_draft_job WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, input.tenantId, input.generationJobId);
  const job = jobs[0];
  if (jobs.length !== 1 || !job || job.tenantId !== input.tenantId || job.id !== input.generationJobId ||
      !exact(UUID, job.clientId) || !job.ownerUserId) return fail();
  const ids = await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text AS id
    FROM client_objective_strategy_intakes WHERE tenant_id=$1::uuid AND generation_job_id=$2::uuid`, input.tenantId, job.id);
  if (ids.length !== 1) return fail();
  const saved = await readObjectiveStrategyIntakeWithinTx(tx, input.tenantId, ids[0]!.id);
  const i = saved.intake, c = saved.consent, r = saved.receipt;
  const codec = createObjectiveStrategyRequestCodec({ sha256: text => createHash('sha256').update(text).digest('hex'), invalidRequest: fail });
  const raw = job.input as Record<string, any>, request = codec.parseObjectiveDraft(i.typed_request);
  if (!raw || raw.bearer !== null || !raw.objectiveGeneration ||
      codec.digest(raw.objectiveGeneration.request) !== codec.digest(request) ||
      raw.objectiveGeneration.fingerprint !== codec.digest(request) || request.clientId !== job.clientId ||
      request.requestId !== i.generation_request_id || request.type !== i.selected_type ||
      job.requestKey !== codec.requestKey(job.tenantId, job.ownerUserId, request.requestId) ||
      i.job_request_key !== job.requestKey || i.request_fingerprint !== codec.digest(request) ||
      i.generation_job_id !== job.id || i.client_id !== job.clientId || i.original_clerk_user_id !== job.ownerUserId ||
      !exact(UUID, i.actor_user_id) || c.id !== i.consent_id || c.control_id !== i.control_id ||
      c.consenting_actor_user_id !== i.actor_user_id || c.consenting_membership_id !== i.actor_membership_id ||
      r.id !== i.command_receipt_id || r.created_consent_id !== i.consent_id || r.result_consent_id !== i.consent_id ||
      r.control_version_after !== i.control_version || r.actor_user_id !== i.actor_user_id ||
      r.actor_membership_id !== i.actor_membership_id || r.command_kind !== 'retry' || r.outcome !== 'reconsent_recorded' ||
      c.command_receipt_id !== r.id || c.command_request_id !== r.request_id || i.command_request_id !== r.request_id ||
      c.payload_digest !== r.payload_digest || codec.digest(i.wrapper?.command) !== codec.digest(r.command) ||
      codec.digest({ clientId: i.client_id, objectiveId: i.objective_id, body: i.wrapper }) !== i.wrapper_sha256) return fail();
  const originalKeys = ['tenant_id', 'client_id', 'objective_id', 'work_action', 'canonical_plan_id', 'canonical_epoch',
    'canonical_strategy_id', 'canonical_project_id', 'canonical_binding_version', 'root_intent_id', 'source_revision_id',
    'source_objective_version', 'source_snapshot_hash', 'root_actor_user_id'];
  if (i.work_action !== 'objective.strategy.draft' || originalKeys.some(k => i[k] !== c[k] || i[k] !== r[k]) ||
      c.consent_policy_id !== 'capiro.objective-generation-consent' || c.consent_policy_revision !== 1 ||
      request.objective.objectiveId !== i.objective_id || request.objective.objectiveVersion !== i.source_objective_version ||
      canonicalHash(saved.snapshot) !== i.source_snapshot_hash || saved.snapshot.id !== i.objective_id ||
      saved.snapshot.clientId !== job.clientId || saved.snapshot.version !== i.source_objective_version ||
      saved.snapshot.status !== 'ready' || saved.snapshot.deletedAt != null) return fail();
  const current = await requireClientObjectiveAccess(tx,
    { tenantId: job.tenantId, clerkUserId: job.ownerUserId, userId: i.actor_user_id },
    { clientId: job.clientId, objectiveId: i.objective_id });
  if (current.membershipId !== i.actor_membership_id || typeof current.tenantSlug !== 'string' ||
      !current.tenantSlug.length) return fail();
  const clock = await tx.$queryRawUnsafe<Array<{ nowMs: string }>>(
    'SELECT ceil(extract(epoch FROM clock_timestamp())*1000)::text AS "nowMs"');
  const now = Number(clock[0]?.nowMs), deadline = Number(job.deadlineAtMs), consentExpires = Number(saved.consentExpiresMs);
  const reserved = Number(saved.reservedMs), configured = Number(c.configured_duration_ms), effective = Number(c.effective_duration_ms);
  const confirmed = Date.parse(c.confirmed_at), committed = Date.parse(r.committed_at);
  const stricter = c.stricter_expires_at === null ? null : Date.parse(c.stricter_expires_at);
  if (clock.length !== 1 || ![now, deadline, consentExpires, reserved, configured, effective].every(Number.isSafeInteger) ||
      ![confirmed, committed, ...(stricter === null ? [] : [stricter])].every(Number.isSafeInteger) ||
      now < 0 || deadline !== Number(saved.deadlineMs) || deadline <= reserved || deadline > consentExpires ||
      effective < 1 || effective > configured || configured > 1_800_000 ||
      consentExpires <= confirmed || consentExpires > confirmed + effective ||
      stricter !== null && consentExpires > stricter || reserved < confirmed || reserved < committed ||
      !Number.isInteger(i.control_version) || i.control_version < 1) return fail();
  if (input.effect) {
    const controls = await tx.$queryRawUnsafe<Array<{ version: number; consentId: string; cancelled: boolean; sourceCurrent: boolean }>>(`
      SELECT ctl.version,ctl.current_consent_id::text AS "consentId",ctl.cancelled_at IS NOT NULL AS cancelled,
        (p.canonical_strategy_id=i.canonical_strategy_id AND p.canonical_project_id=i.canonical_project_id
          AND p.binding_version=i.canonical_binding_version AND p.epoch=i.canonical_epoch
          AND p.requested_intent_id=i.root_intent_id AND p.requested_objective_revision_id=i.source_revision_id
          AND p.requested_objective_version=i.source_objective_version AND p.requested_snapshot_hash=i.source_snapshot_hash) AS "sourceCurrent"
      FROM client_objective_strategy_intakes i JOIN client_objective_work_controls ctl ON ctl.tenant_id=i.tenant_id
        AND ctl.id=i.control_id AND ctl.client_id=i.client_id AND ctl.objective_id=i.objective_id AND ctl.work_action=i.work_action
      JOIN client_objective_canonical_plans p ON p.tenant_id=i.tenant_id AND p.id=i.canonical_plan_id
      JOIN tenants t ON t.id=i.tenant_id AND t.settings_jsonb->'clioFeatureFlags'->'strategyPlanner.enabled'='true'::jsonb
      JOIN client_objectives o ON o.tenant_id=i.tenant_id AND o.client_id=i.client_id AND o.id=i.objective_id
        AND o.status::text='ready' AND o.deleted_at IS NULL
      WHERE i.tenant_id=$1::uuid AND i.id=$2::uuid FOR SHARE OF ctl`, job.tenantId, i.id);
    if (controls.length !== 1 || controls[0]!.cancelled || controls[0]!.consentId !== i.consent_id ||
        controls[0]!.version !== i.control_version || controls[0]!.sourceCurrent !== true ||
        current.objectiveVersion !== i.source_objective_version || now >= Math.min(deadline, consentExpires) ||
        !(job.status === 'queued' && job.attempt === 1 && job.claimedBy === null && job.claimedAt === null ||
          job.status === 'running' && job.attempt === 2 && typeof job.claimedBy === 'string' && /^canonical:[a-f0-9]{64}$/.test(job.claimedBy))) return fail();
    if (job.status === 'running') {
      const accepted = await readObjectiveStrategyJobAcceptanceWithinTx(tx, input.tenantId, job.id, job.ownerUserId);
      if (accepted.sourceBinding.tenantId !== job.tenantId || accepted.sourceBinding.actorId !== i.actor_user_id ||
          job.claimedBy !== `canonical:${canonicalHash(accepted.sourceBinding)}` ||
          (job.claimedAt instanceof Date ? job.claimedAt.getTime() : Date.parse(String(job.claimedAt))) !== accepted.acceptedAtMs ||
          accepted.effectExpiresAtMs > Math.min(deadline, consentExpires) || now >= accepted.effectExpiresAtMs) return fail();
    }
  }
  return { generationJobId: job.id, tenantId: job.tenantId, clientId: job.clientId, actorUserId: i.actor_user_id,
    clerkUserId: job.ownerUserId, tenantSlug: current.tenantSlug, role: current.role,
    consentId: i.consent_id, controlVersion: i.control_version,
    checkedAtMs: now, effectExpiresAtMs: Math.min(deadline, consentExpires), status: job.status,
    attempt: job.attempt, claimedBy: job.claimedBy };
}

/** The existing Strategy evidence row is the only accepted-run association. */
export async function readObjectiveStrategyJobAcceptanceWithinTx(tx: ObjectiveStrategyIntakeTx,
  tenantId: string, jobId: string, clerkUserId: string): Promise<{
    sourceBinding: Record<string, any>; sourceAdmissionSha256: string; sourceRequestSha256: string;
    acceptedAtMs: number; effectExpiresAtMs: number;
  }> {
  const kind = 'objective_canonical_generation_acceptance';
  const h = canonicalHash([kind, tenantId, clerkUserId, jobId]);
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const rows = await tx.$queryRawUnsafe<Array<{ data: any }>>(`SELECT data FROM sp_planner_resources
    WHERE tenant_id=$1::uuid AND id=$2::uuid AND kind=$3 AND owner_id=$4
      AND archived=false AND project_id IS NULL AND version=1 AND share_token_hash IS NULL`, tenantId, id, kind, clerkUserId);
  const a = rows[0]?.data, b = a?.sourceBinding;
  if (rows.length !== 1 || !a || Object.keys(a).sort().join(',') !==
      'acceptedAtMs,effectExpiresAtMs,schemaVersion,sourceAdmissionSha256,sourceBinding,sourceRequestSha256' ||
      a.schemaVersion !== 1 || !exact(SHA, a.sourceAdmissionSha256) || !exact(SHA, a.sourceRequestSha256) ||
      !b || Object.keys(b).sort().join(',') !== 'actorId,attemptId,conversationId,runId,tenantId,workerId,writerFence' ||
      !['tenantId','actorId','conversationId','runId','attemptId','workerId'].every(k => exact(UUID, b[k])) ||
      b.tenantId !== tenantId || !Number.isSafeInteger(b.writerFence) || b.writerFence < 1 ||
      !Number.isSafeInteger(a.acceptedAtMs) || !Number.isSafeInteger(a.effectExpiresAtMs) ||
      a.acceptedAtMs < 0 || a.effectExpiresAtMs <= a.acceptedAtMs) return fail();
  return a;
}
