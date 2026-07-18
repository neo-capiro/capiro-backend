import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { ClerkProvisioningService } from '../auth/clerk-provisioning.service.js';
import { ClerkService } from '../auth/clerk.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AppConfig } from '../config/config.schema.js';
import { ProgramElementWriterService } from '../program-element/program-element-writer.service.js';
import { isValidPeCode } from '../program-element/jbook/jbook-extract.js';
import type { PeRecordInput } from '../program-element/types.js';
import { AcquisitionPersonnelWriterService } from '../acquisition-personnel/acquisition-personnel-writer.service.js';
import type { PersonRecordInput } from '../acquisition-personnel/types.js';
import { AiUsageService } from '../ai-usage/ai-usage.service.js';
import { MeriFeatureFlagsService } from '../meri/meri-feature-flags.service.js';
import { MERIV2_FLAGS, type MeriV2FlagKey } from '../common/tenant-flags.js';
import {
  AiCredentialStoreService,
  type UpsertAiCredentialInput,
} from '../ai-usage/ai-credential-store.service.js';
import type { AiProvider } from '../engagement/ai-credential-resolver.service.js';

/** Quarantine table discriminator shared by the browse/discard/reprocess routes. */
export type QuarantineType = 'program_element' | 'acquisition_personnel';

export interface ReviewCounts {
  reconciliation: { openCount: number; oldestOpenAt: string | null };
  programMatch: { openCount: number; quarantinedCount: number; oldestOpenAt: string | null };
  personCandidate: { openCount: number; oldestOpenAt: string | null };
  personnelMerge: { openCount: number; oldestOpenAt: string | null };
  provisionPeLink: { candidateCount: number; oldestOpenAt: string | null };
  programQuarantine: { count: number };
  personnelQuarantine: { count: number };
}

interface AuditLogQuery {
  action?: string;
  entityType?: string;
  actorUserId?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

interface QuarantineListQuery {
  type: QuarantineType;
  source?: string;
  page?: number;
  limit?: number;
}

interface CreateTenantInput {
  slug: string;
  name: string;
  adminEmail: string;
  adminFirstName?: string;
  adminLastName?: string;
  redirectUrl?: string;
}

/**
 * Cross-tenant operations performed by Capiro staff (capiro_admin role).
 * Every method runs through `prisma.withSystem` (RLS bypass) because the
 * caller is intentionally operating outside any single tenant's scope.
 */
@Injectable()
export class CapiroAdminService {
  private readonly logger = new Logger(CapiroAdminService.name);
  private readonly s3: S3Client;
  private readonly bucket?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clerk: ClerkService,
    private readonly provisioning: ClerkProvisioningService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly peWriter: ProgramElementWriterService,
    private readonly personnelWriter: AcquisitionPersonnelWriterService,
    private readonly aiUsage: AiUsageService,
    private readonly aiCredentials: AiCredentialStoreService,
    private readonly meriFlags: MeriFeatureFlagsService,
  ) {
    this.bucket = this.config.get('ASSETS_BUCKET', { infer: true });
    this.s3 = new S3Client({ region: this.config.get('AWS_REGION_DEFAULT', { infer: true }) });
  }

  /**
   * A6 — the deployed admin flip path for MeriV2 rollout flags. Merges the flag
   * into tenants.settings_jsonb.clioFeatureFlags (spread-preserve BOTH levels,
   * mirroring tenant-admin's contactInfo write) and busts the apps/api flag
   * cache via invalidate(), so apps/api surfaces see the flip immediately
   * (< 5s). NOTE: apps/workspace's MeriV2FlagsService keeps its own 60s TTL
   * cache with no invalidate — the instant cross-service rollback lever remains
   * the MERIV2_ENABLED env kill-switch (checked per-call on both services).
   */
  async setMeriV2Flag(tenantId: string, flag: MeriV2FlagKey, enabled: boolean) {
    if (!Object.values(MERIV2_FLAGS).includes(flag)) {
      throw new BadRequestException(`Unknown MeriV2 flag: ${flag}`);
    }
    const flags = await this.prisma.withSystem(async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { settings: true },
      });
      if (!tenant) throw new NotFoundException('Tenant not found');
      const settings = (tenant.settings ?? {}) as Record<string, unknown>;
      const clioFeatureFlags = {
        ...((settings.clioFeatureFlags ?? {}) as Record<string, unknown>),
        [flag]: enabled,
      };
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          settings: { ...settings, clioFeatureFlags } as unknown as Prisma.InputJsonValue,
        },
      });
      return clioFeatureFlags;
    });
    // Cache bust AFTER the committed write: next read re-fetches from the DB.
    this.meriFlags.invalidate(tenantId);
    this.logger.log(`MeriV2 flag flip: tenant=${tenantId} ${flag}=${enabled}`);
    return { tenantId, flag, enabled, clioFeatureFlags: flags };
  }

  async listTenants() {
    return this.prisma.withSystem(async (tx) => {
      return tx.tenant.findMany({
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { memberships: true, clients: true } } },
      });
    });
  }

  async getTenant(tenantId: string) {
    return this.prisma.withSystem(async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        include: {
          memberships: {
            include: {
              user: { select: { id: true, email: true, firstName: true, lastName: true } },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
      if (!tenant) throw new NotFoundException('Tenant not found');
      return tenant;
    });
  }

  async createTenantWithFirstAdmin(input: CreateTenantInput, actor?: TenantContext) {
    const slug = input.slug.toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
      throw new BadRequestException(
        'Slug must be lowercase, 2-63 chars, [a-z0-9-], not starting with a hyphen',
      );
    }

    const adminEmail = input.adminEmail.trim().toLowerCase();
    const adminFirstName = input.adminFirstName?.trim() || null;
    const adminLastName = input.adminLastName?.trim() || null;

    // Step 1: Clerk org.
    const existingList = await this.clerk.backend.organizations.getOrganizationList({
      query: slug,
      limit: 50,
    });
    let org = existingList.data.find((o) => o.slug === slug);
    if (!org) {
      org = await this.clerk.backend.organizations.createOrganization({
        name: input.name,
        slug,
      });
    }

    // Step 2: DB tenant + Clerk metadata.
    const tenant = await this.prisma.withSystem(async (tx) => {
      const t = await tx.tenant.upsert({
        where: { slug },
        create: { slug, name: input.name, status: 'active', clerkOrgId: org!.id },
        update: { name: input.name, status: 'active', clerkOrgId: org!.id },
      });
      return t;
    });
    await this.clerk.backend.organizations.updateOrganizationMetadata(org.id, {
      publicMetadata: { capiro_tenant_id: tenant.id, capiro_tenant_slug: slug },
    });

    // Step 3: INVITE the first admin via Clerk's organization invitation flow.
    //
    // This is the only path that actually sends an onboarding *email*. The
    // previous implementation called provisionOrganizationMember(), which
    // created a passwordless Clerk user + an immediately-active membership and
    // sent NOTHING — the invitee never received a link and had no way to set a
    // password, which is exactly the "added a tenant but no invite arrived in
    // Outlook" failure. We now mirror the team-invite flow: revoke any stale
    // pending invite, then createOrganizationInvitation with a /sign-up
    // redirect so the invitee gets the real Clerk email.
    //
    // If the admin is *already* a real Clerk user (re-inviting an existing
    // person, e.g. an internal re-run), Clerk auto-routes them to /sign-in.
    await this.revokeStalePendingInvitation(org.id, adminEmail, actor?.clerkUserId);

    const invitation = await this.clerk.backend.organizations.createOrganizationInvitation({
      organizationId: org.id,
      emailAddress: adminEmail,
      role: 'org:admin',
      // Carry the admin's name through to the sign-up form so Clerk pre-fills
      // it and the webhook persists it on user.created. We do NOT pre-create a
      // local users row: the canonical row is created with the admin's REAL
      // clerkUserId on accept (webhook) or first authenticated request
      // (middleware self-heal). A `pending:<id>` placeholder row collides on
      // the unique email constraint and 500s every request post-sign-in.
      publicMetadata: {
        capiro_tenant_id: tenant.id,
        ...(adminFirstName ? { first_name: adminFirstName } : {}),
        ...(adminLastName ? { last_name: adminLastName } : {}),
      },
      redirectUrl: input.redirectUrl ?? this.defaultInvitationRedirectUrl(),
    });

    return {
      tenant,
      invitation: {
        id: invitation.id,
        email: invitation.emailAddress,
        status: 'invited' as const,
        createdAt: new Date(invitation.createdAt).toISOString(),
        expiresAt: invitation.expiresAt ? new Date(invitation.expiresAt).toISOString() : null,
      },
      clerkOrgId: org.id,
    };
  }

  /**
   * Hard-delete a tenant: remove the Clerk organization (best-effort) and
   * cascade-delete the tenant row in our DB. Every tenant-scoped table has an
   * `onDelete: Cascade` FK to `tenants`, so a single prisma delete removes all
   * dependent data (memberships, clients, meetings, mail, clio, etc.).
   *
   * This is a destructive, capiro_admin-only operation intended for cleaning up
   * test/abandoned tenants. There is no soft-delete recovery.
   */
  async deleteTenant(tenantId: string) {
    const tenant = await this.prisma.withSystem(async (tx) =>
      tx.tenant.findUnique({ where: { id: tenantId } }),
    );
    if (!tenant) throw new NotFoundException('Tenant not found');

    // Step 1: purge the tenant's S3 objects (branding logos, client logos,
    // uploaded documents, etc. under tenants/<id>/). FATAL and done FIRST: the
    // DPA/GDPR data-destruction guarantee requires the tenant's data to actually
    // be gone, so we must not report a tenant "deleted" while its documents
    // linger in S3. Running before the irreversible Clerk/Postgres deletes means
    // an S3 outage aborts cleanly and the whole delete is retryable.
    await this.deleteTenantData(tenantId);

    // Step 2: delete the Clerk organization (revokes memberships + pending
    // invitations on Clerk's side). Best-effort — if Clerk is already missing
    // the org, proceed with the local delete so we don't strand the DB row.
    if (tenant.clerkOrgId) {
      await this.clerk.backend.organizations.deleteOrganization(tenant.clerkOrgId).catch((err) => {
        this.logger.warn(
          `Clerk deleteOrganization(${tenant.clerkOrgId}) failed: ${(err as Error).message}`,
        );
      });
    }

    // Step 3: cascade-delete the tenant and all tenant-scoped rows. The audit
    // tables (audit_logs, compliance_check) are append-only via a BEFORE trigger
    // that blocks all DELETEs EXCEPT under app.allow_audit_purge — so we set it
    // transaction-locally here (is_local=true) to let the tenant_id FK ON DELETE
    // CASCADE actually purge this tenant's audit rows. Nothing outside this
    // GDPR-destruction path sets that flag, so ordinary sessions still cannot
    // erase history. See migration 20260718000000_audit_append_only.
    await this.prisma.withSystem(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_audit_purge', 'on', true)`;
      await tx.tenant.delete({ where: { id: tenantId } });
    });

    this.logger.log(`Deleted tenant ${tenantId} (${tenant.slug})`);
    return { ok: true, deletedTenantId: tenantId, slug: tenant.slug };
  }

  /**
   * Hard-delete every S3 object (all versions + delete markers) under a tenant's
   * prefix `tenants/<id>/` — the DPA/GDPR data-destruction step that tenant
   * teardown must run. Version-aware so it fully purges on a versioned bucket
   * (ListObjectVersions returns VersionId='null' on an unversioned bucket, so the
   * same path works there too). Any future automated retention/hard-delete cron
   * MUST call this too, not just the manual delete path.
   *
   * Throws on failure (callers treat S3 purge as required, not best-effort). A
   * no-op when ASSETS_BUCKET is unset (local/dev).
   */
  private async deleteTenantData(tenantId: string): Promise<void> {
    if (!this.bucket) {
      this.logger.warn(`ASSETS_BUCKET unset — skipping S3 purge for tenant ${tenantId}`);
      return;
    }
    const prefix = `tenants/${tenantId}/`;
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    let purged = 0;
    do {
      const listed = await this.s3.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix: prefix,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        }),
      );
      const objects: ObjectIdentifier[] = [
        ...(listed.Versions ?? []),
        ...(listed.DeleteMarkers ?? []),
      ]
        .filter((o): o is { Key: string; VersionId?: string } => Boolean(o.Key))
        .map((o) => ({ Key: o.Key, VersionId: o.VersionId }));
      if (objects.length) {
        // ListObjectVersions returns ≤1000 entries/page and DeleteObjects accepts
        // ≤1000/call, so one delete per page is safe.
        const res = await this.s3.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
        if (res.Errors?.length) {
          throw new Error(
            `S3 purge incomplete for ${prefix}: ${res.Errors.length} object(s) failed (first: ${res.Errors[0]?.Key} ${res.Errors[0]?.Message})`,
          );
        }
        purged += objects.length;
      }
      keyMarker = listed.IsTruncated ? listed.NextKeyMarker : undefined;
      versionIdMarker = listed.IsTruncated ? listed.NextVersionIdMarker : undefined;
    } while (keyMarker || versionIdMarker);
    this.logger.log(`Purged ${purged} S3 object version(s) under ${prefix}`);
  }

  private async revokeStalePendingInvitation(
    organizationId: string,
    email: string,
    requestingUserId?: string,
  ): Promise<void> {
    const pending = await this.clerk.backend.organizations.getOrganizationInvitationList({
      organizationId,
      status: ['pending'],
      limit: 100,
    });
    const stale = pending.data.find((inv) => inv.emailAddress.toLowerCase() === email);
    if (!stale) return;
    await this.clerk.backend.organizations
      .revokeOrganizationInvitation({
        organizationId,
        invitationId: stale.id,
        requestingUserId,
      })
      .catch((err) => {
        this.logger.warn(
          `Unable to revoke stale invitation ${stale.id}: ${(err as Error).message}`,
        );
      });
  }

  private defaultInvitationRedirectUrl(): string {
    const override = this.config.get('INVITATION_REDIRECT_URL', { infer: true }) as
      | string
      | undefined;
    if (override) return override;
    const rawOrigin = this.config.get('WEB_ORIGIN', { infer: true }) as string | undefined;
    const firstOrigin = rawOrigin?.split(',')[0]?.trim();
    const origin =
      firstOrigin && /^https?:\/\//.test(firstOrigin) ? firstOrigin : 'https://app.capiro.ai';
    return `${origin.replace(/\/$/, '')}/sign-up`;
  }

  async resendAdminInvitation(tenantId: string, email: string, redirectUrl?: string) {
    const tenant = await this.prisma.withSystem(async (tx) => {
      const t = await tx.tenant.findUnique({ where: { id: tenantId } });
      if (!t) throw new NotFoundException('Tenant not found');
      if (!t.clerkOrgId) {
        throw new BadRequestException('Tenant has no Clerk organization linked');
      }
      return t;
    });
    const orgId = tenant.clerkOrgId!;
    const pending = await this.clerk.backend.organizations.getOrganizationInvitationList({
      organizationId: orgId,
      status: ['pending'],
    });
    const existing = pending.data.find(
      (inv) => inv.emailAddress.toLowerCase() === email.toLowerCase(),
    );
    if (existing) {
      await this.clerk.backend.organizations.revokeOrganizationInvitation({
        organizationId: orgId,
        invitationId: existing.id,
        requestingUserId: orgId,
      });
    }
    const inv = await this.clerk.backend.organizations.createOrganizationInvitation({
      organizationId: orgId,
      emailAddress: email,
      role: 'org:admin',
      // Invitation links must point at /sign-up, not /sign-in: new invitees
      // don't have a Clerk account yet, so the SignUp component is what
      // claims the __clerk_ticket. Existing users get auto-redirected to
      // /sign-in by SignUp's `signInUrl` prop. Pointing at /sign-in
      // directly causes the ticket to be dropped on the SignIn→SignUp
      // bounce. Override with an explicit `redirectUrl` arg when needed.
      redirectUrl:
        redirectUrl ??
        (
          this.config.get('APP_SIGN_IN_URL', { infer: true }) ?? 'https://app.capiro.ai/sign-in'
        ).replace(/\/sign-in\/?$/, '/sign-up'),
    });
    return { invitationId: inv.id };
  }

  async removeUserFromTenant(tenantId: string, userId: string) {
    return this.prisma.withSystem(async (tx) => {
      const membership = await tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
        include: { user: true, tenant: true },
      });
      if (!membership) throw new NotFoundException('Membership not found');
      // Mark removed in our DB; mirror to Clerk.
      await tx.tenantMembership.update({
        where: { id: membership.id },
        data: { status: 'removed' },
      });
      if (membership.tenant.clerkOrgId) {
        await this.clerk.backend.organizations
          .deleteOrganizationMembership({
            organizationId: membership.tenant.clerkOrgId,
            userId: membership.user.clerkUserId,
          })
          .catch((err) => {
            // If Clerk-side membership is already gone, our DB still records
            // the removed state from this point forward.
            this.logger.warn(`Clerk delete-membership failed: ${(err as Error).message}`);
          });
      }
      return { ok: true };
    });
  }

  /**
   * Start an impersonation session. Reason required + audit logged. Sessions
   * auto-expire after 60 minutes.
   */
  async startImpersonation(actorUserId: string, tenantId: string, reason: string) {
    const trimmed = reason.trim();
    if (trimmed.length < 10) {
      throw new BadRequestException('Reason must be at least 10 characters');
    }
    return this.prisma.withSystem(async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) throw new NotFoundException('Tenant not found');
      await tx.impersonationSession.updateMany({
        where: { actorUserId, endedAt: null },
        data: { endedAt: new Date(), endedReason: 'replaced' },
      });
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      const session = await tx.impersonationSession.create({
        data: { actorUserId, tenantId, reason: trimmed, expiresAt },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorUserId,
          actorRole: 'capiro_admin',
          action: 'impersonation.start',
          entityType: 'impersonation_session',
          entityId: session.id,
          after: { reason: trimmed, expiresAt: expiresAt.toISOString() },
        },
      });
      return {
        sessionId: session.id,
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        expiresAt,
      };
    });
  }

  async endImpersonation(actorUserId: string) {
    return this.prisma.withSystem(async (tx) => {
      const updated = await tx.impersonationSession.updateMany({
        where: { actorUserId, endedAt: null },
        data: { endedAt: new Date(), endedReason: 'manual' },
      });
      return { ended: updated.count };
    });
  }

  async sendPasswordReset(clerkUserId: string) {
    // The standard production path is Clerk's hosted forgot-password flow.
    // Once the SDK exposes password reset tickets here, this method can issue
    // a direct reset link instead of returning the hosted entry point.
    return {
      forgotPasswordUrl: `${this.config.get('APP_SIGN_IN_URL', { infer: true })}#/factor-one`,
      note: 'Send the user the sign-in URL above; they use "Forgot password" on the Clerk hosted UI.',
      clerkUserId,
    };
  }

  // ---------------------------------------------------------------------------
  // Step 3.5 — Analyst console: review counts, audit-log view, quarantine.
  //
  // The review queues and quarantine tables are GLOBAL (no RLS): they're
  // populated by cross-tenant ingestion and reviewed by Capiro staff, so they're
  // read via the base `this.prisma` client. The audit_logs table is TENANT-SCOPED
  // (RLS), so every read/write goes through `withTenant(ctx.tenantId, ...)` — the
  // capiro_admin's own synthetic tenant owns the analyst-action audit trail.
  // ---------------------------------------------------------------------------

  /**
   * Cross-tenant aggregate of every open review queue + quarantine table, for the
   * analyst console's SLA dashboard. `oldestOpenAt` is the MIN(age field) among
   * open rows (null when the queue is empty) so the UI can flag stale backlogs.
   * Computed with count/aggregate (one round-trip per metric) rather than loading
   * rows.
   */
  async getReviewCounts(): Promise<ReviewCounts> {
    const [
      reconOpen,
      reconOldest,
      matchOpen,
      matchQuarantined,
      matchOldest,
      personCandOpen,
      personCandOldest,
      mergeOpen,
      mergeOldest,
      provisionCand,
      provisionOldest,
      programQuarantine,
      personnelQuarantine,
    ] = await Promise.all([
      this.prisma.reconciliationReviewQueue.count({ where: { status: 'open' } }),
      this.prisma.reconciliationReviewQueue.aggregate({
        where: { status: 'open' },
        _min: { queuedAt: true },
      }),
      this.prisma.peProgramMatch.count({ where: { status: 'candidate' } }),
      this.prisma.peProgramMatch.count({ where: { status: 'quarantined' } }),
      this.prisma.peProgramMatch.aggregate({
        where: { status: 'candidate' },
        _min: { createdAt: true },
      }),
      this.prisma.programElementPersonCandidate.count({ where: { status: 'open' } }),
      this.prisma.programElementPersonCandidate.aggregate({
        where: { status: 'open' },
        _min: { createdAt: true },
      }),
      this.prisma.acquisitionPersonnelMergeCandidate.count({ where: { status: 'open' } }),
      this.prisma.acquisitionPersonnelMergeCandidate.aggregate({
        where: { status: 'open' },
        _min: { createdAt: true },
      }),
      this.prisma.provisionPeLink.count({ where: { reviewStatus: 'candidate' } }),
      this.prisma.provisionPeLink.aggregate({
        where: { reviewStatus: 'candidate' },
        _min: { createdAt: true },
      }),
      this.prisma.programElementQuarantine.count(),
      this.prisma.acquisitionPersonnelQuarantine.count(),
    ]);

    return {
      reconciliation: { openCount: reconOpen, oldestOpenAt: this.toIso(reconOldest._min.queuedAt) },
      programMatch: {
        openCount: matchOpen,
        quarantinedCount: matchQuarantined,
        oldestOpenAt: this.toIso(matchOldest._min.createdAt),
      },
      personCandidate: {
        openCount: personCandOpen,
        oldestOpenAt: this.toIso(personCandOldest._min.createdAt),
      },
      personnelMerge: {
        openCount: mergeOpen,
        oldestOpenAt: this.toIso(mergeOldest._min.createdAt),
      },
      provisionPeLink: {
        candidateCount: provisionCand,
        oldestOpenAt: this.toIso(provisionOldest._min.createdAt),
      },
      programQuarantine: { count: programQuarantine },
      personnelQuarantine: { count: personnelQuarantine },
    };
  }

  /**
   * Paginated, filtered view of the caller's tenant audit log (RLS-scoped). All
   * filters are optional and AND together; results are newest-first.
   */
  async listAuditLogs(ctx: TenantContext, query: AuditLogQuery) {
    const { page, limit } = this.normalizePage(query.page, query.limit);
    const where: Prisma.AuditLogWhereInput = {};
    if (query.action) where.action = query.action;
    if (query.entityType) where.entityType = query.entityType;
    if (query.actorUserId) where.actorUserId = query.actorUserId;
    const occurredAt = this.dateRange(query.from, query.to);
    if (occurredAt) where.occurredAt = occurredAt;

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [data, total] = await Promise.all([
        tx.auditLog.findMany({
          where,
          orderBy: { occurredAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        tx.auditLog.count({ where }),
      ]);
      return { data, total, page, limit };
    });
  }

  /**
   * Browse quarantined ingestion records (global) for the given pipeline. Newest
   * quarantines first; optional `source` filter.
   */
  async listQuarantine(query: QuarantineListQuery) {
    const { page, limit } = this.normalizePage(query.page, query.limit);
    const where = query.source ? { source: query.source } : {};
    const select = { id: true, rawRecord: true, reason: true, source: true, quarantinedAt: true };
    const orderBy = { quarantinedAt: 'desc' as const };
    const skip = (page - 1) * limit;

    if (query.type === 'program_element') {
      const [data, total] = await Promise.all([
        this.prisma.programElementQuarantine.findMany({
          where,
          select,
          orderBy,
          skip,
          take: limit,
        }),
        this.prisma.programElementQuarantine.count({ where }),
      ]);
      return { data, total, page, limit };
    }

    const [data, total] = await Promise.all([
      this.prisma.acquisitionPersonnelQuarantine.findMany({
        where,
        select,
        orderBy,
        skip,
        take: limit,
      }),
      this.prisma.acquisitionPersonnelQuarantine.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  /**
   * Permanently delete a quarantine row (analyst decided the record is junk).
   * Audit-logged under the caller's tenant.
   */
  async discardQuarantine(ctx: TenantContext, type: QuarantineType, id: string) {
    const row = await this.findQuarantineRow(type, id);
    if (!row) throw new NotFoundException('Quarantine record not found');

    await this.deleteQuarantineRow(type, id);
    await this.writeAudit(ctx, {
      action: 'quarantine.discard',
      entityType: this.quarantineEntityType(type),
      entityId: id,
      before: this.quarantineAuditSnapshot(row),
    });
    return { discarded: true };
  }

  /**
   * Re-run the relevant writer's validation on a quarantined record. If it now
   * passes, write the real row via the writer's normal entry point and delete the
   * quarantine row; otherwise leave the row in place and report why it still fails.
   *
   * Validation is NOT duplicated here: we call the SAME predicate the writer's
   * quarantine gate uses (isValidPeCode / non-empty full_name), then hand off to
   * the writer's public upsert. Validating up front (instead of letting the writer
   * re-quarantine on failure) keeps a still-bad record as a single row rather than
   * creating a duplicate quarantine entry.
   */
  async reprocessQuarantine(ctx: TenantContext, type: QuarantineType, id: string) {
    const row = await this.findQuarantineRow(type, id);
    if (!row) throw new NotFoundException('Quarantine record not found');

    const raw = (row.rawRecord ?? {}) as Record<string, unknown>;
    const source = row.source;

    if (type === 'program_element') {
      const peCode = typeof raw.peCode === 'string' ? raw.peCode : undefined;
      if (!isValidPeCode(peCode)) {
        const reason = `Invalid pe_code: ${peCode ?? '(missing)'}`;
        await this.writeAudit(ctx, {
          action: 'quarantine.reprocess',
          entityType: this.quarantineEntityType(type),
          entityId: id,
          after: { accepted: false, reason },
        });
        return { reprocessed: true, accepted: false, reason };
      }
      await this.peWriter.upsertProgramElement(raw as unknown as PeRecordInput, source, 0.5);
    } else {
      const fullName = typeof raw.fullName === 'string' ? raw.fullName.trim() : '';
      if (!fullName) {
        const reason = 'Missing required field: full_name';
        await this.writeAudit(ctx, {
          action: 'quarantine.reprocess',
          entityType: this.quarantineEntityType(type),
          entityId: id,
          after: { accepted: false, reason },
        });
        return { reprocessed: true, accepted: false, reason };
      }
      await this.personnelWriter.upsertPerson(
        raw as unknown as PersonRecordInput,
        source,
        undefined,
        undefined,
        new Date(),
        0.5,
      );
    }

    await this.deleteQuarantineRow(type, id);
    await this.writeAudit(ctx, {
      action: 'quarantine.reprocess',
      entityType: this.quarantineEntityType(type),
      entityId: id,
      before: this.quarantineAuditSnapshot(row),
      after: { accepted: true },
    });
    return { reprocessed: true, accepted: true };
  }

  // --- AI keys & usage console ----------------------------------------------

  /** All-tenants spend table for the admin console (range-clamped). */
  async getAiUsageAllTenants(query: { from?: string; to?: string }) {
    return this.aiUsage.adminAllTenantsSummary(parseUsageDates(query));
  }

  /** Per-tenant usage drill-down. 404s unknown tenants. */
  async getTenantAiUsage(tenantId: string, query: { from?: string; to?: string }) {
    await this.requireTenant(tenantId);
    return this.aiUsage.tenantSummaryByTenantId(tenantId, parseUsageDates(query));
  }

  async listTenantAiCredentials(tenantId: string) {
    await this.requireTenant(tenantId);
    return this.aiCredentials.list(tenantId);
  }

  /**
   * Set/rotate a tenant's AI key on their behalf. Validation + encryption
   * happen in the shared store; the audit row records last4 only — the
   * plaintext key never reaches the audit log.
   */
  async setTenantAiCredential(
    ctx: TenantContext,
    tenantId: string,
    input: Omit<UpsertAiCredentialInput, 'createdByUserId'>,
  ) {
    await this.requireTenant(tenantId);
    const saved = await this.aiCredentials.upsert(tenantId, {
      ...input,
      createdByUserId: ctx.userId,
    });
    await this.writeAudit(ctx, {
      action: 'ai_credential.set',
      entityType: 'tenant_ai_credential',
      entityId: `${tenantId}:${input.provider}`,
      after: {
        tenantId,
        provider: saved.provider,
        last4: saved.last4,
        modelOverride: saved.modelOverride,
        status: saved.status,
      },
    });
    return saved;
  }

  async removeTenantAiCredential(ctx: TenantContext, tenantId: string, provider: AiProvider) {
    await this.requireTenant(tenantId);
    const result = await this.aiCredentials.remove(tenantId, provider);
    await this.writeAudit(ctx, {
      action: 'ai_credential.remove',
      entityType: 'tenant_ai_credential',
      entityId: `${tenantId}:${provider}`,
      after: { tenantId, provider, removed: result.removed },
    });
    return result;
  }

  private async requireTenant(tenantId: string): Promise<void> {
    const tenant = await this.prisma.withSystem((tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }),
    );
    if (!tenant) throw new NotFoundException('Tenant not found');
  }

  // --- helpers -------------------------------------------------------------

  private toIso(value: Date | null | undefined): string | null {
    return value ? value.toISOString() : null;
  }

  private normalizePage(page?: number, limit?: number): { page: number; limit: number } {
    const safePage = Number.isFinite(page) && (page ?? 0) >= 1 ? Math.floor(page!) : 1;
    const requested = Number.isFinite(limit) && (limit ?? 0) >= 1 ? Math.floor(limit!) : 50;
    return { page: safePage, limit: Math.min(requested, 100) };
  }

  private dateRange(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
    const filter: Prisma.DateTimeFilter = {};
    if (from) filter.gte = new Date(from);
    if (to) filter.lte = new Date(to);
    return Object.keys(filter).length ? filter : undefined;
  }

  private quarantineEntityType(type: QuarantineType): string {
    return type === 'program_element'
      ? 'program_element_quarantine'
      : 'acquisition_personnel_quarantine';
  }

  private quarantineAuditSnapshot(row: {
    rawRecord: unknown;
    reason: string;
    source: string;
  }): Prisma.InputJsonValue {
    return {
      reason: row.reason,
      source: row.source,
      rawRecord: (row.rawRecord ?? {}) as Prisma.InputJsonValue,
    };
  }

  private async findQuarantineRow(
    type: QuarantineType,
    id: string,
  ): Promise<{ id: string; rawRecord: unknown; reason: string; source: string } | null> {
    if (type === 'program_element') {
      return this.prisma.programElementQuarantine.findUnique({ where: { id } });
    }
    return this.prisma.acquisitionPersonnelQuarantine.findUnique({ where: { id } });
  }

  private async deleteQuarantineRow(type: QuarantineType, id: string): Promise<void> {
    if (type === 'program_element') {
      await this.prisma.programElementQuarantine.delete({ where: { id } });
      return;
    }
    await this.prisma.acquisitionPersonnelQuarantine.delete({ where: { id } });
  }

  /** Write an analyst-action audit row under the caller's (capiro-internal) tenant. */
  private async writeAudit(
    ctx: TenantContext,
    entry: {
      action: string;
      entityType: string;
      entityId: string;
      before?: Prisma.InputJsonValue;
      after?: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: 'capiro_admin',
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          ...(entry.before !== undefined ? { before: entry.before } : {}),
          ...(entry.after !== undefined ? { after: entry.after } : {}),
        },
      });
    });
  }
}

/** Parse optional ISO date strings into the usage range shape (invalid → undefined). */
function parseUsageDates(query: { from?: string; to?: string }): { from?: Date; to?: Date } {
  const parse = (value?: string) => {
    if (!value) return undefined;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  return { from: parse(query.from), to: parse(query.to) };
}
