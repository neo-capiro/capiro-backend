import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import {
  MERI_CASE46,
  MERI_CAPTURE_POLICY_HEADER,
  MERI_GOVERNED_ARTIFACT_HEADER,
  assertMeriCase46ToolInput,
  decodeMeriGovernedArtifactTransport,
  type MeriGovernedArtifactCapturePolicy,
} from '@capiro/meriv2-core';
import type { Request } from 'express';
import {
  case46Record,
  readSealedCase46Binding,
  type Case46AuthorityDependencies,
} from './meri-case46-authority.js';
import { readCase46BoundAuthorityInTx } from './meri-case46-provider-budget-owner.js';
import {
  case46BudgetHash,
  readCase46ProviderBudget,
  settledCase46ProviderReceipt,
} from './meri-case46-provider-budget.js';

export const CASE46_AUTHORITY_DEPENDENCIES = Symbol('case46 canonical authority dependencies');
export const CASE46_PROPOSAL_MARKER = 'governedArtifactCapture';
type ProposalInput = {
  tool: string;
  input: unknown;
  conversationId?: string | null;
  surface: string;
};
function fail(reason: string): never {
  throw new Error(`meri_case46_proposal_${reason}`);
}

/** This alternate transport is still behind the existing JWT, roles and
 * internal-service guard. It never changes the read-only capability. */
export function admitCase46ProposalTransport(
  ctx: TenantContext,
  req: Request,
  request: ProposalInput,
) {
  const value = req.headers[MERI_GOVERNED_ARTIFACT_HEADER];
  if (value === undefined) return null;
  if (
    typeof value !== 'string' ||
    req.headers[MERI_CAPTURE_POLICY_HEADER] !== undefined ||
    Object.keys(request).sort().join(',') !== 'conversationId,input,surface,tool' ||
    request.surface !== 'chat' ||
    typeof request.conversationId !== 'string'
  )
    fail('transport_invalid');
  const policy = decodeMeriGovernedArtifactTransport(
    value,
    {
      purpose: 'action_proposal',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      conversationId: request.conversationId,
      clientId: MERI_CASE46.clientId,
    },
    process.env.INTERNAL_SERVICE_SECRET,
  );
  assertMeriCase46ToolInput(policy, request.tool, request.input);
  return policy;
}

export function case46ProposalMarker(policy: MeriGovernedArtifactCapturePolicy) {
  return {
    version: 1,
    policyId: policy.policyId,
    policySha256: case46BudgetHash(policy),
    turnId: policy.turnId,
    currentVerifySha256: policy.currentVerifySha256,
    approval: 'canonical_current_user_required',
  };
}
export function publicCase46ProposalPreview(preview: unknown): Record<string, unknown> {
  const { [CASE46_PROPOSAL_MARKER]: _private, ...value } = case46Record(preview);
  return value;
}

/** Holds current canonical source and conversation locks through proposal
 * creation/claim. No stored marker alone is authority. A valid ordinary
 * unbound conversation is unchanged; a bound one cannot lose its guard merely
 * by omitting the transport or stored marker. */
export async function assertCase46ProposalAuthorityInTx(
  tx: Prisma.TransactionClient,
  deps: Case46AuthorityDependencies | undefined,
  ctx: TenantContext,
  request: ProposalInput,
  input:
    | { phase: 'create'; policy: MeriGovernedArtifactCapturePolicy | null }
    | { phase: 'approve'; proposalId: string; preview: unknown },
) {
  const supplied = input.phase === 'create' ? input.policy : null;
  const marker =
    input.phase === 'approve' ? case46Record(input.preview)[CASE46_PROPOSAL_MARKER] : undefined;
  const fixedActor =
    ctx.tenantId === MERI_CASE46.tenantId && ctx.userId === MERI_CASE46.actorUserId;
  if (!fixedActor && !supplied && marker === undefined) return null;
  if (!request.conversationId) {
    if (supplied || marker !== undefined) fail('conversation_missing');
    return null;
  }
  if (!deps) return fail('owner_unavailable');
  const conversation = await tx.clioConversation.findFirst({
    where: {
      id: request.conversationId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      archivedAt: null,
    },
    select: { metadata: true },
  });
  const sealed = readSealedCase46Binding(conversation?.metadata, ctx, request.conversationId);
  if (!sealed) {
    if (supplied || marker !== undefined) fail('binding_missing');
    return null;
  }
  const policy =
    input.phase === 'create'
      ? supplied
      : {
          ...sealed.policy,
          turnId: case46Record(marker).turnId as string,
        };
  if (!policy) return fail('transport_missing');
  assertMeriCase46ToolInput(policy, request.tool, request.input);
  if (request.surface !== 'chat' || policy.conversationId !== request.conversationId)
    fail('scope_changed');
  if (
    input.phase === 'approve' &&
    case46BudgetHash(marker) !== case46BudgetHash(case46ProposalMarker(policy))
  )
    fail('marker_changed');
  const current = await readCase46BoundAuthorityInTx(tx, deps, ctx, policy);
  if (!readCase46ProviderBudget(current.metadata, policy, current.sealed.qualification))
    fail('budget_missing');
  if (input.phase === 'approve')
    settledCase46ProviderReceipt(current.metadata, policy, current.sealed.qualification);
  const proposals = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT id::text FROM meri_action_proposals
    WHERE tenant_id=${ctx.tenantId}::uuid AND conversation_id=${request.conversationId}::uuid ORDER BY id FOR UPDATE`;
  const artifacts = await tx.$queryRaw<
    Array<{ count: bigint }>
  >`SELECT count(*) AS count FROM clio_artifacts
    WHERE tenant_id=${ctx.tenantId}::uuid AND conversation_id=${request.conversationId}::uuid`;
  if (artifacts.length !== 1 || artifacts[0]!.count !== 0n) fail('effect_already_present');
  if (
    input.phase === 'create'
      ? proposals.length !== 0
      : proposals.length !== 1 || proposals[0]!.id !== input.proposalId
  )
    fail('proposal_count_changed');
  return policy;
}

/** Runs inside the actual artifact insert transaction. Even a direct internal
 * call or a retry after an uncertain response cannot create a second effect. */
export async function assertCase46ArtifactEffectInTx(
  tx: Prisma.TransactionClient,
  deps: Case46AuthorityDependencies,
  ctx: TenantContext,
  artifact: {
    conversationId?: string | null;
    clientId?: string | null;
    title: string;
    kind: string;
    bodyText: string;
    metadata?: unknown;
  },
) {
  if (
    ctx.tenantId !== MERI_CASE46.tenantId ||
    ctx.userId !== MERI_CASE46.actorUserId ||
    !artifact.conversationId
  )
    return null;
  const conversation = await tx.clioConversation.findFirst({
    where: {
      id: artifact.conversationId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      archivedAt: null,
    },
    select: { metadata: true },
  });
  if (!readSealedCase46Binding(conversation?.metadata, ctx, artifact.conversationId)) return null;
  const metadata = case46Record(artifact.metadata),
    creation = case46Record(metadata.textCreation);
  if (
    typeof creation.actionProposalId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      creation.actionProposalId,
    )
  )
    fail('effect_requires_approval');
  const rows = await tx.$queryRaw<
    Array<{ tool: string; input: unknown; preview: unknown; surface: string }>
  >`
    SELECT tool,input_jsonb AS input,preview_jsonb AS preview,surface FROM meri_action_proposals
    WHERE id=${creation.actionProposalId}::uuid AND tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid
      AND conversation_id=${artifact.conversationId}::uuid AND status='executing' AND approved_at IS NOT NULL
      AND approved_by=${ctx.userId}::uuid AND expires_at>now()`;
  if (rows.length !== 1) return fail('approved_effect_owner_missing');
  const proposal = rows[0]!;
  const policy = await assertCase46ProposalAuthorityInTx(
    tx,
    deps,
    ctx,
    { ...proposal, conversationId: artifact.conversationId },
    { phase: 'approve', proposalId: creation.actionProposalId, preview: proposal.preview },
  );
  if (!policy) return fail('effect_binding_missing');
  // Recheck lifecycle/payload after acquiring the proposal/conversation locks.
  const current = await tx.$queryRaw<Array<{ input: unknown; preview: unknown }>>`
    SELECT input_jsonb AS input,preview_jsonb AS preview FROM meri_action_proposals
    WHERE id=${creation.actionProposalId}::uuid AND tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid
      AND conversation_id=${artifact.conversationId}::uuid AND tool='create_word' AND surface='chat'
      AND status='executing' AND approved_at IS NOT NULL AND approved_by=${ctx.userId}::uuid AND expires_at>now()`;
  if (
    current.length !== 1 ||
    case46BudgetHash(current[0]) !==
      case46BudgetHash({ input: proposal.input, preview: proposal.preview })
  )
    fail('approved_effect_owner_changed');
  if (
    artifact.clientId !== policy.clientId ||
    artifact.title !== MERI_CASE46.title ||
    artifact.kind !== 'text_document' ||
    artifact.bodyText !== MERI_CASE46.text ||
    metadata.tool !== 'create_word' ||
    metadata.docFormat !== 'txt' ||
    metadata.filename !== MERI_CASE46.filename ||
    metadata.mimeType !== 'text/plain' ||
    metadata.documentBytesBase64 !== Buffer.from(MERI_CASE46.text).toString('base64') ||
    metadata.documentSha256 !== MERI_CASE46.sha256 ||
    metadata.documentByteLength !== 28 ||
    metadata.documentByteFormat !== 'txt' ||
    metadata.documentByteAuthority !== 'persisted_at_creation_v1' ||
    creation.version !== 1 ||
    creation.kind !== 'meri_text_artifact_creation' ||
    creation.tenantId !== ctx.tenantId ||
    creation.userId !== ctx.userId ||
    creation.clientId !== policy.clientId ||
    creation.conversationId !== policy.conversationId ||
    creation.filename !== MERI_CASE46.filename ||
    creation.mimeType !== 'text/plain' ||
    creation.sha256 !== MERI_CASE46.sha256 ||
    creation.byteLength !== 28 ||
    typeof creation.operationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      creation.operationId,
    )
  )
    fail('effect_bytes_or_identity_changed');
  return policy;
}
