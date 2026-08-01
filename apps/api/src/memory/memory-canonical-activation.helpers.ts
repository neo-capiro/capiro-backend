import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { clioMemorySlug } from './memory-clio-adapter.helpers.js';
import {
  classifyCandidateForGovernance,
  type CandidateDecision,
  type LegacyCandidateScope,
} from './memory-governance-lifecycle.helpers.js';

export interface CanonicalMemoryRecord {
  scope: 'firm' | 'user_private' | 'client';
  ownerUserId: string | null;
  clientId?: string | null;
  key: string;
  value: string;
  source: string;
  expiresAt?: Date | null;
  confidence?: number | null;
  sourceConversationId?: string | null;
  sourceMessageId?: string | null;
  sourceExcerpt?: string | null;
  canonicalItem?: {
    type: string;
    slug: string;
    title: string;
    sections: Array<{ key: string; heading: string; owner: 'human' | 'engine'; body: string }>;
  };
}

export interface CanonicalGovernance {
  canonicalType: 'playbook' | 'client-compass' | 'user-profile';
  memoryClass: string;
  memoryAuthority: string;
  memoryScope: 'firm' | 'client' | 'user_private';
  governedStatus: 'active';
  sourceType: string;
  sourceId: string | null;
  sourceRef: string | null;
  sourceExcerpt: string | null;
  sourceContentHash: string;
  sourceVersion: string;
  assertedByUserId: string;
  approvedByUserId: string;
  approvedAt: Date;
  secondApprovedByUserId: string | null;
  secondApprovedAt: Date | null;
  reviewDueAt: Date | null;
  asOf: Date;
  effectiveFrom: Date;
  validUntil: Date | null;
  conflictStatus: 'none';
  conflictGroupId: string | null;
  controllingItemId: string | null;
  sensitivity: string;
  originSurface: string;
  originTraceId: string | null;
  originContextPacketId: string | null;
  originModel: string | null;
  originPromptVersion: string | null;
  instructionsAllowed: boolean;
}

export function buildCanonicalGovernance(input: {
  record: CanonicalMemoryRecord;
  sourceKind: string;
  candidateId: string;
  assertedByUserId: string;
  approvedByUserId: string;
  decision: Exclude<CandidateDecision, 'rejected'>;
  approvedAt?: Date;
}): CanonicalGovernance {
  const sourceKind = typeof input.sourceKind === 'string' ? input.sourceKind : 'unknown';
  const scope: LegacyCandidateScope =
    input.record.scope === 'user_private' ? 'personal' : input.record.scope;
  const classification = classifyCandidateForGovernance(
    { scope, sourceKind, hasTtl: Boolean(input.record.expiresAt) },
    input.decision,
  );
  if (!classification.memoryAuthority) {
    throw new Error('A committing candidate decision must produce memory authority.');
  }

  const approvedAt = input.approvedAt ?? new Date();
  const sourceContentHash = createHash('sha256')
    .update(input.record.key)
    .update('\0')
    .update(input.record.value)
    .digest('hex');
  const sourceId =
    input.record.sourceMessageId ?? input.record.sourceConversationId ?? input.candidateId;
  const sourceType =
    sourceKind === 'model_extraction'
      ? 'steward_extraction'
      : sourceKind === 'explicit_user'
        ? 'user_message'
        : sourceKind === 'settings_sections'
          ? 'approved_document_edit'
          : 'unknown';

  return {
    canonicalType: canonicalTypeForScope(classification.memoryScope),
    memoryClass: classification.memoryClass,
    memoryAuthority: classification.memoryAuthority,
    memoryScope: classification.memoryScope,
    governedStatus: 'active',
    sourceType,
    sourceId,
    sourceRef: input.record.source || null,
    sourceExcerpt: truncateUtf8(input.record.sourceExcerpt ?? null, 8_000),
    sourceContentHash,
    sourceVersion: `candidate:${input.candidateId}`.slice(0, 160),
    assertedByUserId: input.assertedByUserId,
    approvedByUserId: input.approvedByUserId,
    approvedAt,
    secondApprovedByUserId: null,
    secondApprovedAt: null,
    reviewDueAt: null,
    asOf: approvedAt,
    effectiveFrom: approvedAt,
    validUntil: input.record.expiresAt ?? null,
    conflictStatus: 'none',
    conflictGroupId: null,
    controllingItemId: null,
    sensitivity: 'normal',
    originSurface: input.record.source.slice(0, 48) || 'unknown',
    originTraceId: (
      input.record.sourceMessageId ??
      input.record.sourceConversationId ??
      input.candidateId
    ).slice(0, 160),
    originContextPacketId: null,
    originModel: sourceKind === 'model_extraction' ? 'unknown-model' : null,
    originPromptVersion: null,
    instructionsAllowed: false,
  };
}

/**
 * Governance travels with the Clio projection source so a retry/backfill cannot
 * recreate the item with generic legacy defaults. The canonical memory_items row
 * remains authoritative; this metadata exists only to preserve that authority
 * when the secondary projection is rebuilt.
 */
export function governedClioMetadata(governance: CanonicalGovernance): Record<string, unknown> {
  return {
    governance: {
      ...governance,
      approvedAt: governance.approvedAt.toISOString(),
      asOf: governance.asOf.toISOString(),
      effectiveFrom: governance.effectiveFrom.toISOString(),
      validUntil: governance.validUntil?.toISOString() ?? null,
    },
  };
}

/**
 * Upsert the authoritative governed memory item inside the candidate activation
 * transaction. Graph edges, embeddings and markdown remain outbox-backed
 * projections and are intentionally not generated here.
 *
 * A first-time shared Settings file is different from a Clio projection: once
 * any reviewer creates that catalog identity, every later change must be an
 * immutable version. Its conflict clause is therefore INSERT-ONLY. This closes
 * the race where two pending "first-time" proposals both saw no active file and
 * the second approval replaced the first via ON CONFLICT DO UPDATE.
 */
export async function upsertCanonicalMemoryItemInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  clioMemoryId: string,
  record: CanonicalMemoryRecord,
  governance: CanonicalGovernance,
): Promise<string> {
  const canonicalItem = record.canonicalItem;
  const canonicalType = canonicalItem?.type ?? governance.canonicalType;
  const canonicalSlug = canonicalItem?.slug ?? clioMemorySlug(clioMemoryId);
  const canonicalTitle = canonicalItem?.title ?? record.key;
  const canonicalSections = canonicalItem?.sections ?? [
    { key: 'memory', heading: 'Memory', owner: 'human' as const, body: record.value.trim() },
  ];
  const sections = JSON.stringify(canonicalSections);
  const visibility = record.scope === 'user_private' ? 'user' : 'tenant';
  const ownerUserId = record.scope === 'user_private' ? record.ownerUserId : null;
  const clientId = record.scope === 'client' ? (record.clientId ?? null) : null;
  const confidence =
    typeof record.confidence === 'number' && Number.isFinite(record.confidence)
      ? Math.min(1, Math.max(0, record.confidence))
      : null;
  const insertOnlySharedCatalog = Boolean(canonicalItem && record.scope !== 'user_private');
  const conflictClause = insertOnlySharedCatalog
    ? Prisma.sql`ON CONFLICT (tenant_id, type, slug) DO NOTHING`
    : Prisma.sql`
        ON CONFLICT (tenant_id, type, slug) DO UPDATE SET
          client_id = EXCLUDED.client_id,
          owner_user_id = EXCLUDED.owner_user_id,
          visibility = EXCLUDED.visibility,
          title = EXCLUDED.title,
          tags = EXCLUDED.tags,
          source = EXCLUDED.source,
          source_ref = EXCLUDED.source_ref,
          provenance = EXCLUDED.provenance,
          sections_jsonb = EXCLUDED.sections_jsonb,
          status = 'active',
          sensitivity = EXCLUDED.sensitivity,
          expires_at = EXCLUDED.expires_at,
          confidence = EXCLUDED.confidence,
          memory_class = EXCLUDED.memory_class,
          memory_authority = EXCLUDED.memory_authority,
          memory_scope = EXCLUDED.memory_scope,
          governed_status = EXCLUDED.governed_status,
          source_type = EXCLUDED.source_type,
          source_id = EXCLUDED.source_id,
          source_excerpt = EXCLUDED.source_excerpt,
          source_content_hash = EXCLUDED.source_content_hash,
          source_version = EXCLUDED.source_version,
          asserted_by_user_id = EXCLUDED.asserted_by_user_id,
          approved_by_user_id = EXCLUDED.approved_by_user_id,
          approved_at = EXCLUDED.approved_at,
          second_approved_by_user_id = EXCLUDED.second_approved_by_user_id,
          second_approved_at = EXCLUDED.second_approved_at,
          last_confirmed_at = EXCLUDED.last_confirmed_at,
          review_state = 'confirmed',
          review_due_at = EXCLUDED.review_due_at,
          retention_policy_jsonb = EXCLUDED.retention_policy_jsonb,
          as_of = EXCLUDED.as_of,
          effective_from = EXCLUDED.effective_from,
          valid_until = EXCLUDED.valid_until,
          conflict_status = EXCLUDED.conflict_status,
          conflict_group_id = EXCLUDED.conflict_group_id,
          controlling_item_id = EXCLUDED.controlling_item_id,
          origin_surface = EXCLUDED.origin_surface,
          origin_trace_id = EXCLUDED.origin_trace_id,
          origin_context_packet_id = EXCLUDED.origin_context_packet_id,
          origin_model = EXCLUDED.origin_model,
          origin_prompt_version = EXCLUDED.origin_prompt_version,
          instructions_allowed = EXCLUDED.instructions_allowed,
          updated_at = now()
      `;

  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO memory_items (
      tenant_id, client_id, owner_user_id, type, visibility, entity_id,
      slug, title, aliases, tags, source, source_ref, provenance,
      sections_jsonb, schema_version, status, sensitivity, legal_hold,
      exportable, training_use, expires_at, confidence,
      memory_class, memory_authority, memory_scope, governed_status,
      source_type, source_id, source_excerpt, source_content_hash, source_version,
      asserted_by_user_id, approved_by_user_id, approved_at,
      second_approved_by_user_id, second_approved_at, last_confirmed_at,
      review_state, review_due_at, retention_policy_jsonb,
      as_of, effective_from, valid_until, conflict_status, conflict_group_id,
      controlling_item_id, origin_surface, origin_trace_id,
      origin_context_packet_id, origin_model, origin_prompt_version,
      instructions_allowed
    ) VALUES (
      ${tenantId}::uuid, ${clientId}::uuid, ${ownerUserId}::uuid,
      ${canonicalType}, ${visibility}, NULL,
      ${canonicalSlug}, ${canonicalTitle}, ARRAY[]::text[],
      ARRAY['memory', ${record.source}], 'manual', ${governance.sourceRef}, 'human',
      ${sections}::jsonb, 1, 'active', ${governance.sensitivity}, false,
      true, 'excluded', ${record.expiresAt ?? null}, ${confidence},
      ${governance.memoryClass}, ${governance.memoryAuthority}, ${governance.memoryScope},
      ${governance.governedStatus}, ${governance.sourceType}, ${governance.sourceId},
      ${governance.sourceExcerpt}, ${governance.sourceContentHash}, ${governance.sourceVersion},
      ${governance.assertedByUserId}::uuid, ${governance.approvedByUserId}::uuid,
      ${governance.approvedAt}, ${governance.secondApprovedByUserId}::uuid,
      ${governance.secondApprovedAt}, ${governance.approvedAt}, 'confirmed',
      ${governance.reviewDueAt}, NULL, ${governance.asOf}, ${governance.effectiveFrom},
      ${governance.validUntil}, ${governance.conflictStatus}, ${governance.conflictGroupId}::uuid,
      ${governance.controllingItemId}::uuid, ${governance.originSurface},
      ${governance.originTraceId}, ${governance.originContextPacketId}::uuid,
      ${governance.originModel}, ${governance.originPromptVersion},
      ${governance.instructionsAllowed}
    )
    ${conflictClause}
    RETURNING id::text AS id
  `;
  const item = rows[0];
  if (!item && insertOnlySharedCatalog) {
    throw new ConflictException(
      'This shared Settings memory was created while the proposal was pending. No content was replaced; reload and submit the change as an immutable correction.',
    );
  }
  if (!item) throw new Error('Canonical memory_items activation returned no row.');
  return item.id;
}

function truncateUtf8(value: string | null, maxBytes: number): string | null {
  if (!value) return null;
  const input = Buffer.from(value, 'utf8');
  if (input.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && ((input[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return input.subarray(0, end).toString('utf8');
}

function canonicalTypeForScope(
  scope: CanonicalGovernance['memoryScope'],
): CanonicalGovernance['canonicalType'] {
  if (scope === 'client') return 'client-compass';
  if (scope === 'user_private') return 'user-profile';
  return 'playbook';
}
