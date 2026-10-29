import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { invalid, object, uuid } from './input.js';

export const OFFICE_RETENTION_VERSION = 'meri.office-draft-retention.v1';
export function officeRetentionSubject(raw: unknown) {
  const b = object(raw, ['tenantId', 'subject']);
  const s = object(b.subject, ['kind', 'id']);
  if (s.kind !== 'conversation' && s.kind !== 'artifact') return invalid();
  return { tenantId: uuid(b.tenantId), subject: { kind: s.kind, id: uuid(s.id) } };
}
type Subject = ReturnType<typeof officeRetentionSubject>;
const selection = (s: Subject) => Prisma.sql`tenant_id=${s.tenantId}::uuid AND
  ${s.subject.kind === 'conversation' ? Prisma.sql`conversation_id` : Prisma.sql`artifact_id`}=${s.subject.id}::uuid`;
export const retiredFields = Prisma.sql`state='discarded',bytes=NULL,sha256=NULL,
  lock_token=NULL,lock_expires_at=NULL,editor_id=NULL,editor_expires_at=NULL,
  publish_intent=NULL,published_version_id=NULL`;

/** Canonical Trash holds this conversation FOR UPDATE and supplies the existing
 * actor RLS context. Every editor mutation first locks and reauthorizes that same
 * conversation, so no late editor write can cross the committed Trash change.
 * All matching rows retire in the metadata transaction or the whole change fails. */
export function retireConversationOfficeDraftsInTx(tx: Prisma.TransactionClient,
  tenantId: string, actorId: string, conversationId: string) {
  return tx.$executeRaw`UPDATE meri_office_drafts SET ${retiredFields}
    WHERE tenant_id=${tenantId}::uuid AND actor_user_id=${actorId}::uuid
      AND conversation_id=${conversationId}::uuid AND state<>'discarded'`;
}

/** Fixed, counts-only inventory. The trusted caller holds Meri's existing subject
 * exclusion; this point-in-time read does not establish suppression authority. */
export async function readOfficeDraftRetention(prisma: PrismaService, raw: unknown) {
  const s = officeRetentionSubject(raw);
  return prisma.withSystem(async tx => {
    const rows = await tx.$queryRaw<Array<{ drafts: bigint; active: bigint; bytes: bigint }>>(Prisma.sql`
      SELECT count(*) AS drafts, count(*) FILTER (WHERE state<>'discarded') AS active,
        COALESCE(sum(octet_length(bytes)),0)::bigint AS bytes FROM meri_office_drafts WHERE ${selection(s)}`);
    const r = rows[0]!;
    const counts = { drafts: Number(r.drafts), active: Number(r.active), bytes: Number(r.bytes) };
    if (Object.values(counts).some(n => !Number.isSafeInteger(n) || n < 0)) throw Error('OFFICE_RETENTION_UNAVAILABLE');
    return { version: OFFICE_RETENTION_VERSION, ...s, ...counts };
  }, { readOnly: true });
}

/** The existing suppression owner, not an interactive browser, calls this under
 * its subject exclusion after policy/hold checks. Retire every actor's drafts for
 * the exact tenant/artifact or conversation. Keep closed identities until normal
 * expiry so a still-live editor token cannot reopen them. No immutable version is
 * touched. A skipped writer or a larger batch remains explicitly incomplete. */
export async function retireOfficeDrafts(prisma: PrismaService, raw: unknown) {
  const s = officeRetentionSubject(raw);
  return prisma.withSystem(async tx => {
    const rows = await tx.$queryRaw<Array<{ draft_id: string }>>(Prisma.sql`WITH selected AS (
      SELECT tenant_id,actor_user_id,draft_id FROM meri_office_drafts
      WHERE ${selection(s)} AND state<>'discarded'
      ORDER BY actor_user_id,draft_id LIMIT 100 FOR UPDATE SKIP LOCKED
    ) UPDATE meri_office_drafts d SET ${retiredFields}
      FROM selected s WHERE d.tenant_id=s.tenant_id AND d.actor_user_id=s.actor_user_id
        AND d.draft_id=s.draft_id RETURNING d.draft_id`);
    const remaining = await tx.$queryRaw<Array<{ remaining: boolean }>>(Prisma.sql`SELECT EXISTS(
      SELECT 1 FROM meri_office_drafts WHERE ${selection(s)} AND state<>'discarded') AS remaining`);
    return { version: OFFICE_RETENTION_VERSION, ...s, retired: rows.length, remaining: remaining[0]!.remaining };
  });
}
