import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { buildCanonicalGovernance } from './memory-canonical-activation.helpers.js';
import {
  validateSyntheticCandidateFixtureIdentity,
  type SyntheticCandidateWithdrawalGuard,
} from './synthetic-candidate-withdrawal.helpers.js';

export interface SyntheticApprovedMemoryGuard extends SyntheticCandidateWithdrawalGuard {
  candidateId: string;
  expectedItemRowVersion: string;
}

export interface SyntheticMemoryRevocationAudit {
  syntheticFixtureCandidateId: string;
  syntheticFixtureMarkerSha256: string;
  syntheticFixtureCandidateRowVersion: string;
  syntheticFixtureItemRowVersion: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function deny(): never {
  throw new ForbiddenException('Approved synthetic memory guard does not match');
}

/**
 * Additional identity/content fences, never a replacement for the store's
 * current actor authorization. Lock candidate, item and projection on the
 * caller's revocation transaction; preserve the approved candidate unchanged.
 */
export async function assertSyntheticApprovedMemoryInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  itemId: string,
  guard: SyntheticApprovedMemoryGuard,
): Promise<SyntheticMemoryRevocationAudit> {
  return validateSyntheticApprovedMemoryInTx(tx, ctx, itemId, guard);
}

export interface SyntheticMemoryRetirementProof extends SyntheticMemoryRevocationAudit {
  itemId: string;
  candidateId: string;
  rowVersion: string;
  transitionAuditId: string;
  cleanupIntentId: string;
  status: 'revoked';
  governedStatus: 'revoked';
  retained: true;
}

/** Verify retained state, never infer successful retirement from a write response. */
export async function readSyntheticMemoryRetirementInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  itemId: string,
  guard: SyntheticApprovedMemoryGuard,
): Promise<SyntheticMemoryRetirementProof> {
  const audit = await validateSyntheticApprovedMemoryInTx(tx, ctx, itemId, guard, true);
  const proofs = await tx.$queryRaw<
    Array<{ rowVersion: string; transitionAuditId: string; cleanupIntentId: string }>
  >`
    SELECT mi.xmin::text AS "rowVersion", a.id::text AS "transitionAuditId",
           o.id::text AS "cleanupIntentId"
    FROM memory_items mi
    JOIN memory_transition_audit a ON a.tenant_id=mi.tenant_id AND a.memory_item_id=mi.id
    JOIN memory_cleanup_outbox o ON o.tenant_id=mi.tenant_id AND o.memory_item_id=mi.id
    WHERE mi.tenant_id=${ctx.tenantId}::uuid AND mi.id=${itemId}::uuid
      AND mi.revoked_by IS NOT NULL AND mi.revoked_at IS NOT NULL
      AND a.actor_user_id=mi.revoked_by AND a.effective_tenant_id=mi.tenant_id
      AND a.occurred_at=mi.revoked_at
      AND a.memory_candidate_id IS NULL AND a.client_id IS NOT DISTINCT FROM mi.client_id
      AND a.from_status='active' AND a.to_status='revoked' AND a.reason_code='revoked'
      AND a.metadata_jsonb->>'verb'='forget' AND a.metadata_jsonb->>'priorGovernedStatus'='active'
      AND a.metadata_jsonb->>'syntheticFixtureCandidateId'=${guard.candidateId}
      AND a.metadata_jsonb->>'syntheticFixtureMarkerSha256'=${audit.syntheticFixtureMarkerSha256}
      AND a.metadata_jsonb->>'syntheticFixtureCandidateRowVersion'=${guard.expectedRowVersion}
      AND a.metadata_jsonb->>'syntheticFixtureItemRowVersion'=${guard.expectedItemRowVersion}
      AND o.operation='revoke_projections' AND o.idempotency_key=${`revoke:${itemId}`}
      AND mi.slug='clio:' || o.clio_memory_id::text
      AND NOT EXISTS (SELECT 1 FROM context_embeddings e WHERE e.source_type='memory_item' AND e.source_id=${itemId})
  `;
  if (proofs.length !== 1 || !proofs[0]) deny();
  return {
    ...audit,
    ...proofs[0],
    itemId,
    candidateId: guard.candidateId,
    status: 'revoked',
    governedStatus: 'revoked',
    retained: true,
  };
}

async function validateSyntheticApprovedMemoryInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  itemId: string,
  guard: SyntheticApprovedMemoryGuard,
  retired = false,
): Promise<SyntheticMemoryRevocationAudit> {
  if (
    !guard ||
    !UUID.test(guard.candidateId ?? '') ||
    !UUID.test(itemId) ||
    typeof guard.expectedRowVersion !== 'string' ||
    !/^[0-9]{1,10}$/u.test(guard.expectedRowVersion) ||
    Number(guard.expectedRowVersion) > 0xffffffff ||
    typeof guard.expectedItemRowVersion !== 'string' ||
    !/^[0-9]{1,10}$/u.test(guard.expectedItemRowVersion) ||
    Number(guard.expectedItemRowVersion) > 0xffffffff
  )
    deny();
  const candidates = await tx.$queryRaw<
    Array<{ proposedBy: string; approvedBy: string; clioId: string }>
  >`
    SELECT proposed_by::text AS "proposedBy", approved_by_user_id::text AS "approvedBy",
           committed_memory_id::text AS "clioId"
    FROM memory_candidate
    WHERE tenant_id=${ctx.tenantId}::uuid AND id=${guard.candidateId}::uuid
      AND xmin::text=${guard.expectedRowVersion} AND status='approved' AND governed_status='active'
      AND committed_memory_item_id=${itemId}::uuid AND committed_memory_id IS NOT NULL
      AND source_kind='model_extraction' AND source_type='meri_synthetic_fixture'
      AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL
      AND decided_by=approved_by_user_id AND decided_at=approved_at
      AND legal_hold=false AND instructions_allowed=false AND confidence IS NULL
      AND revision_number=1 AND revision_root_id IS NULL AND predecessor_candidate_id IS NULL
      AND superseded_by_id IS NULL AND duplicate_of_id IS NULL AND contradicts_id IS NULL
      AND duplicate_memory_item_id IS NULL AND contradicts_memory_item_id IS NULL
      AND second_approved_by_user_id IS NULL AND second_approved_at IS NULL
      AND conflict_status='none' AND conflict_group_id IS NULL AND controlling_item_id IS NULL
      AND retention_policy_jsonb IS NULL AND expires_at IS NULL AND valid_until IS NULL
    FOR UPDATE
  `;
  const candidate = candidates[0];
  if (candidates.length !== 1 || !candidate) deny();
  const expected = validateSyntheticCandidateFixtureIdentity(
    ctx.tenantId,
    candidate.proposedBy,
    guard.candidateId,
    guard,
  );
  const membership = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT tm.user_id::text AS id FROM tenant_memberships tm JOIN tenants t ON t.id=tm.tenant_id
    WHERE tm.tenant_id=${ctx.tenantId}::uuid AND tm.user_id=${ctx.userId}::uuid
      AND tm.status='active' AND tm.role=${ctx.role}
      AND t.slug=${expected.tenantSlug}
    FOR SHARE OF tm,t
  `;
  if (membership.length !== 1) deny();
  if (expected.clientId) {
    await tx.$queryRaw`SELECT id FROM clients WHERE tenant_id=${ctx.tenantId}::uuid AND id=${expected.clientId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT user_id FROM client_memory_access WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${expected.clientId}::uuid AND user_id=${ctx.userId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM memory_access_grant WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${expected.clientId}::uuid AND user_id=${ctx.userId}::uuid FOR SHARE`;
  }
  const record = {
    key: expected.payload.key as string,
    value: expected.payload.value as string,
    source: 'meri_synthetic_fixture',
    scope: expected.payload.scope as 'firm' | 'client' | 'user_private',
    ownerUserId: expected.payload.ownerUserId as string | null,
    clientId: expected.clientId,
    sourceExcerpt: expected.sourceExcerpt,
  };
  const governance = buildCanonicalGovernance({
    record,
    sourceKind: 'model_extraction',
    candidateId: guard.candidateId,
    assertedByUserId: candidate.proposedBy,
    approvedByUserId: candidate.approvedBy,
    decision: 'approved',
  });
  const provenance = {
    tool: 'save_memory',
    tenantId: ctx.tenantId,
    userId: candidate.proposedBy,
    sourceConversationId: null,
    sourceMessageId: null,
    sourceExcerpt: expected.sourceExcerpt,
  };
  const matching = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM memory_candidate WHERE id=${guard.candidateId}::uuid AND tenant_id=${ctx.tenantId}::uuid
      AND source_id=${expected.markerSha256} AND scope=${expected.scope}
      AND client_id IS NOT DISTINCT FROM ${expected.clientId}::uuid
      AND payload_jsonb=${JSON.stringify(expected.payload)}::jsonb AND provenance_jsonb=${JSON.stringify(provenance)}::jsonb
      AND memory_class=${governance.memoryClass} AND memory_authority=${governance.memoryAuthority}
      AND memory_scope=${governance.memoryScope}
  `;
  if (matching.length !== 1) deny();
  const sections = [
    { key: 'memory', heading: 'Memory', owner: 'human', body: record.value.trim() },
  ];
  const items = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM memory_items WHERE id=${itemId}::uuid AND tenant_id=${ctx.tenantId}::uuid
      AND ((${retired}=false AND xmin::text=${guard.expectedItemRowVersion})
        OR (${retired}=true AND xmin::text<>${guard.expectedItemRowVersion}))
      AND status=${retired ? 'revoked' : 'active'} AND governed_status=${retired ? 'revoked' : 'active'}
      AND slug=${`clio:${candidate.clioId}`} AND type=${governance.canonicalType} AND title=${record.key}
      AND visibility=${record.scope === 'user_private' ? 'user' : 'tenant'}
      AND owner_user_id IS NOT DISTINCT FROM ${record.ownerUserId}::uuid
      AND client_id IS NOT DISTINCT FROM ${record.clientId}::uuid
      AND sections_jsonb=${JSON.stringify(sections)}::jsonb AND source='manual' AND provenance='human'
      AND source_ref='meri_synthetic_fixture' AND source_type=${governance.sourceType}
      AND source_id=${guard.candidateId} AND source_version=${governance.sourceVersion}
      AND source_excerpt=${governance.sourceExcerpt} AND source_content_hash=${governance.sourceContentHash}
      AND memory_class=${governance.memoryClass} AND memory_authority=${governance.memoryAuthority}
      AND memory_scope=${governance.memoryScope} AND asserted_by_user_id=${candidate.proposedBy}::uuid
      AND approved_by_user_id=${candidate.approvedBy}::uuid AND approved_at IS NOT NULL
      AND legal_hold=false AND instructions_allowed=false AND retention_policy_jsonb IS NULL
      AND second_approved_by_user_id IS NULL AND second_approved_at IS NULL
      AND conflict_status='none' AND conflict_group_id IS NULL AND controlling_item_id IS NULL
      AND expires_at IS NULL AND valid_until IS NULL AND confidence IS NULL
      AND review_due_at IS NULL AND review_state='confirmed' AND last_confirmed_at=approved_at
      AND sensitivity='normal' AND schema_version=1 AND entity_id IS NULL
      AND aliases=ARRAY[]::text[] AND tags=ARRAY['memory','meri_synthetic_fixture']::text[]
    FOR UPDATE
  `;
  if (items.length !== 1) deny();
  if (retired) {
    const remaining = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM clio_memory WHERE id=${candidate.clioId}::uuid AND tenant_id=${ctx.tenantId}::uuid
      FOR UPDATE
    `;
    if (remaining.length !== 0) deny();
    return {
      syntheticFixtureCandidateId: guard.candidateId,
      syntheticFixtureMarkerSha256: expected.markerSha256,
      syntheticFixtureCandidateRowVersion: guard.expectedRowVersion,
      syntheticFixtureItemRowVersion: guard.expectedItemRowVersion,
    };
  }
  const projections = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM clio_memory WHERE id=${candidate.clioId}::uuid AND tenant_id=${ctx.tenantId}::uuid
      AND key=${record.key} AND value=${record.value} AND source='meri_synthetic_fixture' AND scope=${record.scope}
      AND owner_user_id IS NOT DISTINCT FROM ${record.ownerUserId}::uuid
      AND client_id IS NOT DISTINCT FROM ${record.clientId}::uuid AND expires_at IS NULL
      AND metadata_jsonb->>'sourceExcerpt'=${expected.sourceExcerpt}
      AND metadata_jsonb->'governance'->>'sourceId'=${guard.candidateId}
      AND metadata_jsonb->'governance'->>'sourceVersion'=${governance.sourceVersion}
    FOR UPDATE
  `;
  if (projections.length !== 1) deny();
  return {
    syntheticFixtureCandidateId: guard.candidateId,
    syntheticFixtureMarkerSha256: expected.markerSha256,
    syntheticFixtureCandidateRowVersion: guard.expectedRowVersion,
    syntheticFixtureItemRowVersion: guard.expectedItemRowVersion,
  };
}
