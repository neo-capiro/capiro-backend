/**
 * Shared engagement access predicates.
 *
 * Extracted from engagement.service.ts in Phase 1 so the generation services can
 * apply the SAME ownership and body-access boundaries without importing
 * EngagementService — which, since EngagementService now depends on the
 * generation stack, would be a module cycle.
 *
 * These are the app's real authorization rules for meetings and encrypted
 * entries. Re-deriving them per surface is what produced the divergence Phase 1
 * closes; keep them here and import them.
 */
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { activeMailMessageWhere, activeMailThreadWhere } from './mail-message-state.js';

/**
 * A user sees a meeting they created, or one that arrived through a calendar
 * connection they own.
 *
 * Also used by NotetakerService: bot dispatch must enforce the SAME predicate as
 * debrief generation, so a dispatch for a meeting the user doesn't own fails at
 * dispatch time rather than after a whole meeting has been recorded.
 */
export function ownMeetingWhere(userId: string): Prisma.MeetingWhereInput {
  return {
    OR: [{ createdByUserId: userId }, { connection: { createdByUserId: userId } }],
  };
}

export function ownMailThreadWhere(userId: string): Prisma.MailThreadWhereInput {
  return {
    connection: { createdByUserId: userId },
    ...activeMailThreadWhere(),
  };
}

export function ownMailMessageWhere(userId: string): Prisma.MailMessageWhereInput {
  return {
    connection: { createdByUserId: userId },
    ...activeMailMessageWhere(),
  };
}

/**
 * Whether this caller may read the decrypted body of a note/debrief.
 *
 * A non-confidential entry is open; the author always can; tenant/Capiro admins
 * can; otherwise it depends on the entry's own accessLevel. Phase 1's evidence
 * resolvers call this so a restricted debrief cannot enter a prompt by way of
 * being selected as "context".
 */
export function canReadEncryptedEntry(
  ctx: TenantContext,
  note: { confidential: boolean; accessLevel: string; authorUserId: string | null },
): boolean {
  if (!note.confidential) return true;
  if (note.authorUserId === ctx.userId) return true;
  if (ctx.role === 'user_admin' || ctx.role === 'capiro_admin') return true;
  return note.accessLevel === 'tenant_members';
}

export function canEditEncryptedEntry(
  ctx: TenantContext,
  note: { authorUserId: string | null },
): boolean {
  if (note.authorUserId === ctx.userId) return true;
  return ctx.role === 'user_admin' || ctx.role === 'capiro_admin';
}
