import { createHash } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { immutableMemoryVersionSlug } from './memory-version.helpers.js';
import { memoryReviewSurfaceEnabled } from './memory-review-switch.js';
import { memoryGovernanceCenterEnabled } from './memory-governance-center.switch.js';
import {
  assertSyntheticApprovedMemoryInTx,
  assertSyntheticSupersededRootInTx,
  type SyntheticApprovedMemoryGuard,
} from './synthetic-approved-memory.helpers.js';

export interface SyntheticMemoryCorrectionGuard {
  sourceItemId: string;
  source: SyntheticApprovedMemoryGuard;
  expectedContent: string;
  proposerUserId: string;
  expectedCandidateRowVersion?: string;
}

export interface SyntheticCorrectionAudit {
  syntheticFixtureCandidateId: string;
  syntheticFixtureMarkerSha256: string;
  syntheticFixtureCandidateRowVersion: string;
  syntheticFixtureItemRowVersion: string;
  syntheticFixtureRootItemId: string;
  syntheticFixtureCorrectionCandidateRowVersion: string;
  syntheticFixtureContentSha256: string;
}

export interface SyntheticCorrectionRetirementGuard {
  correction: SyntheticMemoryCorrectionGuard;
  candidateId: string;
  expectedItemRowVersion: string;
}

/** Evidence of the actual immutable correction, retained predecessor and outbox.
 * No logical fixture label is accepted as a physical v1/v2 chain.
 */
export async function readSyntheticCorrectionInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  guard: SyntheticMemoryCorrectionGuard,
  candidateId: string,
) {
  return readSyntheticCorrectionStateInTx(tx, ctx, guard, candidateId, 'active');
}

async function readSyntheticCorrectionStateInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  guard: SyntheticMemoryCorrectionGuard,
  candidateId: string,
  state: 'active' | 'revoked',
) {
  if (
    !memoryReviewSurfaceEnabled() ||
    !memoryGovernanceCenterEnabled() ||
    !guard ||
    !guard.expectedContent ||
    guard.expectedContent !== guard.expectedContent.trim()
  )
    throw new ForbiddenException('Synthetic correction readback guard does not match');
  const root = await assertSyntheticSupersededRootInTx(tx, ctx, guard.sourceItemId, guard.source);
  const rows = await tx.$queryRaw<
    Array<{
      itemId: string;
      itemRowVersion: string;
      sourceVersion: string;
      sourceContentHash: string;
      rootRowVersion: string;
      candidateRowVersion: string;
      candidateId: string;
      correctionAuditId: string;
      supersessionAuditId: string;
      approvalAuditId: string;
      cleanupIntentId: string;
    }>
  >`
    SELECT v.id::text AS "itemId",v.xmin::text AS "itemRowVersion",
      v.source_version AS "sourceVersion",v.source_content_hash AS "sourceContentHash",
      r.xmin::text AS "rootRowVersion",c.xmin::text AS "candidateRowVersion",c.id::text AS "candidateId",
      av.id::text AS "correctionAuditId",ar.id::text AS "supersessionAuditId",
      ac.id::text AS "approvalAuditId",o.id::text AS "cleanupIntentId"
    FROM memory_items r
    JOIN memory_items v ON v.tenant_id=r.tenant_id AND v.supersedes_id=r.id
    JOIN memory_candidate c ON c.tenant_id=v.tenant_id AND c.id=${candidateId}::uuid AND c.committed_memory_item_id=v.id
    JOIN memory_transition_audit av ON av.tenant_id=v.tenant_id AND av.memory_item_id=v.id
      AND av.proposal_id=c.id AND av.reason_code='corrected' AND av.to_status='active'
      AND av.source_id=r.id::text AND av.actor_user_id=c.approved_by_user_id
      AND av.metadata_jsonb->>'kind'='correction' AND av.metadata_jsonb->>'parentId'=r.id::text
    JOIN memory_transition_audit ar ON ar.tenant_id=r.tenant_id AND ar.memory_item_id=r.id
      AND ar.proposal_id=c.id AND ar.from_status='active' AND ar.to_status='superseded'
      AND ar.reason_code='superseded' AND ar.source_id=v.id::text
      AND ar.actor_user_id=c.approved_by_user_id AND ar.metadata_jsonb->>'supersededByItemId'=v.id::text
    JOIN memory_transition_audit ac ON ac.tenant_id=c.tenant_id AND ac.memory_candidate_id=c.id
      AND ac.proposal_id=c.id AND ac.from_status='pending_review' AND ac.to_status='active'
      AND ac.reason_code='approved' AND ac.source_id=v.id::text AND ac.actor_user_id=c.approved_by_user_id
    JOIN memory_cleanup_outbox o ON o.tenant_id=r.tenant_id AND o.memory_item_id=r.id
      AND o.operation='supersede_projections' AND o.idempotency_key='supersede_projections:'||r.id::text||':'||v.id::text
    WHERE r.tenant_id=${ctx.tenantId}::uuid AND r.id=${guard.sourceItemId}::uuid
      AND r.status='superseded' AND r.governed_status='superseded'
      AND v.status=${state} AND v.governed_status=${state} AND v.source='manual' AND v.provenance='human'
      AND v.source_type='approved_document_edit' AND v.source_id=r.id::text
      AND v.source_version='memory-version:'||c.id::text
      AND v.source_content_hash=encode(sha256(convert_to(${guard.expectedContent},'UTF8')),'hex')
      AND v.sections_jsonb=${JSON.stringify([{ key: 'memory', heading: 'Memory', owner: 'human', body: guard.expectedContent }])}::jsonb
      AND v.origin_surface='memory_correction' AND v.origin_trace_id=c.id::text
      AND v.asserted_by_user_id=c.proposed_by AND v.approved_by_user_id=c.approved_by_user_id
      AND v.approved_at IS NOT NULL AND v.legal_hold=false AND v.instructions_allowed=false
      AND v.conflict_status='none' AND v.conflict_group_id IS NULL AND v.controlling_item_id IS NULL
      AND v.contradicts_id IS NULL AND v.source_excerpt IS NULL
      AND ((${state}='active' AND v.revoked_at IS NULL AND v.revoked_by IS NULL)
        OR (${state}='revoked' AND v.revoked_at IS NOT NULL AND v.revoked_by IS NOT NULL))
      AND v.client_id IS NOT DISTINCT FROM r.client_id AND v.owner_user_id IS NOT DISTINCT FROM r.owner_user_id
      AND v.type=r.type AND v.visibility=r.visibility AND v.title=r.title AND v.aliases=r.aliases AND v.tags=r.tags
      AND v.source_ref=r.source_ref AND v.memory_class=r.memory_class AND v.memory_scope=r.memory_scope
      AND v.memory_authority=CASE r.memory_scope WHEN 'firm' THEN 'firm_approved' WHEN 'client' THEN 'client_approved' ELSE 'user_asserted' END
      AND v.schema_version=r.schema_version AND v.sensitivity=r.sensitivity
      AND v.retention_policy_jsonb IS NOT DISTINCT FROM r.retention_policy_jsonb
      AND v.expires_at IS NOT DISTINCT FROM r.expires_at AND v.valid_until IS NOT DISTINCT FROM r.valid_until
      AND v.second_approved_by_user_id IS NULL AND v.second_approved_at IS NULL
      AND c.proposed_by=${guard.proposerUserId}::uuid AND c.source_kind='memory_correction'
      AND c.scope=CASE r.memory_scope WHEN 'user_private' THEN 'personal' ELSE r.memory_scope END
      AND c.client_id IS NOT DISTINCT FROM r.client_id AND c.memory_scope=r.memory_scope
      AND c.asserted_by_user_id=c.proposed_by
      AND c.status='approved' AND c.governed_status='active' AND c.approved_at IS NOT NULL
      AND c.approved_by_user_id IS NOT NULL AND c.decided_by=c.approved_by_user_id
      AND c.source_id=r.id::text AND c.source_ref='memory_correction' AND c.source_type='user_message'
      AND c.source_content_hash=v.source_content_hash AND c.source_version='candidate:'||c.id::text
      AND c.payload_jsonb=jsonb_build_object('key',r.title,'value',${guard.expectedContent}::text,'source','memory_correction',
        'scope',r.memory_scope,'ownerUserId',r.owner_user_id,'clientId',r.client_id,
        'canonicalItem',jsonb_build_object('type',r.type,'slug',v.slug,'title',r.title,'sections',v.sections_jsonb),
        'versionProposal',${JSON.stringify({ kind: 'correction', sourceItemId: guard.sourceItemId, targetItemId: guard.sourceItemId })}::jsonb)
      AND c.provenance_jsonb=${JSON.stringify({ kind: 'correction', sourceItemId: guard.sourceItemId })}::jsonb
      AND c.conflict_status='none' AND c.legal_hold=false AND c.instructions_allowed=false
      AND av.metadata_jsonb->>'syntheticFixtureCandidateId'=${guard.source.candidateId}
      AND av.metadata_jsonb->>'syntheticFixtureMarkerSha256'=${root.syntheticFixtureMarkerSha256}
      AND av.metadata_jsonb->>'syntheticFixtureCandidateRowVersion'=${guard.source.expectedRowVersion}
      AND av.metadata_jsonb->>'syntheticFixtureItemRowVersion'=${guard.source.expectedItemRowVersion}
      AND av.metadata_jsonb->>'syntheticFixtureRootItemId'=${guard.sourceItemId}
      AND av.metadata_jsonb->>'syntheticFixtureCorrectionCandidateRowVersion'=${guard.expectedCandidateRowVersion}
      AND av.metadata_jsonb->>'syntheticFixtureContentSha256'=${createHash('sha256').update(guard.expectedContent).digest('hex')}
      AND ar.metadata_jsonb->>'syntheticFixtureCandidateId'=${guard.source.candidateId}
      AND ar.metadata_jsonb->>'syntheticFixtureMarkerSha256'=${root.syntheticFixtureMarkerSha256}
      AND ar.metadata_jsonb->>'syntheticFixtureCandidateRowVersion'=${guard.source.expectedRowVersion}
      AND ar.metadata_jsonb->>'syntheticFixtureItemRowVersion'=${guard.source.expectedItemRowVersion}
      AND ar.metadata_jsonb->>'syntheticFixtureRootItemId'=${guard.sourceItemId}
      AND ar.metadata_jsonb->>'syntheticFixtureCorrectionCandidateRowVersion'=${guard.expectedCandidateRowVersion}
      AND ar.metadata_jsonb->>'syntheticFixtureContentSha256'=${createHash('sha256').update(guard.expectedContent).digest('hex')}
    FOR UPDATE OF r,v,c,o,av,ar,ac
  `;
  if (rows.length !== 1 || !rows[0])
    throw new ForbiddenException('Synthetic immutable correction evidence does not match');
  return {
    ...root,
    ...rows[0],
    rootItemId: guard.sourceItemId,
    status: state,
    rootStatus: 'superseded' as const,
  };
}

export async function assertSyntheticCorrectionRetirementInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  itemId: string,
  guard: SyntheticCorrectionRetirementGuard,
) {
  const proof = await readSyntheticCorrectionInTx(tx, ctx, guard.correction, guard.candidateId);
  if (proof.itemId !== itemId || proof.itemRowVersion !== guard.expectedItemRowVersion)
    throw new ForbiddenException('Synthetic correction retirement version does not match');
  return {
    syntheticFixtureCandidateId: proof.syntheticFixtureCandidateId,
    syntheticFixtureMarkerSha256: proof.syntheticFixtureMarkerSha256,
    syntheticFixtureCandidateRowVersion: proof.syntheticFixtureCandidateRowVersion,
    syntheticFixtureItemRowVersion: proof.itemRowVersion,
  };
}

export async function readSyntheticCorrectionRetirementInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  itemId: string,
  guard: SyntheticCorrectionRetirementGuard,
) {
  const proof = await readSyntheticCorrectionStateInTx(
    tx,
    ctx,
    guard.correction,
    guard.candidateId,
    'revoked',
  );
  if (proof.itemId !== itemId || proof.itemRowVersion === guard.expectedItemRowVersion)
    throw new ForbiddenException('Synthetic correction retirement version does not match');
  const rows = await tx.$queryRaw<Array<{ transitionAuditId: string; cleanupIntentId: string }>>`
    SELECT a.id::text AS "transitionAuditId",o.id::text AS "cleanupIntentId"
    FROM memory_items mi
    JOIN memory_transition_audit a ON a.tenant_id=mi.tenant_id AND a.memory_item_id=mi.id
      AND a.actor_user_id=mi.revoked_by AND a.from_status='active' AND a.to_status='revoked' AND a.reason_code='revoked'
      AND a.metadata_jsonb->>'verb'='forget' AND a.metadata_jsonb->>'priorGovernedStatus'='active'
      AND a.metadata_jsonb->>'syntheticFixtureRevokedAtEpoch'=extract(epoch from mi.revoked_at)::text
      AND a.metadata_jsonb->>'syntheticFixtureCandidateId'=${proof.syntheticFixtureCandidateId}
      AND a.metadata_jsonb->>'syntheticFixtureMarkerSha256'=${proof.syntheticFixtureMarkerSha256}
      AND a.metadata_jsonb->>'syntheticFixtureCandidateRowVersion'=${proof.syntheticFixtureCandidateRowVersion}
      AND a.metadata_jsonb->>'syntheticFixtureItemRowVersion'=${guard.expectedItemRowVersion}
    JOIN memory_cleanup_outbox o ON o.tenant_id=mi.tenant_id AND o.memory_item_id=mi.id
      AND o.operation='revoke_projections' AND o.idempotency_key='revoke:'||mi.id::text AND o.clio_memory_id IS NULL
    WHERE mi.tenant_id=${ctx.tenantId}::uuid AND mi.id=${itemId}::uuid
      AND NOT EXISTS (SELECT 1 FROM context_embeddings e WHERE e.source_type='memory_item' AND e.source_id=mi.id::text)
    FOR UPDATE OF mi,a,o
  `;
  if (rows.length !== 1 || !rows[0])
    throw new ForbiddenException('Synthetic correction retirement evidence does not match');
  return { ...proof, ...rows[0], retained: true as const };
}

/** Additional fixture fences on the existing immutable owner's transaction.
 * They never replace ordinary lifecycle, reviewer, wall or source authorization.
 */
export async function assertSyntheticCorrectionInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  sourceItemId: string,
  content: string,
  guard: SyntheticMemoryCorrectionGuard,
  candidateId?: string,
): Promise<SyntheticCorrectionAudit | undefined> {
  const deny = (): never => {
    throw new ForbiddenException('Synthetic immutable correction guard does not match');
  };
  if (
    !memoryReviewSurfaceEnabled() ||
    !memoryGovernanceCenterEnabled() ||
    !guard ||
    guard.sourceItemId !== sourceItemId ||
    typeof guard.expectedContent !== 'string' ||
    !guard.expectedContent.trim() ||
    guard.expectedContent !== content ||
    content !== content.trim() ||
    typeof guard.proposerUserId !== 'string' ||
    !guard.proposerUserId ||
    (candidateId === undefined && guard.proposerUserId !== ctx.userId)
  )
    deny();
  // Locks and verifies original owned candidate, item, client/wall dependencies
  // and projection, including their expected versions and exact synthetic data.
  const proof = await assertSyntheticApprovedMemoryInTx(tx, ctx, sourceItemId, guard.source);
  if (candidateId === undefined) return;
  if (
    !/^[0-9]{1,10}$/u.test(guard.expectedCandidateRowVersion ?? '') ||
    Number(guard.expectedCandidateRowVersion) > 0xffffffff
  )
    deny();
  const sources = await tx.$queryRaw<Array<{ title: string; type: string; slug: string }>>`
    SELECT title,type,slug FROM memory_items
    WHERE tenant_id=${ctx.tenantId}::uuid AND id=${sourceItemId}::uuid FOR UPDATE
  `;
  const source = sources[0];
  if (sources.length !== 1 || !source) return deny();
  const expectedPayload = {
    key: source.title,
    value: content,
    source: 'memory_correction',
    scope: guard.source.expectedPayload.scope,
    ownerUserId: guard.source.expectedPayload.ownerUserId,
    clientId: guard.source.expectedPayload.clientId,
    canonicalItem: {
      type: source.type,
      slug: immutableMemoryVersionSlug(source.slug, candidateId),
      title: source.title,
      sections: [{ key: 'memory', heading: 'Memory', owner: 'human', body: content }],
    },
    versionProposal: { kind: 'correction', sourceItemId, targetItemId: sourceItemId },
  };
  const rows = await tx.$queryRaw<Array<{ payload: Record<string, unknown> }>>`
    SELECT payload_jsonb AS payload FROM memory_candidate
    WHERE tenant_id=${ctx.tenantId}::uuid AND id=${candidateId}::uuid
      AND xmin::text=${guard.expectedCandidateRowVersion}
      AND proposed_by=${guard.proposerUserId}::uuid AND source_kind='memory_correction'
      AND scope=${guard.source.expectedPayload.scope === 'user_private' ? 'personal' : (guard.source.expectedPayload.scope as string)}
      AND client_id IS NOT DISTINCT FROM ${guard.source.expectedPayload.clientId as string | null}::uuid
      AND asserted_by_user_id=proposed_by
      AND status='pending' AND governed_status='pending_review'
      AND source_type='user_message' AND source_id=${sourceItemId}
      AND source_ref='memory_correction' AND source_version=${`candidate:${candidateId}`}
      AND source_content_hash=encode(sha256(convert_to(${content},'UTF8')),'hex')
      AND origin_surface='memory_correction' AND origin_trace_id=${candidateId}
      AND provenance_jsonb=${JSON.stringify({ kind: 'correction', sourceItemId })}::jsonb
      AND payload_jsonb=${JSON.stringify(expectedPayload)}::jsonb
      AND committed_memory_item_id IS NULL AND committed_memory_id IS NULL
      AND approved_at IS NULL AND approved_by_user_id IS NULL
      AND instructions_allowed=false AND legal_hold=false AND conflict_status='none'
    FOR UPDATE
  `;
  if (rows.length !== 1) deny();
  return {
    ...proof,
    syntheticFixtureRootItemId: sourceItemId,
    syntheticFixtureCorrectionCandidateRowVersion: guard.expectedCandidateRowVersion!,
    syntheticFixtureContentSha256: createHash('sha256').update(content).digest('hex'),
  };
}
