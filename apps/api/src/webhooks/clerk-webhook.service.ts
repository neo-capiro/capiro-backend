// ============================================================================
// ⛔ CHANGE-CONTROL: AUTHENTICATION / EMAIL INTEGRATION — APPROVAL REQUIRED
// ----------------------------------------------------------------------------
// Do NOT modify this file (or anything touching Clerk auth, the tenant-context
// middleware, JWT/session handling, Microsoft Graph OAuth, the Clerk webhook,
// or integration connection/token persistence) without EXPLICIT prior approval
// from Neo. These paths gate every authenticated request and the email/Outlook
// integration; a subtle change here has repeatedly caused tenant-wide 403/500
// outages (see git history 2026-06-07 + skill: capiro-tenant-onboarding-flow).
// Investigate read-only and PROPOSE first; wait for go-ahead before editing,
// merging, or deploying.
// ============================================================================
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { mapClerkRoleToCapiro } from '../auth/clerk-role.util.js';

interface ClerkUserPayload {
  id: string;
  email_addresses?: Array<{ id: string; email_address: string }>;
  primary_email_address_id?: string;
  first_name?: string | null;
  last_name?: string | null;
}

interface ClerkPublicUserData {
  user_id: string;
  identifier?: string;
  first_name?: string | null;
  last_name?: string | null;
}

interface ClerkOrgMembershipPayload {
  id: string;
  organization: { id: string; slug: string };
  public_user_data?: ClerkPublicUserData;
  // The invitation's public_metadata is inherited by the membership. We set
  // first_name/last_name here at invite time (the invitee's name is known
  // before they accept), so this is the authoritative name source when the
  // user never typed a name into Clerk's sign-up form (public_user_data names
  // are null in that common case). capiro_billing_admin rides the onboarding
  // Super-Admin invitations (onboarding v1) and is mirrored onto the
  // membership's billing_admin bit below.
  public_metadata?: {
    first_name?: string | null;
    last_name?: string | null;
    capiro_billing_admin?: boolean;
  };
  role: string; // e.g. "org:admin" or "org:member" depending on Clerk config
}

interface ClerkEvent {
  type: string;
  data: unknown;
}

type SystemTx = Parameters<Parameters<PrismaService['withSystem']>[0]>[0];

/**
 * Processes Clerk webhook events.
 *
 *   user.created / user.updated  → upsert `users` row
 *   user.deleted                 → soft-disable by rewriting clerkUserId
 *   organizationMembership.*     → sync `tenant_memberships`
 *
 * Idempotency: every event is persisted to `clerk_events` keyed by Svix message
 * id. Re-deliveries skip processing.
 */
@Injectable()
export class ClerkWebhookService {
  private readonly logger = new Logger(ClerkWebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  async handle(svixId: string, event: ClerkEvent): Promise<void> {
    await this.prisma.withSystem(async (tx) => {
      // Idempotency guard. ON CONFLICT DO NOTHING returns 0 rows, we detect
      // the dup by checking processed_at on the existing row.
      const existing = await tx.clerkEvent.findUnique({ where: { eventId: svixId } });
      if (existing?.processedAt) {
        this.logger.debug(`Skipping already-processed Clerk event ${svixId}`);
        return;
      }
      if (!existing) {
        await tx.clerkEvent.create({
          data: {
            eventId: svixId,
            eventType: event.type,
            payload: event as unknown as object,
          },
        });
      }

      await this.dispatch(tx, event);
      await tx.clerkEvent.update({
        where: { eventId: svixId },
        data: { processedAt: new Date(), error: null },
      });
    }).catch(async (err: unknown) => {
      // The failure ledger MUST be written outside the transaction above.
      //
      // Previously the catch lived INSIDE withSystem: it wrote clerk_events.error
      // and then rethrew, which rolled the whole transaction back — discarding
      // both the error write AND the clerkEvent.create that preceded it. The
      // result was that a failed webhook left NO record at all, and Svix
      // redelivery was the only thing standing between a dropped event and
      // silent divergence between Clerk and the local mirror.
      const message = (err as Error).message;
      this.logger.error(`Failed to process Clerk event ${svixId} (${event.type}): ${message}`);
      try {
        await this.prisma.withSystem((tx2) =>
          tx2.clerkEvent.upsert({
            where: { eventId: svixId },
            // The create above may have rolled back with the rest of the
            // transaction, so this has to be an upsert, not an update.
            create: {
              eventId: svixId,
              eventType: event.type,
              payload: event as unknown as object,
              error: message,
            },
            update: { error: message },
          }),
        );
      } catch (ledgerErr) {
        this.logger.error(
          `Could not persist Clerk event failure for ${svixId}: ${(ledgerErr as Error).message}`,
        );
      }
      throw err;
    });
  }

  private async dispatch(
    tx: Parameters<Parameters<PrismaService['withSystem']>[0]>[0],
    event: ClerkEvent,
  ): Promise<void> {
    switch (event.type) {
      case 'user.created':
      case 'user.updated': {
        const u = event.data as ClerkUserPayload;
        const email = primaryEmail(u);
        if (!email) {
          this.logger.warn(`Clerk ${event.type} for ${u.id} missing primary email, skipping`);
          return;
        }
        await this.syncUserIdentity(tx, {
          clerkUserId: u.id,
          email,
          firstName: u.first_name ?? null,
          lastName: u.last_name ?? null,
        });
        return;
      }
      case 'user.deleted': {
        const u = event.data as { id: string; deleted?: boolean };
        // Soft handling: we don't hard-delete users because tenant_memberships
        // and audit_logs reference them. Mark active memberships removed and
        // rewrite identity fields so the same email can be invited again.
        const existing = await tx.user.findUnique({ where: { clerkUserId: u.id } });
        if (existing) {
          await tx.tenantMembership.updateMany({
            where: { userId: existing.id, status: { not: 'removed' } },
            data: { status: 'removed' },
          });
          await tx.user.update({
            where: { id: existing.id },
            data: {
              clerkUserId: deletedClerkUserId(u.id),
              email: deletedEmail(existing.id),
            },
          });
        }
        return;
      }
      case 'organizationMembership.created':
      case 'organizationMembership.updated': {
        const m = event.data as ClerkOrgMembershipPayload;
        const tenant = await tx.tenant.findUnique({
          where: { clerkOrgId: m.organization.id },
        });
        if (!tenant) {
          this.logger.warn(
            `Membership event for unknown Clerk org ${m.organization.id} (${m.organization.slug}); ignoring`,
          );
          return;
        }
        // The membership identifies a Clerk user by id (`public_user_data.user_id`).
        // The user row must exist, Clerk emits user.created BEFORE
        // organizationMembership.created when the user is new, but the events
        // can arrive out of order. Upsert defensively.
        const clerkUserId = m.public_user_data?.user_id;
        if (!clerkUserId) {
          this.logger.warn(`Membership ${m.id} missing public_user_data.user_id; ignoring`);
          return;
        }
        const email = m.public_user_data?.identifier ?? `${clerkUserId}@unknown.invalid`;
        // Name source priority: the user's own Clerk profile names if present,
        // else the invitation-inherited public_metadata (set at invite time).
        // public_user_data names are null when the invitee never typed a name
        // into Clerk's hosted sign-up form, which is the common case — so the
        // invitation metadata is what actually carries first/last name through.
        const firstName = m.public_user_data?.first_name || m.public_metadata?.first_name || null;
        const lastName = m.public_user_data?.last_name || m.public_metadata?.last_name || null;
        const user = await this.syncUserIdentity(tx, {
          clerkUserId,
          email,
          firstName,
          lastName,
        });

        const role = mapClerkRoleToCapiro(m.organization.slug, m.role);
        // Onboarding v1 (approved 2026-07-06): a Super-Admin designation at
        // the funnel's role step rides the invitation metadata and is mirrored
        // onto the membership's billing_admin bit here. GRANT-ONLY — the
        // webhook never unsets it; revocation is owned by the Settings→Team
        // toggle (tenant-admin setBillingAdmin).
        const grantBillingAdmin = m.public_metadata?.capiro_billing_admin === true;
        await tx.tenantMembership.upsert({
          where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
          create: {
            tenantId: tenant.id,
            userId: user.id,
            role,
            status: 'active',
            billingAdmin: grantBillingAdmin,
            joinedAt: new Date(),
          },
          update: {
            role,
            status: 'active',
            joinedAt: new Date(),
            ...(grantBillingAdmin ? { billingAdmin: true } : {}),
          },
        });
        return;
      }
      case 'organizationMembership.deleted': {
        const m = event.data as ClerkOrgMembershipPayload;
        const tenant = await tx.tenant.findUnique({
          where: { clerkOrgId: m.organization.id },
        });
        const clerkUserId = m.public_user_data?.user_id;
        if (!tenant || !clerkUserId) return;
        const user = await tx.user.findUnique({ where: { clerkUserId } });
        if (!user) return;
        // Mark as removed rather than deleting, keeps audit_logs FKs intact
        // and lets Capiro Admins see the offboarding history.
        await tx.tenantMembership
          .update({
            where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
            data: { status: 'removed' },
          })
          .catch(() => undefined);
        return;
      }
      case 'organization.created':
      case 'organization.updated':
      case 'organization.deleted': {
        // Tenants are owned by our DB; Clerk org changes are mostly informational
        // until we add cross-stack drift detection. Log and skip.
        this.logger.debug(`Clerk ${event.type} acknowledged (no-op)`);
        return;
      }
      default:
        this.logger.debug(`Ignoring Clerk event type ${event.type}`);
        return;
    }
  }

  private async syncUserIdentity(
    tx: SystemTx,
    input: {
      clerkUserId: string;
      email: string;
      firstName?: string | null;
      lastName?: string | null;
    },
  ) {
    const existingByClerkId = await tx.user.findUnique({
      where: { clerkUserId: input.clerkUserId },
    });
    const existingByEmail = await tx.user.findUnique({ where: { email: input.email } });

    // Name updates are COALESCE-style: an incoming null/empty never clobbers an
    // already-stored name. Clerk emits user.created (names often null when the
    // invitee didn't type them) and organizationMembership.created (names from
    // the invitation public_metadata) and these can arrive in EITHER order, so
    // we must not let a later null-name event wipe a good name set earlier.
    const prior = existingByClerkId ?? existingByEmail;
    const mergedFirst = input.firstName || prior?.firstName || null;
    const mergedLast = input.lastName || prior?.lastName || null;
    const userData = {
      clerkUserId: input.clerkUserId,
      email: input.email,
      firstName: mergedFirst,
      lastName: mergedLast,
    };

    if (existingByClerkId && existingByEmail && existingByClerkId.id !== existingByEmail.id) {
      // IDENTITY MERGE. Memberships flow FROM the clerkUserId row TO the email
      // row, and the incoming Clerk identity then owns the email row wholesale
      // — including reviving a non-active membership it holds. Email equality
      // is evidence, not proof; the realistic trigger is a stale local email
      // whose user.deleted webhook never landed.
      //
      // Recorded, not blocked — see UserIdentityConflict in schema.prisma.
      const membershipCount = await tx.tenantMembership.count({
        where: { userId: existingByEmail.id },
      });
      await tx.userIdentityConflict.create({
        data: {
          kind: 'merge',
          source: 'clerk_webhook',
          email: input.email,
          incomingClerkUserId: input.clerkUserId,
          existingUserId: existingByEmail.id,
          previousClerkUserId: existingByEmail.clerkUserId,
          membershipCount,
        },
      });
      this.logger.warn(
        JSON.stringify({
          security_event: 'identity.merge',
          source: 'clerk_webhook',
          email: input.email,
          incoming_clerk_user_id: input.clerkUserId,
          previous_clerk_user_id: existingByEmail.clerkUserId,
          membership_count: membershipCount,
          count: 1,
        }),
      );
      await this.mergeUserIdentity(tx, existingByClerkId.id, existingByEmail.id);
      return tx.user.update({ where: { id: existingByEmail.id }, data: userData });
    }

    const existing = existingByClerkId ?? existingByEmail;
    if (existing) {
      return tx.user.update({ where: { id: existing.id }, data: userData });
    }

    return tx.user.create({ data: userData });
  }

  private async mergeUserIdentity(tx: SystemTx, sourceUserId: string, targetUserId: string) {
    const sourceMemberships = await tx.tenantMembership.findMany({
      where: { userId: sourceUserId },
    });

    for (const source of sourceMemberships) {
      const target = await tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId: source.tenantId, userId: targetUserId } },
      });

      if (!target) {
        await tx.tenantMembership.update({
          where: { id: source.id },
          data: { userId: targetUserId },
        });
        continue;
      }

      if (source.status === 'active' && target.status !== 'active') {
        await tx.tenantMembership.update({
          where: { id: target.id },
          data: {
            role: source.role,
            status: 'active',
            joinedAt: source.joinedAt ?? target.joinedAt ?? new Date(),
            invitedBy: source.invitedBy ?? target.invitedBy,
          },
        });
      }

      await tx.tenantMembership.update({
        where: { id: source.id },
        data: { status: 'removed' },
      });
    }

    await tx.user.update({
      where: { id: sourceUserId },
      data: {
        clerkUserId: `duplicate:${sourceUserId}:${Date.now()}`,
        email: `duplicate+${sourceUserId}@deleted.capiro.local`,
      },
    });
  }
}

function primaryEmail(u: ClerkUserPayload): string | undefined {
  const list = u.email_addresses ?? [];
  if (list.length === 0) return undefined;
  if (u.primary_email_address_id) {
    const match = list.find((e) => e.id === u.primary_email_address_id);
    if (match) return match.email_address;
  }
  return list[0]?.email_address;
}

function deletedClerkUserId(clerkUserId: string): string {
  return `deleted:${clerkUserId}:${Date.now()}`;
}

function deletedEmail(userId: string): string {
  return `deleted+${userId}@deleted.capiro.local`;
}
