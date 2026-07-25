import type { Prisma } from '@prisma/client';

/**
 * Harvest correspondents from a synced mail message into `engagement_contacts`.
 *
 * `engagement_contacts` already existed and both providers already fed it — but
 * ONLY from meeting attendees (`upsertContacts`, called once per calendar event
 * in each sync). Nobody harvested mail. So the firm's contact table knew whoever
 * had been on a calendar invite and nobody it had merely emailed for months,
 * which is most of the people a government-affairs practice actually talks to.
 *
 * Everything needed was already persisted on `mail_messages` (fromEmail,
 * toRecipients, ccRecipients, plus sentAt/receivedAt) — no new Graph or Google
 * scope, no re-consent, no re-verification. This just stops throwing it away.
 *
 * Shared by the Outlook and Gmail syncs because both compute an identical
 * participant array and both write the same tenant-scoped rows under the same
 * `engagement-sync:<tenant>` advisory lock.
 */

export interface HarvestParticipant {
  email: string;
  name: string | null;
  role: string;
}

/** Addresses that are mailing-list / automation noise, never people to file. */
const NOISE_LOCALPARTS = new Set([
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'notifications',
  'notification',
  'mailer-daemon',
  'postmaster',
  'bounce',
  'bounces',
  'support',
  'help',
  'info',
  'admin',
  'billing',
  'receipts',
  'invoice',
  'invoices',
  'alerts',
  'alert',
  'updates',
  'news',
  'newsletter',
  'marketing',
  'automated',
  'calendar-notification',
]);

/**
 * Is this a real correspondent rather than a robot?
 *
 * Filing "noreply@stripe.com" as a contact and then offering it as a person to
 * add to a client profile is worse than not harvesting at all — the user has to
 * clean it up by hand. Prefix matching catches the `bounces+abc123@` and
 * `no-reply-xyz@` variants that plain equality misses.
 */
export function isHarvestableContact(email: string): boolean {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !trimmed.includes('@')) return false;
  const [localPart = '', domain = ''] = trimmed.split('@');
  if (!localPart || !domain || !domain.includes('.')) return false;
  if (NOISE_LOCALPARTS.has(localPart)) return false;
  for (const noise of NOISE_LOCALPARTS) {
    if (localPart.startsWith(`${noise}+`) || localPart.startsWith(`${noise}-`)) return false;
  }
  // Bare VERP / bounce tokens: "bounce-1234-user=example.com@..."
  if (/^(bounce|bounces|verp|mailer)[-_.]/.test(localPart)) return false;
  return true;
}

/** Collapse a message's participants to the addresses worth filing, name-first. */
export function harvestableParticipants(
  participants: HarvestParticipant[],
): Array<{ email: string; name: string | null }> {
  const byEmail = new Map<string, string | null>();
  for (const p of participants) {
    const email = p.email?.trim().toLowerCase();
    if (!email || !isHarvestableContact(email)) continue;
    const name = p.name?.trim() || null;
    // Prefer the first non-null display name seen for an address.
    if (!byEmail.has(email) || (name && !byEmail.get(email))) byEmail.set(email, name);
  }
  // Sorted for consistent lock ordering on the (tenant,email) unique index.
  return [...byEmail.keys()].sort().map((email) => ({ email, name: byEmail.get(email) ?? null }));
}

/**
 * Insert any not-yet-known correspondents from ONE synced message.
 *
 * Runs inside the sync's existing per-message transaction, which already holds
 * the `engagement-sync:<tenant>` advisory lock — so its cost is deliberately
 * bounded to a SINGLE statement regardless of participant count. On 2026-07-21
 * an advisory lock held across an extra per-row read starved the Prisma pool
 * (P2028) and took out the knowledge graph; a findUnique-then-update loop per
 * participant per message is that same shape and must not go here.
 *
 * INSERT-ONLY, via the existing (tenant, email) unique. Enriching rows that
 * already exist — better display name, client association, last-contact
 * recency — is strictly-later work and belongs to the out-of-band pass in
 * ContactHarvestService, which runs without the lock.
 */
export async function harvestMailContacts(
  tx: Prisma.TransactionClient,
  tenantId: string,
  participants: HarvestParticipant[],
  opts: { source: string; clientId?: string | null },
): Promise<number> {
  const rows = harvestableParticipants(participants);
  if (rows.length === 0) return 0;
  const result = await tx.engagementContact.createMany({
    data: rows.map((r) => ({
      tenantId,
      email: r.email,
      fullName: r.name,
      clientId: opts.clientId ?? null,
      source: opts.source,
    })),
    skipDuplicates: true,
  });
  return result.count;
}
