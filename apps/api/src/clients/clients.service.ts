import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { TenantContext } from '@capiro/shared';
import { CLIENT_SLOT_LIMIT_CODE, effectiveClientSlots } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EntityResolutionService } from '../intelligence/entity-resolution.service.js';
import { ClientPrepopulationService } from '../intelligence/client-prepopulation.service.js';
import { SamEntityEnrichmentService } from '../intelligence/sam-entity.service.js';
import { ClientKbService } from '../embeddings/client-kb.service.js';

export interface CreateClientInput {
  name: string;
  website?: string;
  description?: string;
  productDescription?: string;
  primaryContactName?: string;
  primaryContactEmail?: string;
  primaryContactPhone?: string;
  intakeData?: Record<string, unknown>;
  profileType?: string;
  sectorTag?: string;
  submissionTracks?: string[];
  issueCodes?: string[];
  profileStatus?: string;
  // Step 2.3 — government identifiers + code arrays for procurement matching.
  // Accepted on BOTH create and update (the Add Client form sends them on create).
  uei?: string;
  cageCode?: string;
  naicsCodes?: string[];
  pscCodes?: string[];
}

export type UpdateClientInput = Partial<CreateClientInput> & {
  status?: string;
};

export interface ListClientsFilter {
  profileStatus?: string;
  sectorTag?: string;
  /**
   * Include soft-archived ("deleted") clients. Defaults to false so archived
   * clients disappear from every operational surface (dashboards, pickers,
   * intelligence). Management views that need to see them pass true.
   */
  includeArchived?: boolean;
}

const ALLOWED_LOGO_MIME = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']);
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/**
 * The lobbying firm's book of business. Tenant-scoped via RLS - the database
 * itself enforces isolation, the service just wires `withTenant` so the GUC
 * is set on every query.
 */
@Injectable()
export class ClientsService {
  private readonly s3: S3Client;
  private readonly bucket?: string;
  private readonly logger = new Logger(ClientsService.name);
  // Billing is DORMANT until BILLING_ENFORCED=true (onboarding v1: Stripe
  // itself moved to onboard-api, so the old implicit STRIPE_SECRET_KEY signal
  // no longer exists in this service). While false we never enforce the
  // client-slot cap; flipped at billing activation after comp-existing-tenants.
  private readonly billingEnforced: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<AppConfig, true>,
    private readonly entityResolution: EntityResolutionService,
    private readonly prepopulation: ClientPrepopulationService,
    private readonly samEntity: SamEntityEnrichmentService,
    private readonly clientKb: ClientKbService,
  ) {
    this.bucket = config.get('ASSETS_BUCKET', { infer: true });
    this.s3 = new S3Client({ region: config.get('AWS_REGION_DEFAULT', { infer: true }) });
    this.billingEnforced = config.get('BILLING_ENFORCED', { infer: true });
  }

  async list(ctx: TenantContext, filter: ListClientsFilter = {}) {
    // Tenant isolation is enforced IN-QUERY, not by RLS. The runtime API role
    // (capiro_app) is a member of the table-owner role (capiro_master) and so
    // bypasses row-level security on every table — withTenant sets the GUC but
    // the FORCE RLS policy never runs for this connection. Without this explicit
    // tenantId filter, findMany returns EVERY tenant's clients (confirmed leak).
    const where: Record<string, unknown> = { tenantId: ctx.tenantId };
    if (filter.profileStatus) where.profileStatus = filter.profileStatus;
    if (filter.sectorTag) where.sectorTag = filter.sectorTag;
    // Soft-archived ("deleted") clients are hidden by default everywhere; only
    // explicit management views opt in via includeArchived.
    if (!filter.includeArchived) where.status = { not: 'archived' };

    const clients = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findMany({ where, orderBy: { createdAt: 'desc' } }),
    );
    return this.withLogoUrls(clients);
  }

  async get(ctx: TenantContext, id: string) {
    // findFirst with an explicit tenantId (not findUnique by id alone): the app
    // role bypasses RLS, so a bare id lookup would let any tenant fetch any
    // other tenant's client by guessing/enumerating ids.
    const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({ where: { id, tenantId: ctx.tenantId } }),
    );
    if (!client) throw new NotFoundException('Client not found');
    return this.withLogoUrl(client);
  }

  async create(ctx: TenantContext, input: CreateClientInput) {
    const { client, ldaRegistrantId } = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // Billing slot enforcement: a client may not be created beyond the
      // purchased client_slots. 'comped' tenants (Capiro staff / promo) bypass.
      // Runs inside the transaction so the check + insert are atomic. Throws 402
      // with a structured CLIENT_SLOT_LIMIT code the UI turns into an upgrade CTA.
      const tenant = await tx.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { ldaRegistrantId: true, clientSlots: true, billingStatus: true },
      });
      if (this.billingEnforced && tenant && tenant.billingStatus !== 'comped') {
        // Trials get at least the 10-profile allowance regardless of the
        // stamped clientSlots (shared with the LDA import + setup dashboard).
        const slotLimit = effectiveClientSlots(tenant.billingStatus, tenant.clientSlots);
        const current = await tx.client.count({
          where: { tenantId: ctx.tenantId, status: { not: 'archived' } },
        });
        if (current >= slotLimit) {
          throw new HttpException(
            {
              code: CLIENT_SLOT_LIMIT_CODE,
              message: `You've used all ${slotLimit} client slots on your plan. Add more slots to create another client.`,
              limit: slotLimit,
              current,
            },
            HttpStatus.PAYMENT_REQUIRED,
          );
        }
      }
      const client = await tx.client.create({
        data: {
          tenantId: ctx.tenantId,
          name: input.name,
          website: input.website ?? null,
          description: input.description ?? null,
          productDescription: input.productDescription ?? null,
          primaryContactName: input.primaryContactName ?? null,
          primaryContactEmail: input.primaryContactEmail ?? null,
          primaryContactPhone: input.primaryContactPhone ?? null,
          intakeData: (input.intakeData ?? {}) as object,
          profileType: input.profileType ?? null,
          sectorTag: input.sectorTag ?? null,
          submissionTracks: input.submissionTracks ?? [],
          issueCodes: input.issueCodes ?? [],
          profileStatus: input.profileStatus ?? 'ACTIVE',
          uei: input.uei ?? null,
          cageCode: input.cageCode ?? null,
          naicsCodes: input.naicsCodes ?? [],
          pscCodes: input.pscCodes ?? [],
          createdByUserId: ctx.userId,
        },
      });
      return { client, ldaRegistrantId: tenant?.ldaRegistrantId ?? null };
    });

    // Resolve-on-create: registrant-anchored entity resolution, fire-and-forget.
    // resolveClient persists client_intel_mapping under its own withTenant(tenantId)
    // scope (the table is RLS-protected), so it runs safely detached and never
    // blocks or fails the create response.
    void this.entityResolution
      .resolveClient(client.id, ctx.tenantId, client.name, { ldaRegistrantId })
      // After resolution (which may auto-confirm an LDA id), run the prepopulation
      // cascade to sync lda_client_ids + merge issue codes / signals.
      .then(() => this.prepopulation.prepopulate(ctx.tenantId, client.id))
      .catch((e: unknown) =>
        this.logger.warn(
          `resolve-on-create failed for client ${client.id}: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );

    // SAM gov-id enrichment (UEI/CAGE/NAICS) is independent of LDA resolution and
    // network-bound, so it runs as its own detached fire-and-forget. Fill-if-empty,
    // never blocks or fails the create response. Skips silently when SAM has no
    // confident single match or the key is unset.
    void this.samEntity
      .enrichGovIds(ctx.tenantId, client.id)
      .catch((e: unknown) =>
        this.logger.warn(
          `gov-id enrichment failed for client ${client.id}: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );

    return this.withLogoUrl(client);
  }

  /**
   * Bulk-create clients from a CSV import. Per-row error capture: a single
   * bad row never aborts the whole batch, we collect failures, return the
   * count of successful inserts alongside an `errors` array the UI uses to
   * highlight problem rows in the preview.
   *
   * Duplicate-name guard: if a client with the same (case-insensitive)
   * name already exists in this tenant, the row is rejected. Avoids the
   * "import accidentally created 12 duplicate ACME, Inc. records" problem
   * users hit when they re-upload a sheet that was already partly imported.
   */
  async bulkImport(ctx: TenantContext, rows: CreateClientInput[]) {
    // Single tenant-scoped query that fetches all existing names up front,
    // so we can dedupe in-process without N+1 lookups inside the loop.
    const existing = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findMany({
        where: { tenantId: ctx.tenantId },
        select: { name: true },
      }),
    );

    // Billing slot budget for this import. 'comped' tenants are unbounded; for
    // everyone else, only (client_slots − active clients) more clients may be
    // created. Rows beyond the budget are rejected per-row (the import never
    // partially succeeds past the cap), surfacing a slot-limit message the UI
    // can turn into an upgrade prompt.
    const { tenant, activeCount } = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { clientSlots: true, billingStatus: true },
      });
      const activeCount = await tx.client.count({
        where: { tenantId: ctx.tenantId, status: { not: 'archived' } },
      });
      return { tenant, activeCount };
    });
    let remainingSlots =
      this.billingEnforced && tenant && tenant.billingStatus !== 'comped'
        ? Math.max(0, effectiveClientSlots(tenant.billingStatus, tenant.clientSlots) - activeCount)
        : Number.POSITIVE_INFINITY;
    const existingNames = new Set(existing.map((c) => c.name.trim().toLowerCase()));
    // Also dedupe within the import payload itself: two rows with the same
    // name → only the first survives, the second is reported as a dup.
    const seenInPayload = new Set<string>();

    const errors: Array<{ row: number; field?: string; message: string }> = [];
    let createdCount = 0;
    const created: Array<{ id: string; name: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const input = rows[i]!;
      const trimmedName = input.name?.trim();
      if (!trimmedName) {
        errors.push({ row: i, field: 'name', message: 'Name is required' });
        continue;
      }
      const key = trimmedName.toLowerCase();
      if (existingNames.has(key)) {
        errors.push({
          row: i,
          field: 'name',
          message: `A client named "${trimmedName}" already exists in this tenant`,
        });
        continue;
      }
      if (seenInPayload.has(key)) {
        errors.push({
          row: i,
          field: 'name',
          message: `Duplicate name within this import: "${trimmedName}"`,
        });
        continue;
      }
      if (remainingSlots <= 0) {
        errors.push({
          row: i,
          message: `Client slot limit reached (${tenant?.clientSlots ?? 0} slots). Add more slots to import additional clients.`,
        });
        continue;
      }

      try {
        const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.client.create({
            data: {
              tenantId: ctx.tenantId,
              name: trimmedName,
              website: input.website ?? null,
              description: input.description ?? null,
              productDescription: input.productDescription ?? null,
              primaryContactName: input.primaryContactName ?? null,
              primaryContactEmail: input.primaryContactEmail ?? null,
              primaryContactPhone: input.primaryContactPhone ?? null,
              intakeData: (input.intakeData ?? {}) as object,
              profileType: input.profileType ?? null,
              sectorTag: input.sectorTag ?? null,
              submissionTracks: input.submissionTracks ?? [],
              issueCodes: input.issueCodes ?? [],
              profileStatus: input.profileStatus ?? 'ACTIVE',
              createdByUserId: ctx.userId,
            },
            select: { id: true, name: true },
          }),
        );
        createdCount++;
        created.push(client);
        seenInPayload.add(key);
        remainingSlots--;
      } catch (err) {
        const message = (err as Error).message ?? 'Unknown error';
        errors.push({ row: i, message });
      }
    }

    // SAM gov-id enrichment for each imported client — fill-if-empty, fire-and-forget
    // (network-bound), matching the single-create + LDA-import paths so CSV imports
    // are not the odd one out. Never blocks or fails the import response.
    for (const c of created) {
      void this.samEntity
        .enrichGovIds(ctx.tenantId, c.id)
        .catch((e: unknown) =>
          this.logger.warn(
            `gov-id enrichment after bulk import failed for ${c.id}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
    }

    return { created: createdCount, total: rows.length, errors, items: created };
  }

  async update(ctx: TenantContext, id: string, input: UpdateClientInput) {
    const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.update({
        where: { id },
        data: {
          ...('name' in input ? { name: input.name } : {}),
          ...('website' in input ? { website: input.website ?? null } : {}),
          ...('description' in input ? { description: input.description ?? null } : {}),
          ...('productDescription' in input
            ? { productDescription: input.productDescription ?? null }
            : {}),
          ...('primaryContactName' in input
            ? { primaryContactName: input.primaryContactName ?? null }
            : {}),
          ...('primaryContactEmail' in input
            ? { primaryContactEmail: input.primaryContactEmail ?? null }
            : {}),
          ...('primaryContactPhone' in input
            ? { primaryContactPhone: input.primaryContactPhone ?? null }
            : {}),
          ...('intakeData' in input ? { intakeData: (input.intakeData ?? {}) as object } : {}),
          ...('status' in input ? { status: input.status! } : {}),
          ...('profileType' in input ? { profileType: input.profileType ?? null } : {}),
          ...('sectorTag' in input ? { sectorTag: input.sectorTag ?? null } : {}),
          ...('submissionTracks' in input
            ? { submissionTracks: input.submissionTracks ?? [] }
            : {}),
          ...('issueCodes' in input ? { issueCodes: input.issueCodes ?? [] } : {}),
          ...('profileStatus' in input ? { profileStatus: input.profileStatus! } : {}),
          ...('uei' in input ? { uei: input.uei ?? null } : {}),
          ...('cageCode' in input ? { cageCode: input.cageCode ?? null } : {}),
          ...('naicsCodes' in input ? { naicsCodes: input.naicsCodes ?? [] } : {}),
          ...('pscCodes' in input ? { pscCodes: input.pscCodes ?? [] } : {}),
        },
      }),
    );
    // Client KB (F5): keep the profile (Overview tab) index in sync.
    this.clientKb.indexClientProfileFireAndForget(ctx.tenantId, id);
    return this.withLogoUrl(client);
  }

  archive(ctx: TenantContext, id: string) {
    return this.update(ctx, id, { status: 'archived' });
  }

  /**
   * Quick Log: prepend a timestamped, attributed note to the client's profile
   * notes (intakeData.profileNotes). Read-modify-write within the tenant
   * transaction so it composes with manual edits in the Documents tab.
   */
  async appendClientNote(ctx: TenantContext, id: string, body: string) {
    const trimmed = body.trim();
    if (!trimmed) throw new BadRequestException('Note body is required');
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const client = await tx.client.findUnique({ where: { id } });
      if (!client) throw new NotFoundException('Client not found');
      const user = await tx.user.findFirst({
        where: { id: ctx.userId },
        select: { firstName: true, lastName: true, email: true },
      });
      const author =
        [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() ||
        user?.email ||
        'Unknown';
      const stamp = new Date().toISOString().slice(0, 10);
      const intake = (client.intakeData ?? {}) as Record<string, unknown>;
      const existing = typeof intake.profileNotes === 'string' ? intake.profileNotes : '';
      const entry = `[${stamp} · ${author}] ${trimmed}`;
      const profileNotes = existing.trim() ? `${entry}\n\n${existing}` : entry;
      await tx.client.update({
        where: { id },
        data: { intakeData: { ...intake, profileNotes } as object },
      });
      return { ok: true, profileNotes };
    });
  }

  /**
   * Targeted save for the profile Notes editor: merges ONLY
   * intakeData.profileNotes via read-modify-write inside the tenant
   * transaction, so a stale full-intakeData PUT from another tab can never
   * clobber sibling keys (ldaSignals, wizard fields) — and vice versa.
   * Empty string is allowed (clears the notes).
   */
  async updateProfileNotes(ctx: TenantContext, id: string, notes: string) {
    const client = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.client.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Client not found');
      const intake = (existing.intakeData ?? {}) as Record<string, unknown>;
      return tx.client.update({
        where: { id },
        data: { intakeData: { ...intake, profileNotes: notes } as object },
      });
    });
    return this.withLogoUrl(client);
  }

  async createLogoUploadUrl(
    ctx: TenantContext,
    clientId: string,
    contentType: string,
    contentLength: number,
  ) {
    if (!this.bucket) throw new BadRequestException('Asset uploads are not configured');
    if (!ALLOWED_LOGO_MIME.has(contentType)) {
      throw new BadRequestException(`Unsupported logo content type: ${contentType}`);
    }
    if (contentLength > MAX_LOGO_BYTES) {
      throw new BadRequestException(`Logo must be <= ${MAX_LOGO_BYTES} bytes`);
    }

    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const client = await tx.client.findUnique({ where: { id: clientId }, select: { id: true } });
      if (!client) throw new NotFoundException('Client not found');
    });

    const ext = contentType === 'image/svg+xml' ? 'svg' : (contentType.split('/')[1] ?? 'png');
    const s3Key = `tenants/${ctx.tenantId}/clients/${clientId}/logo.${ext}`;
    const presigned = await createPresignedPost(this.s3, {
      Bucket: this.bucket,
      Key: s3Key,
      Conditions: [
        ['content-length-range', 1, MAX_LOGO_BYTES],
        ['eq', '$Content-Type', contentType],
        ['starts-with', '$key', `tenants/${ctx.tenantId}/clients/${clientId}/`],
      ],
      Fields: { 'Content-Type': contentType },
      Expires: 300,
    });
    return { ...presigned, s3Key };
  }

  async confirmLogoUpload(
    ctx: TenantContext,
    clientId: string,
    s3Key: string,
    contentType: string,
  ) {
    if (!this.bucket) throw new BadRequestException('Assets bucket not configured');
    if (!s3Key.startsWith(`tenants/${ctx.tenantId}/clients/${clientId}/`)) {
      throw new BadRequestException('Logo key is outside the client tenant prefix');
    }
    if (!ALLOWED_LOGO_MIME.has(contentType)) {
      throw new BadRequestException(`Unsupported logo content type: ${contentType}`);
    }

    const head = await this.s3
      .send(new HeadObjectCommand({ Bucket: this.bucket, Key: s3Key }))
      .catch(() => null);
    if (!head) throw new BadRequestException('Uploaded logo not found in S3');

    const updated = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.update({
        where: { id: clientId },
        data: {
          logoS3Key: s3Key,
          logoContentType: contentType,
          logoUploadedAt: new Date(),
        },
      }),
    );
    return this.withLogoUrl(updated);
  }

  private async withLogoUrls<T extends { logoS3Key: string | null }>(
    clients: T[],
  ): Promise<Array<T & { logoUrl: string | null }>> {
    return Promise.all(clients.map((client) => this.withLogoUrl(client)));
  }

  private async withLogoUrl<T extends { logoS3Key: string | null }>(
    client: T,
  ): Promise<T & { logoUrl: string | null }> {
    return {
      ...client,
      logoUrl: client.logoS3Key ? await this.signedGetUrl(client.logoS3Key) : null,
    };
  }

  private async signedGetUrl(s3Key: string, ttlSeconds = 300): Promise<string | null> {
    if (!this.bucket) return null;
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: s3Key }), {
      expiresIn: ttlSeconds,
    });
  }
}
