import { ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { clientMemoryAllowed } from './memory-wall.helpers.js';

export interface SyntheticCandidateWithdrawalGuard {
  expectedRowVersion: string;
  expectedPayload: Record<string, unknown>;
}

const NAMESPACE = 'meri-foundation-20260928';
const TENANTS: Record<string, string> = {
  'f2d6cf8f-057c-479a-8110-62fe5086d43f': `${NAMESPACE}-t1`,
  '52e91176-08f0-4d89-9633-bc212f5bdbbf': `${NAMESPACE}-t2`,
};
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function denied(): never {
  throw new ForbiddenException('Synthetic candidate withdrawal guard does not match');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return denied();
  return value as Record<string, unknown>;
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Content identity only. The transaction below still checks the current actor and row. */
function validateGuard(
  tenantId: string,
  userId: string,
  candidateId: string,
  guard: SyntheticCandidateWithdrawalGuard,
) {
  if (process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== NAMESPACE || !TENANTS[tenantId]) denied();
  if (
    !guard ||
    typeof guard.expectedRowVersion !== 'string' ||
    !/^[0-9]{1,10}$/u.test(guard.expectedRowVersion) ||
    Number(guard.expectedRowVersion) > 0xffffffff
  )
    denied();
  const payload = object(guard.expectedPayload);
  if (typeof payload.sourceExcerpt !== 'string' || payload.sourceExcerpt.length > 4000) denied();
  let metadata: Record<string, unknown>;
  try {
    metadata = object(JSON.parse(payload.sourceExcerpt));
  } catch {
    return denied();
  }
  const ownership = object(metadata.ownership);
  const marker = object(ownership.marker);
  if (
    typeof marker.fixtureVersion !== 'string' ||
    !/^[A-Za-z0-9._-]{1,80}$/u.test(marker.fixtureVersion) ||
    typeof marker.logicalId !== 'string' ||
    !/^[A-Z][A-Z0-9-]{0,100}$/u.test(marker.logicalId) ||
    (marker.fixtureInstanceId !== undefined &&
      (typeof marker.fixtureInstanceId !== 'string' || !UUID4.test(marker.fixtureInstanceId)))
  )
    denied();
  const expectedMarker = {
    contractVersion: 'meri-synthetic-fixture-provisioning-v1',
    fixtureNamespace: NAMESPACE,
    fixtureVersion: marker.fixtureVersion,
    logicalId: marker.logicalId,
    owner: 'memory_candidate',
    tenantId,
    ...(marker.fixtureInstanceId === undefined
      ? {}
      : { fixtureInstanceId: marker.fixtureInstanceId }),
  };
  const canonicalMarker = Object.fromEntries(
    Object.keys(expectedMarker)
      .sort()
      .map((key) => [key, object(expectedMarker)[key]]),
  );
  const actualMarker = Object.fromEntries(
    Object.keys(marker)
      .sort()
      .map((key) => [key, marker[key]]),
  );
  const markerSha256 = digest(canonicalMarker);
  const parts = [
    NAMESPACE,
    marker.fixtureVersion,
    tenantId,
    'memory_candidate',
    marker.logicalId,
    ...(marker.fixtureInstanceId === undefined ? [] : [marker.fixtureInstanceId]),
  ];
  const bytes = Buffer.from(digest(parts).slice(0, 32), 'hex');
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  const physicalId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const key =
    marker.fixtureInstanceId === undefined
      ? `${NAMESPACE}:${marker.logicalId}`
      : `${NAMESPACE}:${marker.fixtureInstanceId}:${marker.logicalId}`;
  if (
    JSON.stringify(actualMarker) !== JSON.stringify(canonicalMarker) ||
    ownership.markerSha256 !== markerSha256 ||
    ownership.physicalId !== physicalId ||
    candidateId !== physicalId ||
    payload.key !== key ||
    payload.source !== 'meri_synthetic_fixture' ||
    typeof payload.value !== 'string' ||
    !['firm', 'client', 'user_private'].includes(String(payload.scope)) ||
    payload.ownerUserId !== (payload.scope === 'user_private' ? userId : null) ||
    (payload.scope === 'client'
      ? typeof payload.clientId !== 'string'
      : payload.clientId !== null) ||
    ['expiresAt', 'confidence', 'sourceConversationId', 'sourceMessageId', 'canonicalItem'].some(
      (field) => payload[field] !== null,
    )
  )
    denied();
  return {
    payload,
    markerSha256,
    sourceExcerpt: payload.sourceExcerpt as string,
    scope: payload.scope === 'user_private' ? 'personal' : String(payload.scope),
    clientId: payload.clientId as string | null,
  };
}

/** Called only after the ordinary proposer-only path has locked the pending candidate. */
export async function assertSyntheticCandidateWithdrawalInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
  candidateId: string,
  guard: SyntheticCandidateWithdrawalGuard,
): Promise<{ syntheticFixtureMarkerSha256: string; syntheticFixturePriorRowVersion: string }> {
  const expected = validateGuard(tenantId, userId, candidateId, guard);
  const membership = await tx.$queryRaw<Array<{ user_id: string }>>`
    SELECT tm.user_id::text AS user_id FROM tenant_memberships tm
    JOIN tenants t ON t.id=tm.tenant_id
    WHERE tm.tenant_id=${tenantId}::uuid AND tm.user_id=${userId}::uuid
      AND tm.status='active' AND t.slug=${TENANTS[tenantId]}
    FOR SHARE OF tm,t
  `;
  if (membership.length !== 1) denied();
  if (expected.clientId) {
    await tx.$queryRaw`SELECT id FROM clients WHERE tenant_id=${tenantId}::uuid AND id=${expected.clientId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT user_id FROM client_memory_access WHERE tenant_id=${tenantId}::uuid
      AND client_id=${expected.clientId}::uuid AND user_id=${userId}::uuid FOR SHARE`;
    if (!(await clientMemoryAllowed(tx, tenantId, userId, expected.clientId))) denied();
  }
  const provenance = {
    tool: 'save_memory',
    tenantId,
    userId,
    sourceConversationId: null,
    sourceMessageId: null,
    sourceExcerpt: expected.sourceExcerpt,
  };
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id::text AS id FROM memory_candidate
    WHERE id=${candidateId}::uuid AND tenant_id=${tenantId}::uuid AND proposed_by=${userId}::uuid
      AND xmin::text=${guard.expectedRowVersion} AND status='pending' AND governed_status='suggested'
      AND source_kind='model_extraction' AND source_type='meri_synthetic_fixture'
      AND source_id=${expected.markerSha256} AND scope=${expected.scope}
      AND client_id IS NOT DISTINCT FROM ${expected.clientId}::uuid
      AND payload_jsonb=${JSON.stringify(expected.payload)}::jsonb
      AND provenance_jsonb=${JSON.stringify(provenance)}::jsonb
      AND legal_hold=false AND instructions_allowed=false
      AND memory_class='legacy_unclassified' AND memory_authority='legacy_unclassified'
      AND approved_at IS NULL AND approved_by_user_id IS NULL
      AND second_approved_at IS NULL AND second_approved_by_user_id IS NULL
      AND decided_at IS NULL AND decided_by IS NULL
      AND committed_memory_id IS NULL AND committed_memory_item_id IS NULL
      AND revision_root_id IS NULL AND predecessor_candidate_id IS NULL AND superseded_by_id IS NULL
      AND revision_number=1 AND duplicate_of_id IS NULL AND contradicts_id IS NULL
      AND duplicate_memory_item_id IS NULL AND contradicts_memory_item_id IS NULL
      AND conflict_status='none' AND conflict_group_id IS NULL
      AND confidence IS NULL AND memory_scope='firm' AND sensitivity='normal'
      AND source_ref IS NULL AND source_excerpt IS NULL AND source_content_hash IS NULL
      AND source_version IS NULL AND asserted_by_user_id IS NULL
      AND as_of IS NULL AND effective_from IS NULL AND valid_until IS NULL AND expires_at IS NULL
      AND review_cadence_days IS NULL AND review_due_at IS NULL AND controlling_item_id IS NULL
      AND retention_policy_jsonb IS NULL AND origin_surface IS NULL AND origin_trace_id IS NULL
      AND origin_context_packet_id IS NULL AND origin_model IS NULL AND origin_prompt_version IS NULL
  `;
  if (rows.length !== 1) denied();
  return {
    syntheticFixtureMarkerSha256: expected.markerSha256,
    syntheticFixturePriorRowVersion: guard.expectedRowVersion,
  };
}
