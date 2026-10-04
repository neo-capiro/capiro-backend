import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { buildCanonicalGovernance } from './memory-canonical-activation.helpers.js';
import {
  validateSyntheticCandidateFixtureIdentity,
  type SyntheticCandidateWithdrawalGuard,
} from './synthetic-candidate-withdrawal.helpers.js';
import type {
  SyntheticApprovedMemoryGuard,
  SyntheticMemoryRevocationAudit,
} from './synthetic-approved-memory.helpers.js';

/** Native read-only set verifier for the fixed 510-row Case 12 inventory. */
export async function assertCase12SyntheticApprovedMemorySetInTx(
  tx: Prisma.TransactionClient,
  suppliedContext: TenantContext,
  suppliedEntries: readonly { itemId: string; guard: SyntheticApprovedMemoryGuard }[],
): Promise<SyntheticMemoryRevocationAudit[]> {
  function deny(): never {
    throw new ForbiddenException('Approved synthetic memory guard does not match');
  }
  const ctx = structuredClone(suppliedContext);
  const entries = structuredClone(suppliedEntries);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const version = /^[0-9]{1,10}$/u;
  const tenantSlug = 'meri-foundation-20260928-t1';
  if (
    !Array.isArray(entries) || entries.length !== 510 ||
    typeof ctx?.tenantId !== 'string' || !uuid.test(ctx.tenantId) ||
    ctx.tenantId !== 'f2d6cf8f-057c-479a-8110-62fe5086d43f' ||
    typeof ctx?.userId !== 'string' || !uuid.test(ctx.userId) ||
    ctx.role !== 'standard_user'
  ) deny();

  const itemIds = new Set<string>();
  const candidateIds = new Set<string>();
  const baseRows: Array<{ candidateId: string; itemId: string; candidateVersion: string; itemVersion: string }> = [];
  for (const entry of entries) {
    const itemId = entry?.itemId;
    const guard = entry?.guard;
    if (
      !entry || Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'itemId') || !Object.hasOwn(entry, 'guard') ||
      !guard || Object.keys(guard).length !== 4 ||
      !['candidateId', 'expectedRowVersion', 'expectedItemRowVersion', 'expectedPayload'].every((key) => Object.hasOwn(guard, key)) ||
      typeof itemId !== 'string' || !uuid.test(itemId) || itemIds.has(itemId) ||
      typeof guard.candidateId !== 'string' || !uuid.test(guard.candidateId) || candidateIds.has(guard.candidateId) ||
      typeof guard.expectedRowVersion !== 'string' || !version.test(guard.expectedRowVersion) || Number(guard.expectedRowVersion) > 0xffffffff ||
      typeof guard.expectedItemRowVersion !== 'string' || !version.test(guard.expectedItemRowVersion) || Number(guard.expectedItemRowVersion) > 0xffffffff ||
      !guard.expectedPayload || typeof guard.expectedPayload !== 'object' || Array.isArray(guard.expectedPayload) ||
      typeof guard.expectedPayload.key !== 'string' || typeof guard.expectedPayload.value !== 'string' ||
      typeof guard.expectedPayload.source !== 'string' || typeof guard.expectedPayload.sourceExcerpt !== 'string' ||
      typeof guard.expectedPayload.scope !== 'string' ||
      (guard.expectedPayload.ownerUserId !== null && typeof guard.expectedPayload.ownerUserId !== 'string') ||
      (guard.expectedPayload.clientId !== null && typeof guard.expectedPayload.clientId !== 'string') ||
      ['expiresAt', 'confidence', 'sourceConversationId', 'sourceMessageId', 'canonicalItem'].some((key) => guard.expectedPayload[key] !== null)
    ) deny();
    itemIds.add(itemId);
    candidateIds.add(guard.candidateId);
    baseRows.push({ candidateId: guard.candidateId, itemId, candidateVersion: guard.expectedRowVersion, itemVersion: guard.expectedItemRowVersion });
  }
  const baseJson = JSON.stringify(baseRows);
  const candidates = await tx.$queryRaw<Array<{
    id: string; tenantId: string; proposedBy: string; approvedBy: string | null;
    clioId: string | null; rowVersion: string;
  }>>`
    WITH wanted AS (
      SELECT * FROM jsonb_to_recordset(${baseJson}::jsonb) AS x(
        "candidateId" uuid,"itemId" uuid,"candidateVersion" text,"itemVersion" text
      )
    )
    SELECT c.id::text AS "id",c.tenant_id::text AS "tenantId",c.proposed_by::text AS "proposedBy",
      c.approved_by_user_id::text AS "approvedBy",c.committed_memory_id::text AS "clioId",c.xmin::text AS "rowVersion"
    FROM wanted w JOIN memory_candidate c ON c.id=w."candidateId" AND c.tenant_id=${ctx.tenantId}::uuid
    WHERE c.xmin::text=w."candidateVersion" AND c.status='approved' AND c.governed_status='active'
      AND c.committed_memory_item_id=w."itemId" AND c.committed_memory_id IS NOT NULL
      AND c.source_kind='model_extraction' AND c.source_type='meri_synthetic_fixture'
      AND c.approved_by_user_id IS NOT NULL AND c.approved_at IS NOT NULL
      AND c.decided_by=c.approved_by_user_id AND c.decided_at=c.approved_at
      AND c.legal_hold=false AND c.instructions_allowed=false AND c.confidence IS NULL
      AND c.revision_number=1 AND c.revision_root_id IS NULL AND c.predecessor_candidate_id IS NULL
      AND c.superseded_by_id IS NULL AND c.duplicate_of_id IS NULL AND c.contradicts_id IS NULL
      AND c.duplicate_memory_item_id IS NULL AND c.contradicts_memory_item_id IS NULL
      AND c.second_approved_by_user_id IS NULL AND c.second_approved_at IS NULL
      AND c.conflict_status='none' AND c.conflict_group_id IS NULL AND c.controlling_item_id IS NULL
      AND c.retention_policy_jsonb IS NULL AND c.expires_at IS NULL AND c.valid_until IS NULL
    FOR UPDATE OF c
  `;
  if (candidates.length !== 510) deny();
  const candidateById = new Map(candidates.map((row) => [row.id, row]));
  if (candidateById.size !== 510) deny();

  type Expected = {
    itemId: string; guard: SyntheticApprovedMemoryGuard; markerSha256: string;
    expected: ReturnType<typeof validateSyntheticCandidateFixtureIdentity>;
    governance: ReturnType<typeof buildCanonicalGovernance>;
    record: { key: string; value: string; source: string; scope: 'firm' | 'client' | 'user_private'; ownerUserId: string | null; clientId: string | null; sourceExcerpt: string };
    provenance: Record<string, unknown>;
  };
  const expectedByCandidate = new Map<string, Expected>();
  const exactRows: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    const { itemId, guard } = entry;
    const candidate = candidateById.get(guard.candidateId);
    if (!candidate || candidate.tenantId !== ctx.tenantId || !candidate.approvedBy || !candidate.clioId) deny();
    const expected = validateSyntheticCandidateFixtureIdentity(ctx.tenantId, candidate.proposedBy, guard.candidateId, guard as SyntheticCandidateWithdrawalGuard);
    const payload = expected.payload;
    const record = {
      key: payload.key as string, value: payload.value as string, source: 'meri_synthetic_fixture',
      scope: payload.scope as 'firm' | 'client' | 'user_private', ownerUserId: payload.ownerUserId as string | null,
      clientId: expected.clientId, sourceExcerpt: expected.sourceExcerpt,
    };
    const governance = buildCanonicalGovernance({ record, sourceKind: 'model_extraction', candidateId: guard.candidateId,
      assertedByUserId: candidate.proposedBy, approvedByUserId: candidate.approvedBy, decision: 'approved' });
    const provenance = { tool: 'save_memory', tenantId: ctx.tenantId, userId: candidate.proposedBy,
      sourceConversationId: null, sourceMessageId: null, sourceExcerpt: expected.sourceExcerpt };
    expectedByCandidate.set(guard.candidateId, { itemId, guard, markerSha256: expected.markerSha256, expected, governance, record, provenance });
    exactRows.push({
      candidateId: guard.candidateId, itemId, expectedRowVersion: guard.expectedRowVersion,
      expectedItemRowVersion: guard.expectedItemRowVersion, proposedBy: candidate.proposedBy,
      approvedBy: candidate.approvedBy, clioId: candidate.clioId, sourceId: expected.markerSha256,
      scope: expected.scope, clientId: expected.clientId, payload: expected.payload, provenance,
      tenantSlug: expected.tenantSlug,
      memoryClass: governance.memoryClass, memoryAuthority: governance.memoryAuthority, memoryScope: governance.memoryScope,
      canonicalType: governance.canonicalType, sourceType: governance.sourceType, sourceVersion: governance.sourceVersion,
      sourceExcerpt: governance.sourceExcerpt, sourceContentHash: governance.sourceContentHash,
      projectionSourceExcerpt: expected.sourceExcerpt,
      key: record.key, value: record.value, recordScope: record.scope, ownerUserId: record.ownerUserId,
      recordClientId: record.clientId, sections: [{ key: 'memory', heading: 'Memory', owner: 'human', body: record.value.trim() }],
    });
  }
  const exactJson = JSON.stringify(exactRows);

  // Scalar membership predicate, locked once; lock matching exact client/wall/grant rows once too.
  const scopeJson = JSON.stringify({ tenantId: ctx.tenantId, userId: ctx.userId, role: ctx.role, tenantSlug,
    clientIds: [...new Set([...expectedByCandidate.values()].map((x) => x.expected.clientId).filter((x): x is string => Boolean(x)))] });
  const scopeRows = await tx.$queryRaw<Array<{ kind: string; tenantId: string; userId: string | null; clientId: string | null }>>`
    WITH s AS (SELECT * FROM jsonb_to_record(${scopeJson}::jsonb) AS x("tenantId" uuid,"userId" uuid,role text,"tenantSlug" text,"clientIds" uuid[])),
    tm AS (SELECT 'membership'::text kind, tm.tenant_id,tm.user_id,NULL::uuid client_id FROM tenant_memberships tm
      JOIN tenants t ON t.id=tm.tenant_id CROSS JOIN s WHERE tm.tenant_id=s."tenantId" AND tm.user_id=s."userId"
      AND tm.status='active' AND tm.role::text=s.role AND t.slug=s."tenantSlug" FOR SHARE OF tm,t),
    cl AS (SELECT 'client'::text kind,c.tenant_id,NULL::uuid user_id,c.id client_id FROM clients c CROSS JOIN s
      WHERE c.tenant_id=s."tenantId" AND c.id=ANY(s."clientIds") FOR SHARE OF c),
    wa AS (SELECT 'wall'::text kind,a.tenant_id,a.user_id,a.client_id FROM client_memory_access a CROSS JOIN s
      WHERE a.tenant_id=s."tenantId" AND a.user_id=s."userId" AND a.client_id=ANY(s."clientIds") FOR SHARE OF a),
    gr AS (SELECT 'grant'::text kind,g.tenant_id,g.user_id,g.client_id FROM memory_access_grant g CROSS JOIN s
      WHERE g.tenant_id=s."tenantId" AND g.user_id=s."userId" AND g.client_id=ANY(s."clientIds") FOR SHARE OF g)
    SELECT kind,tenant_id::text AS "tenantId",user_id::text AS "userId",client_id::text AS "clientId" FROM tm
    UNION ALL SELECT kind,tenant_id::text,user_id::text,client_id::text FROM cl
    UNION ALL SELECT kind,tenant_id::text,user_id::text,client_id::text FROM wa
    UNION ALL SELECT kind,tenant_id::text,user_id::text,client_id::text FROM gr
  `;
  const clientIds = [...new Set([...expectedByCandidate.values()].map((x) => x.expected.clientId).filter((x): x is string => Boolean(x)))];
  if (scopeRows.filter((r) => r.kind === 'membership').length !== 1 || scopeRows.find((r) => r.kind === 'membership')?.userId !== ctx.userId ||
      scopeRows.filter((r) => r.kind === 'client').length !== clientIds.length) deny();

  const matching = await tx.$queryRaw<Array<{ candidateId: string }>>`
    WITH e AS (SELECT * FROM jsonb_to_recordset(${exactJson}::jsonb) AS x(
      "candidateId" uuid,"expectedRowVersion" text,"proposedBy" uuid,"approvedBy" uuid,"sourceId" text,scope text,
      "clientId" uuid,payload jsonb,provenance jsonb,"memoryClass" text,"memoryAuthority" text,"memoryScope" text))
    SELECT c.id::text AS "candidateId" FROM e JOIN memory_candidate c ON c.id=e."candidateId" AND c.tenant_id=${ctx.tenantId}::uuid
    WHERE c.xmin::text=e."expectedRowVersion" AND c.proposed_by=e."proposedBy" AND c.approved_by_user_id=e."approvedBy"
      AND c.source_id=e."sourceId" AND c.scope=e.scope AND c.client_id IS NOT DISTINCT FROM e."clientId"
      AND c.payload_jsonb=e.payload AND c.provenance_jsonb=e.provenance
      AND c.memory_class=e."memoryClass" AND c.memory_authority=e."memoryAuthority" AND c.memory_scope=e."memoryScope"
  `;
  if (matching.length !== 510 || new Set(matching.map((r) => r.candidateId)).size !== 510) deny();

  const items = await tx.$queryRaw<Array<{ id: string }>>`
    WITH e AS (SELECT * FROM jsonb_to_recordset(${exactJson}::jsonb) AS x(
      "candidateId" uuid,"itemId" uuid,"expectedItemRowVersion" text,"clioId" uuid,"canonicalType" text,key text,value text,
      "recordScope" text,"ownerUserId" uuid,"recordClientId" uuid,"sourceType" text,"sourceVersion" text,
      "sourceExcerpt" text,"sourceContentHash" text,"memoryClass" text,"memoryAuthority" text,"memoryScope" text,
      "proposedBy" uuid,"approvedBy" uuid,sections jsonb))
    SELECT m.id::text AS id FROM e JOIN memory_items m ON m.id=e."itemId" AND m.tenant_id=${ctx.tenantId}::uuid
    WHERE m.xmin::text=e."expectedItemRowVersion" AND m.status='active' AND m.governed_status='active'
      AND m.slug='clio:' || e."clioId"::text AND m.type=e."canonicalType" AND m.title=e.key
      AND m.visibility=CASE WHEN e."recordScope"='user_private' THEN 'user' ELSE 'tenant' END
      AND m.owner_user_id IS NOT DISTINCT FROM e."ownerUserId" AND m.client_id IS NOT DISTINCT FROM e."recordClientId"
      AND m.sections_jsonb=e.sections AND m.source='manual' AND m.provenance='human' AND m.source_ref='meri_synthetic_fixture'
      AND m.source_type=e."sourceType" AND m.source_id=e."candidateId"::text AND m.source_version=e."sourceVersion"
      AND m.source_excerpt=e."sourceExcerpt" AND m.source_content_hash=e."sourceContentHash"
      AND m.memory_class=e."memoryClass" AND m.memory_authority=e."memoryAuthority" AND m.memory_scope=e."memoryScope"
      AND m.asserted_by_user_id=e."proposedBy" AND m.approved_by_user_id=e."approvedBy" AND m.approved_at IS NOT NULL
      AND m.legal_hold=false AND m.instructions_allowed=false AND m.retention_policy_jsonb IS NULL
      AND m.second_approved_by_user_id IS NULL AND m.second_approved_at IS NULL
      AND m.conflict_status='none' AND m.conflict_group_id IS NULL AND m.controlling_item_id IS NULL
      AND m.expires_at IS NULL AND m.valid_until IS NULL AND m.confidence IS NULL
      AND m.review_due_at IS NULL AND m.review_state='confirmed' AND m.last_confirmed_at=m.approved_at
      AND m.sensitivity='normal' AND m.schema_version=1 AND m.entity_id IS NULL
      AND m.aliases=ARRAY[]::text[] AND m.tags=ARRAY['memory','meri_synthetic_fixture']::text[]
    FOR UPDATE OF m
  `;
  if (items.length !== 510 || new Set(items.map((r) => r.id)).size !== 510 || items.some((r) => !itemIds.has(r.id))) deny();

  const expectedClioIds = new Set([...expectedByCandidate.values()].map((x) => {
    const row = candidateById.get(x.guard.candidateId);
    if (!row?.clioId) deny();
    return row.clioId;
  }));
  if (expectedClioIds.size !== 510) deny();
  const clio = await tx.$queryRaw<Array<{ id: string; candidateId: string }>>`
    WITH e AS (SELECT * FROM jsonb_to_recordset(${exactJson}::jsonb) AS x(
      "candidateId" uuid,"clioId" uuid,key text,value text,"recordScope" text,"ownerUserId" uuid,
      "recordClientId" uuid,"projectionSourceExcerpt" text,"sourceVersion" text))
    SELECT c.id::text AS id,e."candidateId"::text AS "candidateId" FROM e JOIN clio_memory c ON c.id=e."clioId" AND c.tenant_id=${ctx.tenantId}::uuid
    WHERE c.key=e.key AND c.value=e.value AND c.source='meri_synthetic_fixture' AND c.scope=e."recordScope"
      AND c.owner_user_id IS NOT DISTINCT FROM e."ownerUserId" AND c.client_id IS NOT DISTINCT FROM e."recordClientId"
      AND c.expires_at IS NULL AND c.metadata_jsonb->>'sourceExcerpt'=e."projectionSourceExcerpt"
      AND c.metadata_jsonb->'governance'->>'sourceId'=e."candidateId"::text
      AND c.metadata_jsonb->'governance'->>'sourceVersion'=e."sourceVersion"
    FOR UPDATE OF c
  `;
  if (clio.length !== 510 || new Set(clio.map((r) => r.id)).size !== 510 ||
      new Set(clio.map((r) => r.candidateId)).size !== 510 ||
      clio.some((r) => !expectedClioIds.has(r.id))) deny();
  return entries.map(({ guard }) => ({
    syntheticFixtureCandidateId: guard.candidateId,
    syntheticFixtureMarkerSha256: expectedByCandidate.get(guard.candidateId)!.markerSha256,
    syntheticFixtureCandidateRowVersion: guard.expectedRowVersion,
    syntheticFixtureItemRowVersion: guard.expectedItemRowVersion,
  }));
}

export type { SyntheticApprovedMemoryGuard, SyntheticMemoryRevocationAudit };
