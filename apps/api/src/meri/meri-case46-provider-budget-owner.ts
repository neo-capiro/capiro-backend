import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import {
  MERI_CASE46,
  validateMeriGovernedArtifactPolicy,
  type MeriGovernedArtifactCapturePolicy,
} from '@capiro/meriv2-core';
import {
  readCase46CurrentAuthorityInTx,
  readSealedCase46Binding,
  type Case46AuthorityDependencies,
} from './meri-case46-authority.js';
import {
  admitCase46ProviderBudget,
  case46BudgetHash,
  readCase46ProviderBudget,
  reserveCase46ProviderAttempt,
  settleCase46ProviderAttempt,
  settledCase46ProviderReceipt,
  type Case46ProviderSettlement,
} from './meri-case46-provider-budget.js';
import type { ResearchProviderReservationBinding } from './meri-research-tool-budget.js';

export type Case46BudgetOperation =
  | { kind: 'admit' }
  | { kind: 'read' }
  | { kind: 'receipt' }
  | { kind: 'reserve'; binding: ResearchProviderReservationBinding }
  | { kind: 'settle'; input: Case46ProviderSettlement };

/** Shared only by the two case46 owners, in their already-open transaction. */
export async function readCase46BoundAuthorityInTx(
  tx: Prisma.TransactionClient,
  deps: Case46AuthorityDependencies,
  ctx: TenantContext,
  policy: MeriGovernedArtifactCapturePolicy,
) {
  validateMeriGovernedArtifactPolicy(policy, { tenantId: ctx.tenantId, actorUserId: ctx.userId });
  const current = await readCase46CurrentAuthorityInTx(tx, deps, ctx, policy);
  const sealed = readSealedCase46Binding(current.metadata, ctx, policy.conversationId);
  if (
    !sealed ||
    case46BudgetHash(sealed.policy) !== case46BudgetHash({ ...policy, turnId: null }) ||
    current.currentVerifySha256 !== policy.currentVerifySha256 ||
    case46BudgetHash(current.source) !== case46BudgetHash(policy.source)
  )
    throw new Error('meri_case46_current_binding_changed');
  if (policy.turnId !== null) {
    const turns = await tx.$queryRaw<
      Array<{ id: string; body: string }>
    >`SELECT id::text,body FROM clio_messages
      WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid AND conversation_id=${policy.conversationId}::uuid
        AND client_id=${policy.clientId}::uuid AND role='user' ORDER BY created_at,id FOR SHARE`;
    if (
      turns.length !== 1 ||
      turns[0]!.id !== policy.turnId ||
      turns[0]!.body !== MERI_CASE46.prompt
    )
      throw new Error('meri_case46_owned_original_turn_missing');
  }
  return { ...current, sealed };
}

/** Every write locks the actual owned conversation and revalidates the MAC,
 * current ordinary actor/wall, exact source row and actual storage bytes in the
 * same transaction. HTTP bodies supply an attempt, never their own authority. */
export async function case46ProviderBudgetOwner(
  deps: Case46AuthorityDependencies,
  args: {
    ctx: TenantContext;
    policy: MeriGovernedArtifactCapturePolicy;
    operation: Case46BudgetOperation;
  },
) {
  const { ctx, policy, operation } = args;
  validateMeriGovernedArtifactPolicy(policy, { tenantId: ctx.tenantId, actorUserId: ctx.userId });
  return deps.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    const current = await readCase46BoundAuthorityInTx(tx, deps, ctx, policy);
    const { sealed } = current;
    if (
      policy.turnId === null &&
      operation.kind === 'reserve' &&
      operation.binding.phase !== 'api_retrieval'
    ) {
      throw new Error('meri_case46_model_turn_unbound');
    }
    const { metadata } = current;
    const q = sealed.qualification;
    const result =
      operation.kind === 'admit'
        ? admitCase46ProviderBudget(metadata, policy, q)
        : operation.kind === 'reserve'
          ? reserveCase46ProviderAttempt(metadata, policy, q, operation.binding)
          : operation.kind === 'settle'
            ? settleCase46ProviderAttempt(metadata, policy, q, operation.input)
            : { metadata, state: readCase46ProviderBudget(metadata, policy, q) };
    if (!result.state) throw new Error('meri_case46_budget_admission_missing');
    if (operation.kind === 'receipt')
      return { ...result, receipt: settledCase46ProviderReceipt(metadata, policy, q) };
    if (
      operation.kind !== 'read' &&
      case46BudgetHash(metadata) !== case46BudgetHash(result.metadata)
    ) {
      const changed =
        await tx.$executeRaw`UPDATE clio_conversations SET metadata_jsonb=${JSON.stringify(result.metadata)}::jsonb
        WHERE id=${policy.conversationId}::uuid AND tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid
          AND client_id=${policy.clientId}::uuid AND archived_at IS NULL AND metadata_jsonb=${JSON.stringify(metadata)}::jsonb`;
      if (changed !== 1) throw new Error('meri_case46_budget_cas_failed');
    }
    return result;
  });
}

/** Null means no case46 binding, not permission to infer it from a tenant slug.
 * Runtime integration must choose this exact capability OR the readonly one. */
export async function issueCurrentCase46Policy(
  deps: Case46AuthorityDependencies,
  args: { ctx: TenantContext; conversationId: string },
) {
  if (args.ctx.tenantId !== MERI_CASE46.tenantId || args.ctx.userId !== MERI_CASE46.actorUserId)
    return null;
  return deps.prisma.withTenantUser(args.ctx.tenantId, args.ctx.userId, async (tx) => {
    const row = await tx.clioConversation.findFirst({
      where: {
        id: args.conversationId,
        tenantId: args.ctx.tenantId,
        userId: args.ctx.userId,
        archivedAt: null,
      },
      select: { metadata: true },
    });
    const sealed = readSealedCase46Binding(row?.metadata, args.ctx, args.conversationId);
    if (!sealed) return null;
    const current = await readCase46CurrentAuthorityInTx(tx, deps, args.ctx, sealed.policy);
    if (
      current.currentVerifySha256 !== sealed.policy.currentVerifySha256 ||
      case46BudgetHash(
        readSealedCase46Binding(current.metadata, args.ctx, args.conversationId)?.policy,
      ) !== case46BudgetHash(sealed.policy)
    )
      throw new Error('meri_case46_current_binding_changed');
    return sealed.policy;
  });
}
