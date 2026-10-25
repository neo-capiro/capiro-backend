import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { createObjectiveStrategyReservationWithinTx, type ObjectiveStrategyJobInventory } from './objective-strategy-job-reservation.js';
import { objectiveStrategyRequestCodec, objectiveStrategySelectedDraft, objectiveStrategySelectionBody,
  objectiveStrategySelectionDigest, parseObjectiveStrategySelection, type ObjectiveStrategySelectionRequest } from './objective-strategy-selection.js';
import { workDigest, workFailure, workUuid, type StoredWorkReceipt, type WorkAuthority, type WorkSource } from './objective-work-command.js';

type Tx = Prisma.TransactionClient;
type Row = Record<string, any>;
const fields: Record<keyof WorkSource, string> = { canonicalPlanId: 'canonical_plan_id', canonicalEpoch: 'canonical_epoch',
  canonicalStrategyId: 'canonical_strategy_id', canonicalProjectId: 'canonical_project_id', canonicalBindingVersion: 'canonical_binding_version',
  rootIntentId: 'root_intent_id', sourceRevisionId: 'source_revision_id', sourceObjectiveVersion: 'source_objective_version',
  sourceSnapshotHash: 'source_snapshot_hash', rootActorUserId: 'root_actor_user_id' };
const fail = (stored: StoredWorkReceipt): never => workFailure('RECEIPT_UNVERIFIABLE', stored.receipt.requestId);

/** A selected replay cannot attach selection to a bare historical v1 receipt. */
export async function verifyObjectiveStrategySelectionWithinTx(tx: Tx, a: WorkAuthority, stored: StoredWorkReceipt,
  request: ObjectiveStrategySelectionRequest): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ record: Row }>>`SELECT to_jsonb(i) AS record
    FROM client_objective_strategy_intakes i
    WHERE i.tenant_id=${a.tenantId}::uuid AND i.client_id=${a.clientId}::uuid AND i.objective_id=${a.objectiveId}::uuid
      AND i.work_action='objective.strategy.draft' AND i.control_id=${stored.controlId}::uuid
      AND i.command_receipt_id=${stored.receipt.receiptId}::uuid`;
  if (rows.length !== 1 || !rows[0]?.record) return fail(stored);
  const i = rows[0].record, r = stored.receipt, s = stored.source;
  let old: ObjectiveStrategySelectionRequest;
  try { old = parseObjectiveStrategySelection(a.clientId, a.objectiveId, i.wrapper); }
  catch { return fail(stored); }
  if (objectiveStrategySelectionDigest(old) !== objectiveStrategySelectionDigest(request))
    return workFailure('REQUEST_ID_CONFLICT', request.work.command.requestId);
  let draft, savedDraft;
  try {
    draft = objectiveStrategySelectedDraft(old, s);
    savedDraft = objectiveStrategyRequestCodec.parseObjectiveDraft(i.typed_request);
    if (workUuid(i.id) !== i.id || workUuid(i.generation_job_id) !== i.generation_job_id) return fail(stored);
  }
  catch { return fail(stored); }
  const deadline = new Date(i.original_deadline_at).getTime(), reserved = new Date(i.reserved_at).getTime();
  if (i.tenant_id !== a.tenantId || i.client_id !== a.clientId || i.objective_id !== a.objectiveId ||
      i.work_action !== 'objective.strategy.draft' || i.control_id !== stored.controlId ||
      i.consent_id !== r.authorizationRequestId || i.command_receipt_id !== r.receiptId ||
      i.command_request_id !== r.requestId || i.control_version !== r.controlVersionAfter ||
      i.actor_user_id !== stored.actorUserId || i.actor_membership_id !== stored.actorMembershipId ||
      stored.actorUserId !== a.actorUserId || i.original_clerk_user_id !== a.clerkUserId ||
      Object.keys(fields).some(key => i[fields[key as keyof WorkSource]] !== s[key as keyof WorkSource]) ||
      i.selected_type !== request.selection.type || i.generation_request_id !== request.selection.generationRequestId ||
      i.wrapper_sha256 !== objectiveStrategySelectionDigest(old) || workDigest(old.work.command) !== workDigest(stored.command) ||
      objectiveStrategyRequestCodec.digest(savedDraft) !== objectiveStrategyRequestCodec.digest(draft) ||
      i.request_fingerprint !== objectiveStrategyRequestCodec.digest(draft) ||
      i.job_request_key !== objectiveStrategyRequestCodec.requestKey(a.tenantId, i.original_clerk_user_id, draft.requestId) ||
      !Number.isSafeInteger(deadline) || !Number.isSafeInteger(reserved) || reserved < Date.parse(r.committedAt) ||
      deadline <= reserved || !r.consent || deadline > Date.parse(r.consent.expiresAt)) return fail(stored);
  // The immutable intake owns the original reservation identity on both the
  // insertion path and exact-command recovery. Never derive it from a retry.
  return i.generation_job_id;
}

/** Called only from the selected command's native receipt insertion transaction. */
export async function insertObjectiveStrategySelectionWithinTx(tx: Tx, a: WorkAuthority, stored: StoredWorkReceipt,
  request: ObjectiveStrategySelectionRequest, inventory: ObjectiveStrategyJobInventory): Promise<void> {
  const r = stored.receipt, s = stored.source;
  if (r.command !== 'retry' || r.workAction !== 'objective.strategy.draft' || !r.consent ||
      r.authorizationRequestId !== r.consent.id || stored.actorUserId !== a.actorUserId ||
      r.controlVersionBefore !== 0 || r.controlVersionAfter !== 1 || r.targetAuthorizationRequestId !== null)
    return workFailure('AUTHORITY_UNAVAILABLE', r.requestId);
  const draft = objectiveStrategySelectedDraft(request, s), fingerprint = objectiveStrategyRequestCodec.digest(draft),
    key = objectiveStrategyRequestCodec.requestKey(a.tenantId, a.clerkUserId, draft.requestId),
    wrapper = objectiveStrategySelectionBody(request), wrapperSha256 = objectiveStrategySelectionDigest(request),
    intakeId = randomUUID(), generationJobId = randomUUID();
  const roots = await tx.$queryRaw<Array<{ outcome: string }>>`SELECT snapshot->>'outcome' AS outcome FROM client_objective_revisions
    WHERE tenant_id=${a.tenantId}::uuid AND client_id=${a.clientId}::uuid AND objective_id=${a.objectiveId}::uuid
      AND id=${s.sourceRevisionId}::uuid AND version=${s.sourceObjectiveVersion}`;
  if (roots.length !== 1 || typeof roots[0]?.outcome !== 'string' || !roots[0].outcome.trim()) workFailure('AUTHORITY_UNAVAILABLE');
  const count = await tx.$executeRaw`INSERT INTO client_objective_strategy_intakes
    (id,tenant_id,client_id,objective_id,work_action,control_id,consent_id,command_receipt_id,command_request_id,control_version,
     actor_user_id,actor_membership_id,original_clerk_user_id,canonical_plan_id,canonical_epoch,canonical_strategy_id,canonical_project_id,
     canonical_binding_version,root_intent_id,source_revision_id,source_objective_version,source_snapshot_hash,root_actor_user_id,
     selected_type,generation_request_id,wrapper,wrapper_sha256,typed_request,request_fingerprint,job_request_key,generation_job_id,original_deadline_at)
    VALUES (${intakeId}::uuid,${a.tenantId}::uuid,${a.clientId}::uuid,${a.objectiveId}::uuid,'objective.strategy.draft',
     ${stored.controlId}::uuid,${r.consent.id}::uuid,${r.receiptId}::uuid,${r.requestId}::uuid,${r.controlVersionAfter},
     ${a.actorUserId}::uuid,${a.actorMembershipId}::uuid,${a.clerkUserId},${s.canonicalPlanId}::uuid,${s.canonicalEpoch},
     ${s.canonicalStrategyId}::uuid,${s.canonicalProjectId}::uuid,${s.canonicalBindingVersion},${s.rootIntentId}::uuid,
     ${s.sourceRevisionId}::uuid,${s.sourceObjectiveVersion},${s.sourceSnapshotHash},${s.rootActorUserId}::uuid,
     ${request.selection.type},${draft.requestId}::uuid,${JSON.stringify(wrapper)}::jsonb,${wrapperSha256},
     ${JSON.stringify(draft)}::jsonb,${fingerprint},${key},${generationJobId}::uuid,${r.consent.expiresAt}::timestamptz)`;
  if (count !== 1) workFailure('AUTHORITY_UNAVAILABLE');
  await createObjectiveStrategyReservationWithinTx(tx, { inventory, intakeId, generationJobId,
    tenantId: a.tenantId, clientId: a.clientId, objectiveId: a.objectiveId, consentId: r.consent.id,
    commandReceiptId: r.receiptId, wrapperSha256, originalClerkUserId: a.clerkUserId, typedRequest: draft,
    requestFingerprint: fingerprint, jobRequestKey: key, source: { clientId: a.clientId, objectiveId: a.objectiveId,
      objectiveVersion: s.sourceObjectiveVersion, objectiveRevisionId: s.sourceRevisionId },
    intentOutcome: roots[0]!.outcome, originalDeadlineAtMs: Date.parse(r.consent.expiresAt) });
}
