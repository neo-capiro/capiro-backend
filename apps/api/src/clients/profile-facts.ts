import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { reviewHash } from './client-profile-fill-review-snapshot.js';
import { subjectColumn, type ProfileSubject } from './profile-subject.js';

export type ProfileFact = {
  id: string;
  fieldKey: string;
  value: unknown;
  origin: 'person' | 'research' | 'official' | 'legacy';
  sourceType: string | null;
  sourceUrl: string | null;
  attachmentId: string | null;
  evidence: unknown[];
  observedAt: Date | null;
  confidence: number | null;
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  isCurrent: boolean;
  approvedBy: string | null;
  approvedAt: Date | null;
  version: number;
  autoAccepted?: boolean;
  sourceUnavailable?: boolean;
  findingId: string | null;
  runId: string | null;
  originId: string;
};
export const FACT_SELECT = `id,field_key AS "fieldKey",value_jsonb AS value,origin,source_type AS "sourceType",
 source_url AS "sourceUrl",attachment_id AS "attachmentId",evidence_jsonb AS evidence,observed_at AS "observedAt",
 confidence::float8 AS confidence,status,is_current AS "isCurrent",approved_by AS "approvedBy",approved_at AS "approvedAt",
 version,finding_id AS "findingId",run_id AS "runId",origin_id AS "originId"`;
export const PROFILE_FIELDS = [
  'name',
  'website',
  'description',
  'productDescription',
  'primaryContactName',
  'primaryContactEmail',
  'primaryContactPhone',
  'uei',
  'cageCode',
  'naicsCodes',
  'pscCodes',
  'issueCodes',
] as const;

export function readProfileFacts(
  tx: Prisma.TransactionClient,
  tenantId: string,
  subject: ProfileSubject,
) {
  return tx.$queryRawUnsafe<ProfileFact[]>(
    `SELECT ${FACT_SELECT} FROM profile_fact
    WHERE tenant_id=$1::uuid AND ${subjectColumn(subject)}=$2::uuid ORDER BY created_at,id`,
    tenantId,
    subject.id,
  );
}

/** One fact is one versioned value. The caller owns the subject lock and projection transaction. */
export async function writeProfileFact(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  subject: ProfileSubject,
  input: {
    fieldKey: string;
    value: unknown;
    origin: ProfileFact['origin'];
    originId: string;
    sourceType?: string | null;
    sourceUrl?: string | null;
    attachmentId?: string | null;
    evidence?: unknown[];
    observedAt?: Date | null;
    confidence?: number | null;
    findingId?: string | null;
    runId?: string | null;
    approved?: boolean;
    resolvePerson?: boolean;
    preserveCurrent?: boolean;
    approvedBy?: string | null;
    approvedAt?: Date | null;
  },
): Promise<{ fact: ProfileFact; conflict: boolean }> {
  const column = subjectColumn(subject);
  const evidence = [
    ...(input.evidence ?? []),
    ...(input.attachmentId
      ? [{ label: 'Original source document', metadata: { attachmentId: input.attachmentId } }]
      : []),
  ];
  const existing = await tx.$queryRawUnsafe<ProfileFact[]>(
    `SELECT ${FACT_SELECT} FROM profile_fact
    WHERE tenant_id=$1::uuid AND ${column}=$2::uuid AND origin_id=$3 FOR UPDATE`,
    ctx.tenantId,
    subject.id,
    input.originId,
  );
  if (existing[0]) {
    if (
      reviewHash(existing[0].value) !== reviewHash(input.value) ||
      existing[0].fieldKey !== input.fieldKey
    )
      throw new ConflictException('This fact origin already belongs to another value');
    if (existing[0].status !== 'rejected')
      return { fact: existing[0], conflict: existing[0].status === 'pending' };
  }
  const current = (
    await tx.$queryRawUnsafe<ProfileFact[]>(
      `SELECT ${FACT_SELECT} FROM profile_fact
    WHERE tenant_id=$1::uuid AND ${column}=$2::uuid AND field_key=$3 AND is_current FOR UPDATE`,
      ctx.tenantId,
      subject.id,
      input.fieldKey,
    )
  )[0];
  const conflict =
    !!current &&
    current.origin === 'person' &&
    (input.origin !== 'person' || input.preserveCurrent === true) &&
    !input.resolvePerson &&
    reviewHash(current.value) !== reviewHash(input.value);
  const approved = input.approved !== false && !conflict;
  const becomesCurrent =
    approved &&
    !(
      current?.origin === 'person' &&
      input.origin !== 'person' &&
      reviewHash(current.value) === reviewHash(input.value)
    );
  if (becomesCurrent && current)
    await tx.$executeRawUnsafe(
      `UPDATE profile_fact SET is_current=false,status='superseded',version=version+1 WHERE id=$1::uuid`,
      current.id,
    );
  if (existing[0]) {
    const revived = (
      await tx.$queryRawUnsafe<ProfileFact[]>(
        `UPDATE profile_fact SET status=$3,is_current=$4,approved_by=$5::uuid,approved_at=$6,version=version+1 WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING ${FACT_SELECT}`,
        ctx.tenantId,
        existing[0].id,
        approved ? 'approved' : 'pending',
        becomesCurrent,
        approved ? ctx.userId : null,
        approved ? new Date() : null,
      )
    )[0]!;
    if (conflict)
      await tx.$executeRawUnsafe(
        `INSERT INTO profile_fact_conflict(tenant_id,${column},field_key,current_fact_id,proposed_fact_id) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid) ON CONFLICT(proposed_fact_id) DO UPDATE SET current_fact_id=EXCLUDED.current_fact_id,status='pending',resolution=NULL,resolved_by=NULL,resolved_at=NULL,version=profile_fact_conflict.version+1`,
        ctx.tenantId,
        subject.id,
        input.fieldKey,
        current!.id,
        revived.id,
      );
    return { fact: revived, conflict };
  }
  const rows = await tx.$queryRawUnsafe<ProfileFact[]>(
    `INSERT INTO profile_fact(tenant_id,${column},field_key,value_jsonb,origin,origin_id,
    source_type,source_url,attachment_id,evidence_jsonb,observed_at,confidence,status,is_current,approved_by,approved_at,supersedes_id,finding_id,run_id)
    VALUES($1::uuid,$2::uuid,$3,$4::jsonb,$5,$6,$7,$8,$9::uuid,$10::jsonb,$11,$12,$13,$14,$15::uuid,$16,$17::uuid,$18::uuid,$19::uuid)
    RETURNING ${FACT_SELECT}`,
    ctx.tenantId,
    subject.id,
    input.fieldKey,
    JSON.stringify(input.value ?? null),
    input.origin,
    input.originId,
    input.sourceType ?? null,
    input.sourceUrl ?? null,
    input.attachmentId ?? null,
    JSON.stringify(evidence),
    input.observedAt ?? null,
    input.confidence ?? null,
    approved ? 'approved' : 'pending',
    becomesCurrent,
    approved ? (input.approvedBy === undefined ? ctx.userId : input.approvedBy) : null,
    approved ? (input.approvedAt === undefined ? new Date() : input.approvedAt) : null,
    becomesCurrent ? (current?.id ?? null) : null,
    input.findingId ?? null,
    input.runId ?? null,
  );
  const fact = rows[0]!;
  if (conflict)
    await tx.$executeRawUnsafe(
      `INSERT INTO profile_fact_conflict(tenant_id,${column},field_key,current_fact_id,proposed_fact_id)
    VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid) ON CONFLICT DO NOTHING`,
      ctx.tenantId,
      subject.id,
      input.fieldKey,
      current!.id,
      fact.id,
    );
  return { fact, conflict };
}

export function findingFactKey(finding: { kind: string; targetKey: string; contentHash: string }) {
  const section: Record<string, string> = {
    person: 'leadership',
    facility: 'locations',
    capability: 'capabilities',
    advocacy_record: 'advocacy',
  };
  return section[finding.kind]
    ? `${section[finding.kind]}.${finding.contentHash}`
    : finding.targetKey;
}

/** Facts are immutable while current. A newer manual save invalidates every older conflict. */
export async function assertConflictCurrentFact(
  tx: Prisma.TransactionClient,
  tenantId: string,
  subject: ProfileSubject,
  currentFactId: string,
) {
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM profile_fact WHERE tenant_id=$1::uuid AND ${subjectColumn(subject)}=$2::uuid AND id=$3::uuid AND is_current AND status='approved' FOR UPDATE`,
    tenantId,
    subject.id,
    currentFactId,
  );
  if (!rows.length)
    throw new ConflictException(
      'The current value changed after this conflict was opened. Refresh the profile before resolving it.',
    );
}

/** Preserve recorded source timestamps/pointers; approval time is not observation time. */
export function profileFactSource(evidence: unknown[]): {
  sourceUrl: string | null;
  attachmentId: string | null;
  observedAt: Date | null;
} {
  let sourceUrl: string | null = null,
    attachmentId: string | null = null,
    observedAt: Date | null = null;
  for (const item of evidence) {
    if (!item || typeof item !== 'object') continue;
    const row = item as {
      url?: unknown;
      observedAt?: unknown;
      attachmentId?: unknown;
      metadata?: { attachmentId?: unknown };
    };
    if (!sourceUrl && typeof row.url === 'string' && /^https?:\/\//.test(row.url))
      sourceUrl = row.url;
    const id = row.attachmentId ?? row.metadata?.attachmentId;
    if (
      !attachmentId &&
      typeof id === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    )
      attachmentId = id;
    if (
      !observedAt &&
      typeof row.observedAt === 'string' &&
      Number.isFinite(Date.parse(row.observedAt))
    )
      observedAt = new Date(row.observedAt);
  }
  return { sourceUrl, attachmentId, observedAt };
}
