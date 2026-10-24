import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';

export interface HearingRecordAccessLocks {
  folders: Array<{ id: string; version: number; clientId: string | null }>;
  observation: { sessionId: string; segmentIds: string[] } | null;
}

export function validHearingRecordAccessLocks(
  value: unknown,
  clientId: string,
): value is HearingRecordAccessLocks {
  if (!value || typeof value !== 'object') return false;
  const locks = value as HearingRecordAccessLocks;
  const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 100;
  return (
    Array.isArray(locks.folders) &&
    locks.folders.length <= 20 &&
    locks.folders.every(
      (f) =>
        f &&
        id(f.id) &&
        Number.isSafeInteger(f.version) &&
        f.version >= 0 &&
        f.clientId === clientId,
    ) &&
    new Set(locks.folders.map((f) => f.id)).size === locks.folders.length &&
    (locks.observation === null ||
      Boolean(
        locks.observation &&
        id(locks.observation.sessionId) &&
        Array.isArray(locks.observation.segmentIds) &&
        locks.observation.segmentIds.length <= 1000 &&
        locks.observation.segmentIds.every(id),
      ))
  );
}

/** Existing published-record writer boundary. Acquire before client/file locks. */
export async function lockHearingRecordSources(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  eventIds: string[],
) {
  await tx.$executeRaw`SELECT set_config('app.folder_actor',${ctx.clerkUserId},true)`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('legiwatch-published-record-commit-v1',0))`;
  for (const eventId of [...new Set(eventIds)].sort())
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + ctx.clerkUserId + ':record-event:' + eventId},0))`;
}

/** Keep Intel's current permission rows stable until the local write commits.
 * Identifiers come only from the owner reply; re-read that owner after locking.
 */
export async function lockHearingRecordAccess(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  locks: HearingRecordAccessLocks,
) {
  await tx.$queryRaw`SELECT m.id FROM tenant_memberships m JOIN users u ON u.id=m.user_id
        WHERE m.tenant_id=${ctx.tenantId}::uuid AND u.clerk_user_id=${ctx.clerkUserId} FOR SHARE OF m,u`;
  await tx.$queryRaw`SELECT id FROM clients WHERE tenant_id=${ctx.tenantId}::uuid AND id=${clientId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM client_memory_access WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${clientId}::uuid AND user_id=${ctx.userId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM intel_feature_flag WHERE tenant_id=${ctx.tenantId} AND feature IN ('legiwatch_published_records_v1','legiwatch_record_briefs_v1') FOR SHARE`;
  for (const folder of locks.folders)
    await tx.$queryRaw`SELECT id FROM intel_legiwatch_folder WHERE tenant_id=${ctx.tenantId} AND id=${folder.id} FOR SHARE`;
  const observation = locks.observation;
  if (observation) {
    await tx.$queryRaw`SELECT id FROM intel_live_hearing_session WHERE tenant_id=${ctx.tenantId} AND id=${observation.sessionId} FOR SHARE`;
    await tx.$queryRaw`SELECT p.id FROM intel_hearing_media_permission p JOIN intel_live_hearing_session s ON s.tenant_id=p.tenant_id
          AND p.hearing_id IS NOT DISTINCT FROM s.hearing_id AND p.source_url=coalesce(s.source_url,'')
          WHERE s.tenant_id=${ctx.tenantId} AND s.id=${observation.sessionId} FOR SHARE OF p`;
    await tx.$queryRaw`SELECT c.id FROM public_hearing_capture c JOIN intel_live_hearing_session s ON s.public_capture_id=c.id
          JOIN committee_hearing h ON h.id=c.hearing_id WHERE s.tenant_id=${ctx.tenantId} AND s.id=${observation.sessionId} FOR SHARE OF c,h`;
    await tx.$queryRaw`SELECT id FROM intel_transcript_segment WHERE tenant_id=${ctx.tenantId} AND session_id=${observation.sessionId} AND id=ANY(${observation.segmentIds}::text[]) FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM public_hearing_transcript_segment WHERE id::text=ANY(${observation.segmentIds}::text[]) FOR SHARE`;
  }
}
