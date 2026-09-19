import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Public state-calendar read access.
 *
 * Florida legislative committee meetings, floor sessions, notices, agendas and
 * watch links are PUBLIC records published by the legislature. They live in the
 * tenant-free global `committee_hearing` corpus alongside the already-global
 * federal calendar, so every authenticated tenant may read them. The legacy
 * per-tenant `legiwatch_state_calendar_v1` allowlist that used to gate this
 * read has been removed for the public calendar (user-authorized): a public
 * state proceeding is not a workspace-scoped secret.
 *
 * Tenant isolation is NOT weakened here. The only tenant-scoped data on the
 * calendar surface — `hearing_subscription` / `hearing_follow` (this user's
 * "I follow / I scheduled", clientIds, watchlistId) — is read separately via
 * `prisma.withTenant(tenantId)` scoped to the calling user, exactly as before.
 * One tenant's follow of a Florida hearing is never visible to another tenant.
 *
 * Capture eligibility is a DIFFERENT policy and is not decided here: see
 * `legiwatch-state-capture-policy.ts`. Server capture stays fail-closed behind
 * a reviewed source permission plus runtime gates; public browser capture of a
 * public Florida event is handled there too.
 *
 * The signature is kept (PrismaService, tenantId) so call sites stay explicit
 * about which tenant context is reading; the flag lookup is gone because the
 * public read no longer depends on it.
 */
export async function requireStateCalendar(
  _prisma: PrismaService,
  _tenantId: string,
): Promise<void> {
  // Public state calendar is global. No per-tenant flag gate.
  return;
}
