import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { MERI_CASE46 as f, assertMeriCase46ToolInput } from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';
import { CASE46_BINDING_KEY, case46Record, readSealedCase46Binding,
  type Case46AuthorityDependencies } from './meri-case46-authority.js';
import { readCase46BoundAuthorityInTx } from './meri-case46-provider-budget-owner.js';
import { case46BudgetHash, settledCase46ProviderReceipt } from './meri-case46-provider-budget.js';
import { case46ProposalMarker, CASE46_PROPOSAL_MARKER } from './meri-case46-action-authority.js';
import { readTextArtifactCreation } from './meri-text-artifact-receipt.js';
import { assertTextArtifactCurrentProposal } from './meri-text-artifact-current-proposal.js';

type Input = { prisma: PrismaService; deps: Case46AuthorityDependencies | undefined;
  ctx: TenantContext; conversationId: string; conversationMetadata: unknown };
type Message = { id: string; role: string; body: string; metadata?: Prisma.JsonValue | null };
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
function fail(code: string): never { throw new Error(`meri_case46_readback_${code}`); }
function bound(input: Input): boolean {
  return input.ctx.tenantId === f.tenantId && input.ctx.userId === f.actorUserId
    && case46Record(input.conversationMetadata)[CASE46_BINDING_KEY] !== undefined;
}

/** The signed internal transport is stored for the server, never a public
 * conversation response. Its hash is sufficient for browser provenance. */
export function publicCase46ConversationMetadata<T>(value: T): T {
  const metadata = case46Record(value);
  const binding = metadata[CASE46_BINDING_KEY];
  if (binding === undefined) return value;
  return { ...metadata, [CASE46_BINDING_KEY]: { version: 1, bindingSha256: case46BudgetHash(binding) } } as T;
}

/** Existing authenticated GET surfaces only. No caller-provided receipt issues
 * authority: all rows, original input, immutable bytes and usage are re-read. */
export async function readCase46CaptureAdmission(input: Input) {
  if (!bound(input)) return null;
  return inspect(input);
}
export async function readCase46CaptureMessage(input: Input & { message: Message }) {
  if (!bound(input) || input.message.role !== 'assistant') return null;
  const current = await inspect(input);
  if (!current.assistant || current.assistant.id !== input.message.id
    || current.assistant.bodySha256 !== sha(input.message.body)
    || case46BudgetHash(case46Record(input.message.metadata).governedArtifactCaptureReceipt)
      !== case46BudgetHash(current.providerUsage)) fail('served_message_changed');
  return current;
}

async function inspect(input: Input) {
  const { ctx, conversationId, deps } = input;
  if (!deps || deps.prisma !== input.prisma) fail('canonical_owner_unavailable');
  return input.prisma.withTenantUser(ctx.tenantId, ctx.userId, async tx => {
    const row = await tx.clioConversation.findFirst({ where: { id: conversationId,
      tenantId: ctx.tenantId, userId: ctx.userId, archivedAt: null }, select: { metadata: true } });
    const sealed = readSealedCase46Binding(row?.metadata, ctx, conversationId);
    if (!sealed) fail('binding_missing');
    // Lock current source + parent first, matching reservation/proposal/effect.
    let current = await readCase46BoundAuthorityInTx(tx, deps, ctx, sealed.policy);
    const messages = await tx.$queryRaw<Array<{ id: string; user_id: string; client_id: string | null;
      role: string; body: string; metadata: unknown }>>`
      SELECT id::text,user_id::text,client_id::text,role,body,metadata_jsonb AS metadata FROM clio_messages
      WHERE tenant_id=${ctx.tenantId}::uuid AND conversation_id=${conversationId}::uuid
      ORDER BY created_at,id LIMIT 3 FOR SHARE`;
    const proposals = await tx.$queryRaw<Array<{ id: string; user_id: string; actor_user_id: string;
      tool: string; surface: string; status: string; input: unknown; preview: unknown }>>`
      SELECT id::text,user_id::text,actor_user_id::text,tool,surface,status,input_jsonb AS input,preview_jsonb AS preview
      FROM meri_action_proposals WHERE tenant_id=${ctx.tenantId}::uuid AND conversation_id=${conversationId}::uuid
      ORDER BY id LIMIT 2 FOR SHARE`;
    const artifacts = await tx.$queryRaw<Array<{ id: string; user_id: string; client_id: string | null;
      kind: string; body_text: string | null; metadata: unknown }>>`
      SELECT id::text,user_id::text,client_id::text,kind,body_text,metadata_jsonb AS metadata FROM clio_artifacts
      WHERE tenant_id=${ctx.tenantId}::uuid AND conversation_id=${conversationId}::uuid
      ORDER BY id LIMIT 2 FOR SHARE`;
    if (messages.length > 2 || proposals.length > 1 || artifacts.length > 1
      || messages.some(m => m.user_id !== ctx.userId || m.client_id !== f.clientId)
      || proposals.some(p => p.user_id !== ctx.userId || p.actor_user_id !== ctx.userId)
      || artifacts.some(a => a.user_id !== ctx.userId || a.client_id !== f.clientId)) fail('scope_or_count_changed');
    const user = messages.find(m => m.role === 'user');
    const assistant = messages.find(m => m.role === 'assistant');
    if (messages.some(m => !['user', 'assistant'].includes(m.role))
      || (messages.length && (!user || user.body !== f.prompt))
      || (messages.length === 2 && !assistant)) fail('original_turn_changed');
    let providerUsage: ReturnType<typeof settledCase46ProviderReceipt> | null = null;
    let effect: Record<string, unknown> | null = null;
    if (assistant) {
      const policy = { ...sealed.policy, turnId: user!.id };
      current = await readCase46BoundAuthorityInTx(tx, deps, ctx, policy);
      providerUsage = settledCase46ProviderReceipt(current.metadata, policy, sealed.qualification);
      if (case46BudgetHash(case46Record(assistant.metadata).governedArtifactCaptureReceipt)
        !== case46BudgetHash(providerUsage)) fail('saved_usage_changed');
      if (proposals.length !== 1) fail('canonical_proposal_missing');
      const proposal = proposals[0]!;
      assertMeriCase46ToolInput(policy, proposal.tool, proposal.input);
      if (proposal.surface !== 'chat'
        || case46BudgetHash(case46Record(proposal.preview)[CASE46_PROPOSAL_MARKER])
          !== case46BudgetHash(case46ProposalMarker(policy))) fail('proposal_authority_changed');
      if (artifacts.length) {
        const artifact = artifacts[0]!;
        const metadata = case46Record(artifact.metadata);
        if (proposal.status !== 'succeeded' || artifact.kind !== 'text_document'
          || artifact.body_text !== f.text || metadata.docFormat !== 'txt'
          || metadata.filename !== f.filename || metadata.mimeType !== 'text/plain'
          || metadata.documentBytesBase64 !== Buffer.from(f.text).toString('base64')
          || metadata.documentSha256 !== f.sha256 || metadata.documentByteLength !== 28
          || metadata.documentByteFormat !== 'txt' || metadata.documentByteAuthority !== 'persisted_at_creation_v1')
          fail('stored_effect_bytes_changed');
        const creation = readTextArtifactCreation(metadata.textCreation, { artifactId: artifact.id,
          tenantId: ctx.tenantId, userId: ctx.userId, clientId: f.clientId, conversationId,
          filename: f.filename, mimeType: 'text/plain', sha256: f.sha256, byteLength: 28 });
        if (creation.actionProposalId !== proposal.id) fail('effect_proposal_changed');
        const action = await assertTextArtifactCurrentProposal(tx, creation);
        if (!action || action.artifactEffectCount !== 1 || action.approvedBy !== ctx.userId
          || !Number.isSafeInteger(action.attemptCount) || action.attemptCount < 1
          || !action.approvedAt || !Number.isFinite(Date.parse(action.approvedAt))
          || !Number.isFinite(Date.parse(action.executedAt))
          || Date.parse(action.approvedAt) > Date.parse(action.executedAt))
          fail('current_approval_missing');
        effect = { ...creation, currentAction: action };
      } else if (proposal.status !== 'proposed') fail('proposal_not_awaiting_approval');
    } else if (artifacts.length || (messages.length === 0 && proposals.length)) fail('effect_before_turn');
    return {
      version: 1, kind: 'meri_case46_current_capture', caseId: '46',
      phase: assistant ? effect ? 'ARTIFACT_CREATED' : 'AWAITING_APPROVAL' : user ? 'TURN_STARTED' : 'READY',
      fixtureNamespace: f.namespace, tenantId: ctx.tenantId, actorUserId: ctx.userId,
      clientId: f.clientId, conversationId, captureRunId: sealed.policy.captureRunId,
      policyId: sealed.policy.policyId, policySha256: case46BudgetHash(sealed.policy),
      currentVerifySha256: current.currentVerifySha256, source: current.source,
      qualificationSha256: sealed.policy.qualificationSha256, expiresAt: sealed.policy.expiresAt,
      originalPromptSha256: sha(f.prompt), userMessageId: user?.id ?? null,
      assistant: assistant ? { id: assistant.id, bodySha256: sha(assistant.body),
        bodyByteLength: Buffer.byteLength(assistant.body) } : null,
      proposalId: proposals[0]?.id ?? null, providerUsage, effect,
      counts: { userTurns: user ? 1 : 0, assistantTurns: assistant ? 1 : 0,
        proposals: proposals.length, artifactEffects: artifacts.length },
    };
  });
}
