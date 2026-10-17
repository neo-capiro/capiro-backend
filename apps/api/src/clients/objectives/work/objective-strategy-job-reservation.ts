import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import type { Prisma } from '@prisma/client';
import { createObjectiveStrategyRequestCodec, requireObjectiveStrategyJobInventory, readObjectiveStrategyIntakeWithinTx,
  lockObjectiveStrategyIntakeWithinTx, type ObjectiveStrategyDraftRequest, type ObjectiveStrategyJobInventory,
  type ObjectiveStrategySource } from '@capiro/shared/objective-strategy-intake';
import { workFailure } from './objective-work-command.js';

export { lockObjectiveStrategyIntakeWithinTx, type ObjectiveStrategyJobInventory };
type Tx = Prisma.TransactionClient;
const unavailable = (): never => workFailure('AUTHORITY_UNAVAILABLE');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const exact = (p: RegExp, v: unknown): v is string => typeof v === 'string' && p.exec(v)?.[0] === v;
const codec = createObjectiveStrategyRequestCodec({ sha256: text => createHash('sha256').update(text).digest('hex'),
  invalidRequest: unavailable, isProxy: nodeTypes.isProxy });
export interface ObjectiveStrategyReservationInput {
  inventory: ObjectiveStrategyJobInventory; intakeId: string; generationJobId: string; tenantId: string;
  clientId: string; objectiveId: string; consentId: string; commandReceiptId: string; wrapperSha256: string;
  originalClerkUserId: string; typedRequest: ObjectiveStrategyDraftRequest; requestFingerprint: string;
  jobRequestKey: string; source: ObjectiveStrategySource; intentOutcome: string; originalDeadlineAtMs: number;
}
function captured(raw: ObjectiveStrategyReservationInput): ObjectiveStrategyReservationInput {
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw)) return unavailable();
  const keys: Array<keyof ObjectiveStrategyReservationInput> = ['inventory', 'intakeId', 'generationJobId', 'tenantId',
    'clientId', 'objectiveId', 'consentId', 'commandReceiptId', 'wrapperSha256', 'originalClerkUserId', 'typedRequest',
    'requestFingerprint', 'jobRequestKey', 'source', 'intentOutcome', 'originalDeadlineAtMs'];
  if (Reflect.ownKeys(raw).length !== keys.length) return unavailable();
  const r: any = {};
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(raw, k);
    if (!d?.enumerable || !('value' in d)) return unavailable();
    r[k] = d.value;
  }
  for (const k of ['intakeId', 'generationJobId', 'tenantId', 'clientId', 'objectiveId', 'consentId', 'commandReceiptId'])
    if (!exact(UUID, r[k])) return unavailable();
  if (!exact(SHA, r.wrapperSha256) || !exact(SHA, r.requestFingerprint) || typeof r.originalClerkUserId !== 'string' ||
      !r.originalClerkUserId || r.originalClerkUserId.length > 128 || typeof r.intentOutcome !== 'string' ||
      !r.intentOutcome.trim() || r.intentOutcome.length > 2000 || !Number.isSafeInteger(r.originalDeadlineAtMs) ||
      r.originalDeadlineAtMs < 0 || r.originalDeadlineAtMs > 8_640_000_000_000_000) return unavailable();
  const request = codec.parseObjectiveDraft(r.typedRequest), s = r.source;
  if (!s || typeof s !== 'object' || nodeTypes.isProxy(s) || Array.isArray(s) ||
      Reflect.ownKeys(s).sort().join(',') !== 'clientId,objectiveId,objectiveRevisionId,objectiveVersion') return unavailable();
  const source: any = {};
  for (const k of ['clientId', 'objectiveId', 'objectiveRevisionId', 'objectiveVersion']) {
    const d = Object.getOwnPropertyDescriptor(s, k);
    if (!d?.enumerable || !('value' in d)) return unavailable();
    source[k] = d.value;
  }
  if (source.clientId !== r.clientId || source.objectiveId !== r.objectiveId || !exact(UUID, source.objectiveRevisionId) ||
      source.objectiveVersion !== request.objective.objectiveVersion || request.clientId !== r.clientId ||
      request.objective.objectiveId !== r.objectiveId || codec.digest(request) !== r.requestFingerprint ||
      codec.requestKey(r.tenantId, r.originalClerkUserId, request.requestId) !== r.jobRequestKey) return unavailable();
  return { ...r, typedRequest: request, source };
}
/** Called only after the actual native selected consent+command receipt+intake
 * have been inserted. No new job lock is acquired after Core locks. This helper
 * neither creates a delegation nor records admission or an accepted Meri run. */
export async function createObjectiveStrategyReservationWithinTx(tx: Tx, raw: ObjectiveStrategyReservationInput):
  Promise<{ intakeId: string; generationJobId: string }> {
  const r = captured(raw), jobs = requireObjectiveStrategyJobInventory(tx, r.tenantId, r.inventory);
  if (jobs.some(j => j.id === r.generationJobId || j.requestKey === r.jobRequestKey)) return unavailable();
  const row = await readObjectiveStrategyIntakeWithinTx(tx, r.tenantId, r.intakeId), i = row.intake;
  if (i.id !== r.intakeId || i.generation_job_id !== r.generationJobId ||
      i.tenant_id !== r.tenantId || i.client_id !== r.clientId || i.objective_id !== r.objectiveId ||
      i.work_action !== 'objective.strategy.draft' || i.consent_id !== r.consentId ||
      i.command_receipt_id !== r.commandReceiptId || i.wrapper_sha256 !== r.wrapperSha256 ||
      i.original_clerk_user_id !== r.originalClerkUserId || i.selected_type !== r.typedRequest.type ||
      i.generation_request_id !== r.typedRequest.requestId || codec.digest(i.typed_request) !== codec.digest(r.typedRequest) ||
      i.request_fingerprint !== r.requestFingerprint || i.job_request_key !== r.jobRequestKey ||
      i.source_revision_id !== r.source.objectiveRevisionId || i.source_objective_version !== r.source.objectiveVersion ||
      Number(row.deadlineMs) !== r.originalDeadlineAtMs || row.snapshot?.outcome !== r.intentOutcome ||
      row.snapshot?.id !== r.objectiveId || row.snapshot?.clientId !== r.clientId ||
      row.snapshot?.version !== r.source.objectiveVersion || row.snapshot?.status !== 'ready' || row.snapshot?.deletedAt != null)
    return unavailable();
  const marker = codec.parseReservation({ schemaVersion: 1, intakeId: r.intakeId, consentId: r.consentId,
    commandReceiptId: r.commandReceiptId, wrapperSha256: r.wrapperSha256 });
  const input = { dto: { clientId: r.clientId, type: r.typedRequest.type, goal: r.intentOutcome }, bearer: null,
    objectiveGeneration: { request: r.typedRequest, fingerprint: r.requestFingerprint,
      receipt: codec.pendingReceipt(r.typedRequest, r.source) }, objectiveCanonicalReservation: marker };
  const inserted = await tx.$queryRawUnsafe<Array<{ id: string }>>(`INSERT INTO sp_draft_job
    (id,tenant_id,client_id,owner_user_id,request_key,input,status,attempt,claimed_by,claimed_at,strategy_id,deadline_at,updated_at)
    VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb,'queued',1,NULL,NULL,NULL,
      $7::timestamptz AT TIME ZONE 'UTC',clock_timestamp()) RETURNING id::text AS id`,
    r.generationJobId, r.tenantId, r.clientId, r.originalClerkUserId, r.jobRequestKey, JSON.stringify(input),
    new Date(r.originalDeadlineAtMs).toISOString());
  if (inserted.length !== 1 || inserted[0]?.id !== r.generationJobId) return unavailable();
  return { intakeId: r.intakeId, generationJobId: r.generationJobId };
}
