import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import {
  MERI_CASE46,
  decodeMeriGovernedArtifactTransport,
  encodeMeriGovernedArtifactTransport,
  validateMeriGovernedArtifactPolicy,
  type MeriGovernedArtifactCapturePolicy,
} from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { EngagementService } from '../engagement/engagement.service.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import {
  case46BudgetHash,
  validateCase46BudgetQualification,
  type Case46ProviderBudgetQualification,
} from './meri-case46-provider-budget.js';

export const CASE46_BINDING_KEY = 'governedArtifactCapture';
const VERSION = 'meri-live-v1-2026-09-26.1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export type Case46AuthorityDependencies = {
  prisma: PrismaService;
  engagement: Pick<EngagementService, 'extractAttachmentText'>;
};
function fail(code: string): never {
  throw new Error(`meri_case46_${code}`);
}
export const case46Record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Matches the canonical client-document writer idempotency identity. It is an
 * INPUT document, not the clio artifact the evaluated export must create. */
export function case46SourceIdentity(captureRunId: string) {
  if (!UUID.test(captureRunId)) return fail('run_identity_invalid');
  const marker = {
    contractVersion: 'meri-synthetic-fixture-provisioning-v1',
    fixtureNamespace: MERI_CASE46.namespace,
    fixtureVersion: VERSION,
    logicalId: MERI_CASE46.sourceLogicalId,
    owner: 'engagement_attachment',
    tenantId: MERI_CASE46.tenantId,
    fixtureInstanceId: captureRunId,
  };
  const idempotencyKey = `${MERI_CASE46.namespace}:${captureRunId}:${MERI_CASE46.sourceLogicalId}`;
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'client-document-v1',
        MERI_CASE46.tenantId,
        MERI_CASE46.actorUserId,
        MERI_CASE46.clientId,
        null,
        idempotencyKey,
        'text/plain',
        false,
        MERI_CASE46.sha256,
      ]),
    )
    .digest('hex');
  return {
    marker,
    ownershipSha256: case46BudgetHash(marker),
    idempotencyKey,
    physicalId: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
  };
}
function actor(ctx: TenantContext): void {
  if (
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== MERI_CASE46.namespace ||
    ctx.tenantId !== MERI_CASE46.tenantId ||
    ctx.tenantSlug !== MERI_CASE46.tenantSlug ||
    ctx.userId !== MERI_CASE46.actorUserId ||
    ctx.role !== 'standard_user' ||
    !ctx.clerkUserId
  )
    fail('actor_denied');
}

/** Caller holds the same transaction through admission/reservation/effect. No
 * receipt or caller boolean substitutes for the actual current rows and bytes. */
export async function readCase46CurrentAuthorityInTx(
  tx: Prisma.TransactionClient,
  deps: Case46AuthorityDependencies,
  ctx: TenantContext,
  scope: { conversationId: string; captureRunId: string },
) {
  actor(ctx);
  if (!UUID.test(scope.conversationId)) fail('conversation_identity_invalid');
  const identity = case46SourceIdentity(scope.captureRunId);
  // Stable lock order also fences current membership/wall deletion while the
  // provider reservation or one-shot binding is committed.
  await tx.$queryRaw`SELECT id FROM tenants WHERE id=${ctx.tenantId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM users WHERE id=${ctx.userId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT user_id FROM tenant_memberships WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM clients WHERE id=${MERI_CASE46.clientId}::uuid AND tenant_id=${ctx.tenantId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT user_id FROM client_memory_access WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${MERI_CASE46.clientId}::uuid AND user_id=${ctx.userId}::uuid FOR SHARE`;
  const users = await tx.$queryRaw<
    Array<{
      clerk_user_id: string;
      email: string;
      first_name: string | null;
      last_name: string | null;
      role: string;
      slug: string;
      fixture_namespace: string | null;
    }>
  >`
    SELECT u.clerk_user_id,u.email,u.first_name,u.last_name,tm.role,t.slug,
      t.settings_jsonb #>> '{meriFoundationFixture,fixtureNamespace}' AS fixture_namespace
    FROM users u JOIN tenant_memberships tm ON tm.user_id=u.id JOIN tenants t ON t.id=tm.tenant_id
    WHERE u.id=${ctx.userId}::uuid AND tm.tenant_id=${ctx.tenantId}::uuid AND tm.status='active'`;
  const user = users[0];
  if (
    users.length !== 1 ||
    !user ||
    user.clerk_user_id !== ctx.clerkUserId ||
    user.role !== 'standard_user' ||
    user.slug !== MERI_CASE46.tenantSlug ||
    user.fixture_namespace !== MERI_CASE46.namespace ||
    !user.email.toLowerCase().endsWith('@example.com') ||
    !/synthetic/i.test(`${user.first_name} ${user.last_name}`) ||
    !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, MERI_CASE46.clientId))
  )
    fail('current_actor_or_wall_denied');
  const conversations = await tx.$queryRaw<Array<{ metadata: unknown; title: string }>>`
    SELECT metadata_jsonb AS metadata,title FROM clio_conversations
    WHERE id=${scope.conversationId}::uuid AND tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid
      AND client_id=${MERI_CASE46.clientId}::uuid AND archived_at IS NULL AND status='active' FOR UPDATE`;
  if (
    conversations.length !== 1 ||
    conversations[0]!.title !== `${MERI_CASE46.namespace} case46 ${scope.captureRunId}`
  )
    fail('owned_conversation_missing');
  const documents = await tx.$queryRaw<
    Array<{
      row_version: string;
      source_entity_id: string | null;
      source_version: number | null;
      source_content_hash: string | null;
      calculated_sha256: string | null;
      bucket: string;
      s3_key: string;
      file_name: string;
      content_type: string;
      byte_size: number;
      lifecycle_status: string;
      scan_status: string | null;
    }>
  >`
    SELECT xmin::text AS row_version,source_entity_id,source_version,source_content_hash,calculated_sha256,
      bucket,s3_key,file_name,content_type,byte_size,lifecycle_status,scan_status FROM engagement_attachments
    WHERE id=${identity.physicalId}::uuid AND tenant_id=${ctx.tenantId}::uuid AND client_id=${MERI_CASE46.clientId}::uuid
      AND uploaded_by_user_id=${ctx.userId}::uuid AND meeting_id IS NULL AND mail_message_id IS NULL
      AND source='meri_synthetic_fixture' AND source_entity_type='meri_synthetic_fixture'
      AND viewer_mode='all' AND cardinality(viewer_user_ids)=0 AND approved_at IS NULL
      AND approved_by_user_id IS NULL AND shared_at IS NULL AND shared_by_user_id IS NULL
      AND superseded_by_attachment_id IS NULL FOR SHARE`;
  const document = documents[0];
  if (
    documents.length !== 1 ||
    !document ||
    document.source_entity_id !== identity.ownershipSha256 ||
    document.source_version !== 1 ||
    document.source_content_hash !== MERI_CASE46.sha256 ||
    document.calculated_sha256 !== MERI_CASE46.sha256 ||
    !process.env.ASSETS_BUCKET ||
    document.bucket !== process.env.ASSETS_BUCKET ||
    document.s3_key !== `tenants/${ctx.tenantId}/engagement/${identity.physicalId}/document` ||
    document.file_name !== MERI_CASE46.filename ||
    document.content_type !== 'text/plain' ||
    document.byte_size !== 28 ||
    document.lifecycle_status !== 'ready' ||
    !/^[0-9]{1,10}$/.test(document.row_version)
  )
    fail('owned_source_missing_or_changed');
  const sourceBytes = await deps.engagement.extractAttachmentText(ctx, identity.physicalId, {
    clientId: MERI_CASE46.clientId,
    contextSourceOnly: true,
    signal: AbortSignal.timeout(10_000),
  });
  if (
    sourceBytes.attachmentId !== identity.physicalId ||
    sourceBytes.clientId !== MERI_CASE46.clientId ||
    sourceBytes.contentHash !== MERI_CASE46.sha256 ||
    sourceBytes.byteSize !== 28 ||
    sourceBytes.fileName !== MERI_CASE46.filename ||
    sourceBytes.contentType !== 'text/plain'
  )
    fail('current_source_bytes_changed');
  const source: MeriGovernedArtifactCapturePolicy['source'] = {
    owner: 'engagement_attachment',
    logicalId: 'ARTIFACT-BRIEF-1',
    physicalId: identity.physicalId,
    rowVersion: document.row_version,
    ownershipSha256: identity.ownershipSha256,
    contentSha256: MERI_CASE46.sha256,
    byteLength: 28,
  };
  const currentVerify = {
    version: 1,
    caseId: '46',
    fixtureNamespace: MERI_CASE46.namespace,
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    clientId: MERI_CASE46.clientId,
    conversationId: scope.conversationId,
    captureRunId: scope.captureRunId,
    source,
  };
  return {
    metadata: case46Record(conversations[0]!.metadata),
    source,
    currentVerify,
    currentVerifySha256: case46BudgetHash(currentVerify),
  };
}

/** Internal operator install only. No HTTP caller can install this capability.
 * Exact prior metadata + empty conversation stop both concurrent and repeated
 * attempts. No messages/proposals/output artifacts are seeded here. */
export async function installCase46CaptureBinding(
  deps: Case46AuthorityDependencies,
  args: {
    ctx: TenantContext;
    conversationId: string;
    captureRunId: string;
    expectedMetadataSha256: string;
    qualification: Case46ProviderBudgetQualification;
  },
) {
  return deps.prisma.withTenantUser(args.ctx.tenantId, args.ctx.userId, async (tx) => {
    const current = await readCase46CurrentAuthorityInTx(tx, deps, args.ctx, args);
    if (
      !/^[a-f0-9]{64}$/.test(args.expectedMetadataSha256) ||
      case46BudgetHash(current.metadata) !== args.expectedMetadataSha256 ||
      current.metadata[CASE46_BINDING_KEY] !== undefined ||
      current.metadata.governedArtifactProviderBudget !== undefined
    )
      fail('binding_prior_state_changed');
    const counts = await tx.$queryRaw<
      Array<{ messages: bigint; proposals: bigint; artifacts: bigint }>
    >`
      SELECT (SELECT count(*) FROM clio_messages WHERE tenant_id=${args.ctx.tenantId}::uuid AND conversation_id=${args.conversationId}::uuid) AS messages,
      (SELECT count(*) FROM meri_action_proposals WHERE tenant_id=${args.ctx.tenantId}::uuid AND conversation_id=${args.conversationId}::uuid) AS proposals,
      (SELECT count(*) FROM clio_artifacts WHERE tenant_id=${args.ctx.tenantId}::uuid AND conversation_id=${args.conversationId}::uuid) AS artifacts`;
    if (
      counts.length !== 1 ||
      counts[0]!.messages !== 0n ||
      counts[0]!.proposals !== 0n ||
      counts[0]!.artifacts !== 0n
    )
      fail('binding_conversation_not_empty');
    const issuedAt = Date.now();
    const policy: MeriGovernedArtifactCapturePolicy = {
      version: 1,
      kind: 'governed_artifact_acceptance_capture',
      caseId: '46',
      fixtureNamespace: MERI_CASE46.namespace,
      tenantId: MERI_CASE46.tenantId,
      tenantSlug: MERI_CASE46.tenantSlug,
      actorUserId: MERI_CASE46.actorUserId,
      clientId: MERI_CASE46.clientId,
      conversationId: args.conversationId,
      captureRunId: args.captureRunId,
      policyId: randomUUID(),
      requestId: randomUUID(),
      traceId: randomUUID(),
      turnId: null,
      source: current.source,
      currentVerifySha256: current.currentVerifySha256,
      qualificationSha256: case46BudgetHash(args.qualification),
      issuedAt,
      expiresAt: issuedAt + 15 * 60_000,
      allowedTool: 'create_word',
      approval: 'canonical_current_user_required',
      maximumProposals: 1,
      maximumArtifactEffects: 1,
      dynamicMcpAllowed: false,
      incidentalWriters: 'suppressed',
      expectedWrites: [
        'context_packet_and_evidence',
        'conversation_user_message',
        'conversation_assistant_message',
        'provider_budget_ledger',
        'canonical_action_proposal',
        'approved_text_artifact',
      ],
    };
    validateMeriGovernedArtifactPolicy(policy, policy);
    const qualification = validateCase46BudgetQualification(args.qualification, policy);
    const sealedPolicy = encodeMeriGovernedArtifactTransport(
      policy,
      'provider_budget',
      process.env.INTERNAL_SERVICE_SECRET,
    );
    const metadata = {
      ...current.metadata,
      [CASE46_BINDING_KEY]: { version: 1, sealedPolicy, qualification },
    };
    const changed =
      await tx.$executeRaw`UPDATE clio_conversations SET metadata_jsonb=${JSON.stringify(metadata)}::jsonb
      WHERE id=${args.conversationId}::uuid AND tenant_id=${args.ctx.tenantId}::uuid AND user_id=${args.ctx.userId}::uuid
        AND metadata_jsonb=${JSON.stringify(current.metadata)}::jsonb`;
    if (changed !== 1) fail('binding_cas_failed');
    return {
      version: 1,
      caseId: '46',
      conversationId: args.conversationId,
      captureRunId: args.captureRunId,
      currentVerifySha256: current.currentVerifySha256,
      qualificationSha256: policy.qualificationSha256,
      bindingSha256: case46BudgetHash(metadata[CASE46_BINDING_KEY]),
      expiresAt: policy.expiresAt,
    };
  });
}

export function readSealedCase46Binding(
  metadata: unknown,
  ctx: TenantContext,
  conversationId: string,
) {
  const raw = case46Record(metadata)[CASE46_BINDING_KEY];
  if (raw === undefined) return null;
  actor(ctx);
  const binding = case46Record(raw);
  if (
    binding.version !== 1 ||
    Object.keys(binding).sort().join(',') !== 'qualification,sealedPolicy,version' ||
    typeof binding.sealedPolicy !== 'string'
  )
    return fail('binding_invalid');
  const policy = decodeMeriGovernedArtifactTransport(
    binding.sealedPolicy,
    {
      purpose: 'provider_budget',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      clientId: MERI_CASE46.clientId,
      conversationId,
    },
    process.env.INTERNAL_SERVICE_SECRET,
  );
  if (policy.turnId !== null) return fail('binding_turn_must_be_unbound');
  const qualification = validateCase46BudgetQualification(binding.qualification, policy);
  return { policy, qualification };
}
