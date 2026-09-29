import { ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';

export interface SyntheticDocumentDeletionGuard {
  expectedRowVersion: string;
  expectedBucket?: string;
  fixtureVersion: string;
  fixtureInstanceId?: string;
  logicalId: string;
  clientId: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  contentSha256: string;
  sourceVersion: number;
}

const NAMESPACE = 'meri-foundation-20260928';
const TENANTS: Record<string, string> = {
  'f2d6cf8f-057c-479a-8110-62fe5086d43f': `${NAMESPACE}-t1`,
  '52e91176-08f0-4d89-9633-bc212f5bdbbf': `${NAMESPACE}-t2`,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function deny(): never {
  throw new ForbiddenException('Synthetic document deletion guard does not match');
}

function identity(
  ctx: TenantContext,
  id: string,
  guard: SyntheticDocumentDeletionGuard,
  bucket: string | undefined,
) {
  if (
    !guard ||
    !bucket ||
    (guard.expectedBucket !== undefined && guard.expectedBucket !== bucket) ||
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== NAMESPACE ||
    !TENANTS[ctx.tenantId] ||
    !UUID.test(ctx.userId) ||
    !UUID.test(guard.clientId ?? '') ||
    !/^[0-9]{1,10}$/u.test(guard.expectedRowVersion ?? '') ||
    Number(guard.expectedRowVersion) > 0xffffffff ||
    !/^[A-Za-z0-9._-]{1,80}$/u.test(guard.fixtureVersion ?? '') ||
    !/^[A-Z][A-Za-z0-9-]{0,100}$/u.test(guard.logicalId ?? '') ||
    (guard.fixtureInstanceId !== undefined && !UUID4.test(guard.fixtureInstanceId)) ||
    !/^[a-f0-9]{64}$/u.test(guard.contentSha256 ?? '') ||
    typeof guard.fileName !== 'string' ||
    !guard.fileName ||
    typeof guard.contentType !== 'string' ||
    !guard.contentType ||
    !Number.isSafeInteger(guard.byteSize) ||
    guard.byteSize < 0 ||
    !Number.isSafeInteger(guard.sourceVersion) ||
    guard.sourceVersion < 1
  )
    deny();
  const marker = {
    contractVersion: 'meri-synthetic-fixture-provisioning-v1',
    fixtureNamespace: NAMESPACE,
    fixtureVersion: guard.fixtureVersion,
    logicalId: guard.logicalId,
    owner: 'engagement_attachment',
    tenantId: ctx.tenantId,
    ...(guard.fixtureInstanceId ? { fixtureInstanceId: guard.fixtureInstanceId } : {}),
  };
  const markerSha = hash(
    Object.fromEntries(Object.entries(marker).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
  const key = guard.fixtureInstanceId
    ? `${NAMESPACE}:${guard.fixtureInstanceId}:${guard.logicalId}`
    : `${NAMESPACE}:${guard.logicalId}`;
  const digest = hash([
    'client-document-v1',
    ctx.tenantId,
    ctx.userId,
    guard.clientId,
    null,
    key,
    guard.contentType,
    false,
    guard.contentSha256,
  ]);
  const expectedId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  if (id !== expectedId) deny();
  const intent = hash([
    markerSha,
    id,
    ctx.userId,
    bucket,
    guard.expectedRowVersion,
    guard.fileName,
    guard.contentType,
    guard.byteSize,
    guard.contentSha256,
    guard.sourceVersion,
    guard.clientId,
  ]);
  return { markerSha, intent, bucket, s3Key: `tenants/${ctx.tenantId}/engagement/${id}/document` };
}

/** The canonical erasure owner calls this inside its tenant transaction. */
export async function guardSyntheticDocumentDeletionInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  id: string,
  guard: SyntheticDocumentDeletionGuard,
  bucket: string | undefined,
  phase: 'claim' | 'finish' | 'inspect',
) {
  const expected = identity(ctx, id, guard, bucket);
  // Normal public deletes may omit the fixture bucket pin. Inspect readback
  // must always carry it so bucket/config drift cannot masquerade as absence.
  if (phase === 'inspect' && guard.expectedBucket !== bucket) deny();
  const membership = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT tm.user_id::text AS id FROM tenant_memberships tm JOIN tenants t ON t.id=tm.tenant_id
    WHERE tm.tenant_id=${ctx.tenantId}::uuid AND tm.user_id=${ctx.userId}::uuid AND tm.status='active' AND tm.role=${ctx.role}
      AND t.slug=${TENANTS[ctx.tenantId]} FOR SHARE OF tm,t`;
  if (membership.length !== 1) deny();
  await tx.$queryRaw`SELECT id FROM clients WHERE tenant_id=${ctx.tenantId}::uuid AND id=${guard.clientId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT user_id FROM client_memory_access WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${guard.clientId}::uuid AND user_id=${ctx.userId}::uuid FOR SHARE`;
  if (!(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, guard.clientId))) deny();
  const locked = await tx.$queryRaw<
    Array<{ version: string }>
  >`SELECT xmin::text AS version FROM engagement_attachments WHERE tenant_id=${ctx.tenantId}::uuid AND id=${id}::uuid FOR UPDATE`;
  if (locked.length === 0 && phase === 'inspect')
    return {
      attachment: null,
      intent: expected.intent,
      rowVersion: null,
      state: 'absent' as const,
      s3Key: expected.s3Key,
    };
  if (locked.length !== 1) deny();
  const row = await tx.engagementAttachment.findFirst({ where: { id, tenantId: ctx.tenantId } });
  if (
    !row ||
    row.clientId !== guard.clientId ||
    row.uploadedByUserId !== ctx.userId ||
    row.meetingId ||
    row.mailMessageId ||
    row.source !== 'meri_synthetic_fixture' ||
    row.sourceEntityType !== 'meri_synthetic_fixture' ||
    row.sourceEntityId !== expected.markerSha ||
    row.sourceVersion !== guard.sourceVersion ||
    row.sourceContentHash !== guard.contentSha256 ||
    row.calculatedSha256 !== guard.contentSha256 ||
    row.bucket !== expected.bucket ||
    row.s3Key !== expected.s3Key ||
    row.fileName !== guard.fileName ||
    row.contentType !== guard.contentType ||
    row.byteSize !== guard.byteSize ||
    row.viewerMode !== 'all' ||
    row.viewerUserIds.length !== 0 ||
    row.approvedAt ||
    row.approvedByUserId ||
    row.sharedAt ||
    row.sharedByUserId ||
    row.supersededByAttachmentId
  )
    deny();
  const metadata = row.extractionMetadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) deny();
  const saved = metadata.syntheticFixtureDeleteIntent;
  const resuming = ['delete_pending', 'delete_failed'].includes(row.lifecycleStatus);
  if (resuming) {
    if (saved !== expected.intent) deny();
  // A non-pending row can be claimed only from its original version. `finish`
  // is legal only after the persisted delete intent made it a resumable row.
  } else if (
    phase === 'finish' ||
    saved !== undefined ||
    locked[0]?.version !== guard.expectedRowVersion ||
    !['ready', 'quarantined', 'blocked'].includes(row.lifecycleStatus)
  )
    deny();
  if (phase === 'claim') {
    await tx.engagementAttachment.update({
      where: { id },
      data: {
        lifecycleStatus: 'delete_pending',
        sharedAt: null,
        sharedByUserId: null,
        extractionMetadata: {
          ...metadata,
          syntheticFixtureDeleteIntent: expected.intent,
        } as Prisma.InputJsonValue,
      },
    });
  }
  return {
    attachment: row,
    intent: expected.intent,
    rowVersion: locked[0]!.version,
    state: resuming ? ('pending' as const) : ('present' as const),
    s3Key: expected.s3Key,
  };
}
