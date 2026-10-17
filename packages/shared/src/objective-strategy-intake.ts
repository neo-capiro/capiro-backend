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
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === 'string' && pattern.exec(value)?.[0] === value;

/** One implementation of the existing Objective request/hash/envelope dialect.
 * SHA and application errors are injected so this pure subpath has no Node or
 * Nest dependency. This preserves the original sorted-object JSON algorithm,
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
  await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
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
