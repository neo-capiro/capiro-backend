import { ConflictException } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';

export type MembershipState = {
  version: number;
  suppressed: boolean;
  human_revision: number;
  membership_id: string | null;
  created_by_action: string | null;
  contributions: Record<string, { ruleId: string; humanRevision: number }>;
};
export type DecisionReceipt = {
  id: string;
  outcome: string;
  payload: Record<string, any>;
  request_hash: string;
};
export const decisionHash = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');

export async function membershipState(
  tx: Prisma.TransactionClient,
  ctx: WorkspaceTenantContext,
  folderId: string,
  billId: string,
): Promise<MembershipState> {
  const [row] = await tx.$queryRaw<
    MembershipState[]
  >`SELECT version,suppressed,human_revision,membership_id,created_by_action,contributions
    FROM intel_legiwatch_membership_state WHERE tenant_id=${ctx.tenantId} AND folder_id=${folderId} AND bill_id=${billId}`;
  return (
    row ?? {
      version: 0,
      suppressed: false,
      human_revision: 0,
      membership_id: null,
      created_by_action: null,
      contributions: {},
    }
  );
}

/** Caller holds the canonical folder row lock. The receipt and membership write
 * must use this same transaction. No remote service calls belong in this helper.
 */
export async function writeMembershipDecision(
  tx: Prisma.TransactionClient,
  ctx: WorkspaceTenantContext,
  input: {
    folderId: string;
    billId: string;
    action: 'add' | 'remove' | 'restore' | 'undo';
    origin: 'manual' | 'rule';
    requestKey: string;
    ruleId?: string;
    expectedStateVersion?: number;
    undoDecisionId?: string;
    sourceFingerprint?: string;
    bill?: { jurisdiction: string; sessionKey: string };
  },
) {
  const requestHash = decisionHash(input);
  const [previous] = await tx.$queryRaw<
    DecisionReceipt[]
  >`SELECT id,outcome,payload,request_hash FROM intel_legiwatch_decision
    WHERE tenant_id=${ctx.tenantId} AND actor_id=${ctx.clerkUserId} AND request_key=${input.requestKey}`;
  if (previous) {
    if (previous.request_hash !== requestHash)
      throw new ConflictException('DECISION_REQUEST_KEY_REUSED');
    return previous;
  }
  const state = await membershipState(tx, ctx, input.folderId, input.billId);
  if (input.expectedStateVersion !== undefined && input.expectedStateVersion !== state.version)
    throw new ConflictException('MANUAL_DECISION_CHANGED_RELOAD');
  const before = await tx.legiWatchFolderBill.findFirst({
    where: { tenantId: ctx.tenantId, folderId: input.folderId, billId: input.billId },
  });
  const id = randomUUID();
  let outcome = 'held',
    after = before;
  const revisions =
    input.action === 'remove' && before
      ? await tx.legiWatchFolderRevision.findMany({
          where: { tenantId: ctx.tenantId, assignmentId: before.id },
          orderBy: { version: 'asc' },
        })
      : [];
  if (input.action === 'add') {
    if (input.origin === 'rule' && state.suppressed) outcome = 'excluded';
    else {
      if (!input.bill) throw new ConflictException('CANONICAL_BILL_REQUIRED');
      if (!before) {
        after = await tx.legiWatchFolderBill.create({
          data: {
            tenantId: ctx.tenantId,
            folderId: input.folderId,
            billId: input.billId,
            jurisdiction: input.bill.jurisdiction,
            sessionKey: input.bill.sessionKey,
            updatedBy: ctx.clerkUserId,
          },
        });
        state.membership_id = after.id;
        state.created_by_action = input.origin === 'rule' ? id : null;
        state.contributions = {};
      } else if (state.membership_id !== before.id) {
        // A pre-existing/imported membership can never become automation-owned.
        state.membership_id = before.id;
        state.created_by_action = null;
        state.contributions = {};
      }
      if (input.origin === 'manual') {
        state.suppressed = false;
        state.human_revision++;
        state.created_by_action = null;
      } else
        state.contributions[id] = { ruleId: input.ruleId!, humanRevision: state.human_revision };
      outcome = before ? 'already_present' : 'added';
    }
  } else if (input.action === 'remove') {
    if (input.origin !== 'manual') throw new ConflictException('AUTOMATIC_REMOVAL_NOT_ALLOWED');
    await tx.legiWatchFolderBill.deleteMany({
      where: { tenantId: ctx.tenantId, folderId: input.folderId, billId: input.billId },
    });
    state.suppressed = true;
    state.human_revision++;
    state.membership_id = null;
    state.created_by_action = null;
    state.contributions = {};
    after = null;
    outcome = before ? 'removed' : 'already_absent';
  } else if (input.action === 'restore') {
    if (input.origin !== 'manual') throw new ConflictException('MANUAL_RESTORE_REQUIRED');
    state.suppressed = false;
    state.human_revision++;
    outcome = 'restored';
  } else {
    const [original] = await tx.$queryRaw<
      DecisionReceipt[]
    >`SELECT id,outcome,payload,request_hash FROM intel_legiwatch_decision
      WHERE tenant_id=${ctx.tenantId} AND actor_id=${ctx.clerkUserId} AND id=${input.undoDecisionId ?? ''}
      AND folder_id=${input.folderId} AND bill_id=${input.billId} AND action='add' AND origin='rule'`;
    if (!original) throw new ConflictException('UNDO_ACTION_NOT_FOUND');
    const contribution = state.contributions[original.id];
    if (!contribution) outcome = 'already_undone';
    else if (
      state.created_by_action !== original.id ||
      !before ||
      before.id !== original.payload.after?.id ||
      before.version !== original.payload.after?.version ||
      state.human_revision !== contribution.humanRevision ||
      Object.keys(state.contributions).length !== 1
    )
      outcome = 'undo_conflict';
    else {
      await tx.legiWatchFolderBill.deleteMany({
        where: { tenantId: ctx.tenantId, id: before.id, version: before.version },
      });
      state.suppressed = true;
      state.human_revision++;
      state.created_by_action = null;
      state.membership_id = null;
      state.contributions = {};
      after = null;
      outcome = 'undone';
    }
  }
  state.version++;
  await tx.$executeRaw`INSERT INTO intel_legiwatch_membership_state(tenant_id,folder_id,bill_id,version,suppressed,human_revision,membership_id,created_by_action,contributions)
    VALUES(${ctx.tenantId},${input.folderId},${input.billId},${state.version},${state.suppressed},${state.human_revision},${state.membership_id},${state.created_by_action},${JSON.stringify(state.contributions)}::jsonb)
    ON CONFLICT(tenant_id,folder_id,bill_id) DO UPDATE SET version=EXCLUDED.version,suppressed=EXCLUDED.suppressed,
      human_revision=EXCLUDED.human_revision,membership_id=EXCLUDED.membership_id,created_by_action=EXCLUDED.created_by_action,contributions=EXCLUDED.contributions`;
  const payload = {
    before,
    after,
    revisions,
    sourceFingerprint: input.sourceFingerprint ?? null,
    scope: 'folder_bill_all_automatic_rules',
    undoDecisionId: input.undoDecisionId ?? null,
  };
  await tx.$executeRaw`INSERT INTO intel_legiwatch_decision(id,tenant_id,actor_id,folder_id,bill_id,request_key,request_hash,action,origin,rule_id,state_version,outcome,payload)
    VALUES(${id},${ctx.tenantId},${ctx.clerkUserId},${input.folderId},${input.billId},${input.requestKey},${requestHash},${input.action},${input.origin},${input.ruleId ?? null},${state.version},${outcome},${JSON.stringify(payload)}::jsonb)`;
  return { id, outcome, payload, request_hash: requestHash };
}
