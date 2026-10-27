import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  WorkspaceShareLifecycle,
  workspaceShareRequestHash,
  RESEARCH_SHARE_LIFETIME_MS,
  type WorkspaceSharePersistence,
  type WorkspaceShareRecord,
} from '@capiro/shared/workspace-share-lifecycle';
import { validateLayout } from './research-portfolio-dashboard-layout.js';
export { validateLayout } from './research-portfolio-dashboard-layout.js';
import { ResearchPortfolioSharePayloadService } from './research-portfolio-share-payload.service.js';
import type {
  TenantContext,
  ChangeResearchPortfolioSharePinDto,
  EnableResearchPortfolioSharingDto,
  PublishResearchPortfolioShareLinkDto,
  PreviewResearchPortfolioShareDto,
  ResearchPortfolioDashboardDesignDto,
  ResearchPortfolioDashboardLayoutDto,
  ResearchPortfolioDashboardWidgetDto,
  ResearchPortfolioDashboardWidgetKind,
  ResearchPortfolioShareAvailabilityDto,
  ResearchPortfolioShareDashboardDto,
  ResearchPortfolioShareLinkDto,
  ResearchPortfolioShareLinkPublishedDto,
  ResearchPortfolioShareLogoDto,
  ResearchPortfolioShareSettingsDto,
  ResearchPortfolioShareViewSessionDto,
  ResearchPortfolioTenantSharingDto,
  SaveResearchPortfolioDashboardDesignDto,
  SetResearchPortfolioTenantSharingDto,
  ResearchPortfolioEventKind,
} from '@capiro/shared';
import { clientMemoryAllowed, tenantFeatureEnabled } from '@capiro/shared';
import { BrandingService } from '../branding/branding.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  assertResearchPortfolioClientAccess,
  loadAuthorizedResearchPortfolio,
} from './research-portfolio-access.js';
import { ResearchPortfolioAnalyticsService } from './research-portfolio-analytics.service.js';
import { ResearchPortfolioChangesService } from './research-portfolio-changes.service.js';
import { ResearchPortfolioPhase11Service } from './research-portfolio-phase11.service.js';

type Tx = Prisma.TransactionClient;
// The canonical table's kind check guarantees these columns for research rows.
type ResearchShareRow = WorkspaceShareRecord & {
  portfolioId: string;
  clientId: string;
  snapshotId: string;
  snapshotName: string;
  designId: string | null;
  designVersion: number;
  branding: boolean;
  payload: unknown;
  payloadHash: string;
  publishedByUserId: string;
  publishedAt: Date;
  expiresAt: Date;
  revokedByUserId: string | null;
  revokeReason: string | null;
  openCount: number;
  lastOpenedAt: Date | null;
  failedPinAttempts: number;
  lockedUntil: Date | null;
  client: { name: string };
};

/** Fixed by decision: a link lives exactly one week, never extended. */
export const SHARE_LINK_LIFETIME_MS = RESEARCH_SHARE_LIFETIME_MS;
/** A viewing session after a correct PIN; the PIN is asked again afterwards. */
export const SHARE_VIEW_SESSION_MS = 30 * 60 * 1000;
export const SHARE_PIN_MAX_FAILURES = 5;
export const SHARE_PIN_LOCK_MS = 15 * 60 * 1000;
const PIN_PATTERN = /^[0-9]{6,12}$/;
const SCRYPT_N = 16384;
/** Workspace-wide switch (FR-16.42), stored with the other tenant feature flags; on unless an administrator turns it off. */
export const TENANT_SHARING_FLAG = 'researchSharing.enabled';
export function researchSharingEnabled(settings: unknown): boolean {
  return tenantFeatureEnabled(settings, TENANT_SHARING_FLAG, true);
}
const UNAVAILABLE = 'This link is not available';
/** One message for missing, expired, revoked and locked links: the page never reveals which. */
const unavailable = () => new NotFoundException(UNAVAILABLE);
const asIso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pin, salt, 64, { N: SCRYPT_N }).toString('hex');
  return `scrypt$${SCRYPT_N}$${salt}$${hash}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [scheme, n, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !salt || !hash) return false;
  const candidate = scryptSync(pin, salt, 64, { N: Number(n) });
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

@Injectable()
export class ResearchPortfolioShareService {
  /** PIN attempts per network address, in addition to the per-link lock. */
  private readonly pinAttemptsByAddress = new Map<string, number[]>();
  private readonly ADDRESS_WINDOW_MS = 15 * 60 * 1000;
  private readonly ADDRESS_MAX_ATTEMPTS = 30;

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: ResearchPortfolioAnalyticsService,
    private readonly changes: ResearchPortfolioChangesService,
    private readonly phase11: ResearchPortfolioPhase11Service,
    private readonly branding: BrandingService,
    private readonly payloads: ResearchPortfolioSharePayloadService,
  ) {}

  // ---------------------------------------------------------------- settings

  async getSettings(
    ctx: TenantContext,
    portfolioId: string,
  ): Promise<ResearchPortfolioShareSettingsDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      return this.settingsDto(tx, ctx.tenantId, portfolioId);
    });
  }

  async enableSharing(
    ctx: TenantContext,
    portfolioId: string,
    input: EnableResearchPortfolioSharingDto,
  ): Promise<ResearchPortfolioShareSettingsDto> {
    const pinHash = hashPin(this.requirePin(input.pin));
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.lockTenant(tx, ctx.tenantId);
      await this.lockPortfolio(tx, ctx.tenantId, portfolioId);
      const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'owner');
      if (portfolio.lifecycle === 'archived')
        throw new ConflictException('Archived portfolios cannot be shared');
      await this.assertTenantSharing(tx, ctx.tenantId);
      const now = new Date();
      await tx.researchPortfolioShareSetting.upsert({
        where: { portfolioId },
        create: {
          tenantId: ctx.tenantId,
          portfolioId,
          enabled: true,
          pinHash,
          pinUpdatedAt: now,
          updatedByUserId: ctx.userId,
        },
        update: { enabled: true, pinHash, pinUpdatedAt: now, updatedByUserId: ctx.userId },
      });
      await this.appendEvent(tx, ctx, portfolioId, portfolio.revision, 'share_enabled', {});
      return this.settingsDto(tx, ctx.tenantId, portfolioId);
    });
  }

  /** A new PIN applies at once to every link; every open viewing session ends (the view token is keyed on the PIN hash). */
  async changePin(
    ctx: TenantContext,
    portfolioId: string,
    input: ChangeResearchPortfolioSharePinDto,
  ): Promise<ResearchPortfolioShareSettingsDto> {
    const pinHash = hashPin(this.requirePin(input.pin));
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.lockPortfolio(tx, ctx.tenantId, portfolioId);
      const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'owner');
      const setting = await tx.researchPortfolioShareSetting.findUnique({ where: { portfolioId } });
      if (!setting?.enabled) throw new ConflictException('Turn sharing on before changing the PIN');
      await tx.researchPortfolioShareSetting.update({
        where: { portfolioId },
        data: { pinHash, pinUpdatedAt: new Date(), updatedByUserId: ctx.userId },
      });
      await this.shareLinks(tx).updateMany({
        where: { tenantId: ctx.tenantId, portfolioId, revokedAt: null },
        data: { failedPinAttempts: 0, lockedUntil: null },
      });
      await this.appendEvent(tx, ctx, portfolioId, portfolio.revision, 'share_pin_changed', {});
      return this.settingsDto(tx, ctx.tenantId, portfolioId);
    });
  }

  /** Turning sharing off is a manual revoke of every link of the portfolio. */
  async disableSharing(
    ctx: TenantContext,
    portfolioId: string,
  ): Promise<ResearchPortfolioShareSettingsDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.lockPortfolio(tx, ctx.tenantId, portfolioId);
      const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'owner');
      const setting = await tx.researchPortfolioShareSetting.findUnique({ where: { portfolioId } });
      if (!setting) return this.settingsDto(tx, ctx.tenantId, portfolioId);
      const now = new Date();
      const revoked = await this.shareLinks(tx).updateMany({
        where: { tenantId: ctx.tenantId, portfolioId, revokedAt: null },
        data: { revokedAt: now, revokedByUserId: ctx.userId, revokeReason: 'sharing_disabled' },
      });
      await tx.researchPortfolioShareSetting.update({
        where: { portfolioId },
        data: { enabled: false, pinHash: null, pinUpdatedAt: null, updatedByUserId: ctx.userId },
      });
      await this.appendEvent(tx, ctx, portfolioId, portfolio.revision, 'share_disabled', {
        revokedLinks: revoked.count,
      });
      return this.settingsDto(tx, ctx.tenantId, portfolioId);
    });
  }

  // ---------------------------------------------------------------- tenant switch (administrators)

  async getTenantSharing(ctx: TenantContext): Promise<ResearchPortfolioTenantSharingDto> {
    return this.prisma.withTenant(ctx.tenantId, (tx) => this.tenantSharingDto(tx, ctx.tenantId));
  }

  /** Off means no link can be published and every existing link stops answering until it is on again. */
  async setTenantSharing(
    ctx: TenantContext,
    input: SetResearchPortfolioTenantSharingDto,
  ): Promise<ResearchPortfolioTenantSharingDto> {
    if (typeof input?.enabled !== 'boolean')
      throw new BadRequestException('enabled must be true or false');
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.lockTenant(tx, ctx.tenantId);
      const tenant = await tx.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { settings: true },
      });
      if (!tenant) throw new NotFoundException('Tenant not found');
      const settings = (tenant.settings ?? {}) as Record<string, unknown>;
      const clioFeatureFlags = {
        ...((settings.clioFeatureFlags ?? {}) as Record<string, unknown>),
        [TENANT_SHARING_FLAG]: input.enabled,
      };
      const researchSharing = { updatedAt: new Date().toISOString(), updatedByUserId: ctx.userId };
      await tx.tenant.update({
        where: { id: ctx.tenantId },
        data: {
          settings: {
            ...settings,
            clioFeatureFlags,
            researchSharing,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return this.tenantSharingDto(tx, ctx.tenantId);
    });
  }

  // ---------------------------------------------------------------- designs

  async listDesigns(
    ctx: TenantContext,
    portfolioId: string,
  ): Promise<readonly ResearchPortfolioDashboardDesignDto[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      const rows = await tx.researchPortfolioDashboardDesign.findMany({
        where: { tenantId: ctx.tenantId, portfolioId },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      });
      return rows.map((row) => this.designDto(row));
    });
  }

  async saveDesign(
    ctx: TenantContext,
    portfolioId: string,
    designId: string | null,
    input: SaveResearchPortfolioDashboardDesignDto,
  ): Promise<ResearchPortfolioDashboardDesignDto> {
    const name = input.name?.trim();
    if (!name || name.length > 200)
      throw new BadRequestException('Design name must be between 1 and 200 characters');
    const layout = validateLayout(input.layout);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.lockPortfolio(tx, ctx.tenantId, portfolioId);
      const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'editor');
      const data = {
        name,
        layout: layout as unknown as Prisma.InputJsonValue,
        updatedByUserId: ctx.userId,
      };
      let row;
      if (designId) {
        if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion! < 1)
          throw new BadRequestException('An expectedVersion is required to update a design');
        const existing = await tx.researchPortfolioDashboardDesign.findFirst({
          where: { id: designId, tenantId: ctx.tenantId, portfolioId },
        });
        if (!existing) throw new NotFoundException('Dashboard design not found');
        if (existing.version !== input.expectedVersion)
          throw new ConflictException(
            'Someone else saved this design first. Reload it before saving again.',
          );
        const saved = await tx.researchPortfolioDashboardDesign.updateMany({
          where: {
            id: designId,
            tenantId: ctx.tenantId,
            portfolioId,
            version: input.expectedVersion,
          },
          data: { ...data, version: { increment: 1 } },
        });
        if (saved.count !== 1)
          throw new ConflictException(
            'Someone else saved this design first. Reload it before saving again.',
          );
        row = await tx.researchPortfolioDashboardDesign.findFirstOrThrow({
          where: { id: designId, tenantId: ctx.tenantId, portfolioId },
        });
      } else {
        row = await tx.researchPortfolioDashboardDesign.create({
          data: { ...data, tenantId: ctx.tenantId, portfolioId, createdByUserId: ctx.userId },
        });
      }
      await this.appendEvent(tx, ctx, portfolioId, portfolio.revision, 'share_design_saved', {
        designId: row.id,
        version: row.version,
      });
      return this.designDto(row);
    });
  }

  // ---------------------------------------------------------------- links

  async listLinks(
    ctx: TenantContext,
    portfolioId: string,
  ): Promise<readonly ResearchPortfolioShareLinkDto[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      const rows = await this.shareLinks(tx).findMany({
        where: { tenantId: ctx.tenantId, portfolioId },
        include: { client: { select: { name: true } } },
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      });
      const visibleClients = new Set<string>();
      for (const clientId of new Set(rows.map((row) => row.clientId))) {
        if (await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId))
          visibleClients.add(clientId);
      }
      return rows.filter((row) => visibleClients.has(row.clientId)).map((row) => this.linkDto(row));
    });
  }

  /** Tenant-wide list for administrators: every link that is still live. */
  async listTenantActiveLinks(
    ctx: TenantContext,
  ): Promise<readonly ResearchPortfolioShareLinkDto[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await this.shareLinks(tx).findMany({
        where: { tenantId: ctx.tenantId, revokedAt: null, expiresAt: { gt: new Date() } },
        include: { client: { select: { name: true } } },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      });
      return rows.map((row) => this.linkDto(row));
    });
  }

  async publishLink(
    ctx: TenantContext,
    portfolioId: string,
    input: PublishResearchPortfolioShareLinkDto,
  ): Promise<ResearchPortfolioShareLinkPublishedDto> {
    if (!input.operationKey || input.operationKey.length > 128)
      throw new BadRequestException('operationKey must be between 1 and 128 characters');
    if (!input.snapshotId || !input.designId || !input.clientId)
      throw new BadRequestException('A snapshot, a dashboard design and a client are required');
    const branding = input.branding === true;
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await this.lockTenant(tx, ctx.tenantId);
      await this.lockPortfolio(tx, ctx.tenantId, portfolioId);
      const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'editor');
      const replay = await this.shareLinks(tx).findFirst({
        where: {
          tenantId: ctx.tenantId,
          resourceId: portfolioId,
          operationKey: input.operationKey,
        },
        include: { client: { select: { name: true } } },
      });
      const request = {
        portfolioId,
        snapshotId: input.snapshotId,
        clientId: input.clientId,
        designId: input.designId,
        branding,
        expectedDesignVersion: input.expectedDesignVersion,
        previewHash: input.previewHash,
      };
      if (replay) {
        await assertResearchPortfolioClientAccess(tx, ctx, [replay.clientId]);
        if (
          replay.portfolioId !== portfolioId ||
          replay.snapshotId !== input.snapshotId ||
          replay.clientId !== input.clientId ||
          replay.designId !== input.designId ||
          replay.branding !== branding ||
          (replay.requestHash !== null && replay.requestHash !== workspaceShareRequestHash(request))
        )
          throw new ConflictException('This publish operation key was used for a different link');
        return { link: this.linkDto(replay), token: null, replayed: true };
      }
      if (portfolio.lifecycle === 'archived')
        throw new ConflictException('Archived portfolios cannot be shared');
      await this.assertTenantSharing(tx, ctx.tenantId);
      const setting = await tx.researchPortfolioShareSetting.findUnique({ where: { portfolioId } });
      if (!setting?.enabled || !setting.pinHash)
        throw new ConflictException('Turn sharing on and set a PIN before publishing a link');
      if (
        !portfolio.clientLinks.some(
          (link: { clientId: string }) => link.clientId === input.clientId,
        )
      )
        throw new BadRequestException('The client must be linked to this portfolio');
      await assertResearchPortfolioClientAccess(tx, ctx, [input.clientId]);
      const prepared = await this.payloads.prepare(ctx, portfolioId, input, tx);
      if (
        input.expectedDesignVersion !== prepared.designVersion ||
        input.previewHash !== prepared.previewHash
      )
        throw new ConflictException(
          'The reviewed dashboard changed. Preview it again before publishing',
        );
      const publishedAt = new Date();
      const expiresAt = new Date(publishedAt.getTime() + SHARE_LINK_LIFETIME_MS);
      const payload = {
        ...prepared.payload,
        dashboard: {
          ...prepared.payload.dashboard,
          publishedAt: publishedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
      };
      if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 8 * 1024 * 1024)
        throw new BadRequestException(
          'The complete shared content exceeds the 8 MiB publication limit',
        );
      const { row, token } = await this.shareLinks(tx).publish({
        tenantId: ctx.tenantId,
        resourceId: portfolioId,
        createdById: ctx.userId,
        operationKey: input.operationKey,
        request,
        payload,
        now: publishedAt,
        data: {
          portfolioId,
          clientId: input.clientId,
          snapshotId: input.snapshotId,
          snapshotName: prepared.snapshotName,
          designId: input.designId,
          designVersion: prepared.designVersion,
          branding,
          publishedByUserId: ctx.userId,
          publishedAt,
        },
        include: { client: { select: { name: true } } },
      });
      await this.appendEvent(tx, ctx, portfolioId, portfolio.revision, 'share_link_published', {
        linkId: row.id,
        clientId: input.clientId,
        snapshotId: input.snapshotId,
        designId: input.designId,
        designVersion: prepared.designVersion,
        branding,
      });
      return { link: this.linkDto(row), token, replayed: false };
    });
  }

  async previewLink(
    ctx: TenantContext,
    portfolioId: string,
    input: PreviewResearchPortfolioShareDto,
  ) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await this.lockTenant(tx, ctx.tenantId);
      await this.lockPortfolio(tx, ctx.tenantId, portfolioId);
      await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'editor');
      await this.assertTenantSharing(tx, ctx.tenantId);
      const prepared = await this.payloads.prepare(ctx, portfolioId, input, tx);
      return {
        dashboard: prepared.payload.dashboard,
        previewHash: prepared.previewHash,
        designVersion: prepared.designVersion,
        logoUrl: prepared.payload.logoBinding?.dataUrl ?? null,
      };
    });
  }

  async lookupPublishOperation(
    ctx: TenantContext,
    portfolioId: string,
    operationKey: string,
  ): Promise<{ link: ResearchPortfolioShareLinkDto | null }> {
    if (!operationKey || operationKey.length > 128)
      throw new BadRequestException('Invalid operation key');
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'editor');
      const row = await this.shareLinks(tx).findFirst({
        where: { tenantId: ctx.tenantId, resourceId: portfolioId, operationKey },
        include: { client: { select: { name: true } } },
      });
      if (!row || !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, row.clientId)))
        return { link: null };
      return { link: this.linkDto(row) };
    });
  }

  async publicKind(
    token: string,
  ): Promise<{ available: boolean; kind?: 'workspace_document' | 'research_portfolio' }> {
    return this.prisma.withSystem(async (tx) => {
      if (await this.findLiveLink(tx, token))
        return { available: true, kind: 'research_portfolio' as const };
      const documents = new WorkspaceShareLifecycle(
        tx.wsShareLink as unknown as WorkspaceSharePersistence<WorkspaceShareRecord>,
        'workspace_document',
      );
      const row = await documents.byToken(token);
      return row && documents.isLive(row)
        ? { available: true, kind: 'workspace_document' as const }
        : { available: false };
    });
  }

  async revokeLink(
    ctx: TenantContext,
    portfolioId: string,
    linkId: string,
  ): Promise<ResearchPortfolioShareLinkDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.lockPortfolio(tx, ctx.tenantId, portfolioId);
      const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'editor');
      return this.revokeRow(tx, ctx, portfolioId, portfolio.revision, linkId);
    });
  }

  async revokeTenantLink(
    ctx: TenantContext,
    linkId: string,
  ): Promise<ResearchPortfolioShareLinkDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await this.shareLinks(tx).findFirst({
        where: { id: linkId, tenantId: ctx.tenantId },
        select: { portfolioId: true },
      });
      if (!row) throw new NotFoundException('Share link not found');
      await this.lockPortfolio(tx, ctx.tenantId, row.portfolioId);
      const portfolio = await tx.researchPortfolio.findFirst({
        where: { id: row.portfolioId, tenantId: ctx.tenantId },
        select: { revision: true },
      });
      return this.revokeRow(tx, ctx, row.portfolioId, portfolio?.revision ?? 0, linkId);
    });
  }

  // ---------------------------------------------------------------- public (link + PIN, no session)

  async availability(token: string): Promise<ResearchPortfolioShareAvailabilityDto> {
    return this.prisma.withSystem(async (tx) => ({
      available: (await this.findLiveLink(tx, token)) !== null,
    }));
  }

  async verifyPin(
    token: string,
    pin: string,
    address: string,
  ): Promise<ResearchPortfolioShareViewSessionDto> {
    this.throttleAddress(address);
    const session = await this.prisma.withSystem(async (tx) => {
      const live = await this.findLiveLink(tx, token);
      if (!live) return null;
      const { row, pinHash } = live;
      if (typeof pin !== 'string' || !PIN_PATTERN.test(pin) || !verifyPin(pin, pinHash)) {
        const failures = (row.lockedUntil ? 0 : row.failedPinAttempts) + 1;
        await this.shareLinks(tx).update({
          where: { id: row.id },
          data: {
            failedPinAttempts: failures,
            lockedUntil:
              failures >= SHARE_PIN_MAX_FAILURES ? new Date(Date.now() + SHARE_PIN_LOCK_MS) : null,
          },
        });
        // A throw here would roll back the failed attempt and defeat the lockout.
        return null;
      }
      const exp = Math.min(Date.now() + SHARE_VIEW_SESSION_MS, row.expiresAt.getTime());
      await this.shareLinks(tx).update({
        where: { id: row.id },
        data: {
          failedPinAttempts: 0,
          lockedUntil: null,
          openCount: { increment: 1 },
          lastOpenedAt: new Date(),
        },
      });
      return {
        viewToken: this.signView(row.id, exp, pinHash, row.tokenHash),
        expiresAt: new Date(exp).toISOString(),
      };
    });
    if (!session) throw unavailable();
    return session;
  }

  async dashboard(token: string, viewToken: string): Promise<ResearchPortfolioShareDashboardDto> {
    return this.prisma.withSystem(async (tx) => {
      const live = await this.findLiveLink(tx, token);
      if (!live || !this.verifyView(viewToken, live.row.id, live.pinHash, live.row.tokenHash))
        throw unavailable();
      const stored = live.row.payload as {
        schemaVersion?: number;
        dashboard?: ResearchPortfolioShareDashboardDto;
      };
      return stored.schemaVersion === 2 && stored.dashboard
        ? stored.dashboard
        : (live.row.payload as ResearchPortfolioShareDashboardDto);
    });
  }

  /** The firm logo for a recipient who holds a live view session, only when the link was published with branding. */
  async logo(token: string, viewToken: string): Promise<ResearchPortfolioShareLogoDto> {
    const live = await this.prisma.withSystem(async (tx) => {
      const found = await this.findLiveLink(tx, token);
      if (!found || !this.verifyView(viewToken, found.row.id, found.pinHash, found.row.tokenHash))
        throw unavailable();
      return found.row;
    });
    if (!live.branding) return { url: null };
    const stored = live.payload as {
      schemaVersion?: number;
      logoBinding?: { dataUrl: string } | null;
    };
    if (stored.schemaVersion === 2) return { url: stored.logoBinding?.dataUrl ?? null };
    // Only legacy schema-1 links retain their historic logo lookup behavior.
    return { url: await this.branding.signedLogoUrlForTenant(live.tenantId) };
  }

  // ---------------------------------------------------------------- internals

  private shareLinks(tx: Tx): WorkspaceShareLifecycle<ResearchShareRow> {
    return new WorkspaceShareLifecycle(
      tx.wsShareLink as unknown as WorkspaceSharePersistence<ResearchShareRow>,
      'research_portfolio',
    );
  }

  private async lockTenant(tx: Tx, tenantId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`;
  }

  private async assertTenantSharing(tx: Tx, tenantId: string): Promise<void> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    if (!researchSharingEnabled(tenant?.settings))
      throw new ConflictException('Client sharing is switched off for this workspace');
  }

  private async tenantSharingDto(
    tx: Tx,
    tenantId: string,
  ): Promise<ResearchPortfolioTenantSharingDto> {
    const [tenant, activeLinkCount] = await Promise.all([
      tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } }),
      this.shareLinks(tx).count({
        where: { tenantId, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
    ]);
    const settings = (tenant?.settings ?? {}) as Record<string, unknown>;
    const audit = settings.researchSharing as
      { updatedAt?: unknown; updatedByUserId?: unknown } | undefined;
    return {
      enabled: researchSharingEnabled(settings),
      activeLinkCount,
      updatedAt: typeof audit?.updatedAt === 'string' ? audit.updatedAt : null,
      updatedByUserId: typeof audit?.updatedByUserId === 'string' ? audit.updatedByUserId : null,
    };
  }

  private requirePin(pin: unknown): string {
    if (typeof pin !== 'string' || !PIN_PATTERN.test(pin))
      throw new BadRequestException('The PIN must be 6 to 12 digits');
    return pin;
  }

  /** All share operations lock the existing portfolio before settings/link rows.
   * Public lookup only identifies the lock; current authority is reread afterwards. */
  private async lockPortfolio(tx: Tx, tenantId: string, portfolioId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM research_portfolios
      WHERE tenant_id = ${tenantId}::uuid AND id = ${portfolioId}::uuid FOR UPDATE`;
  }

  private async findLiveLink(tx: Tx, token: string) {
    const lifecycle = this.shareLinks(tx);
    const identity = await lifecycle.byToken(token);
    if (!identity) return null;
    await this.lockTenant(tx, identity.tenantId);
    await this.lockPortfolio(tx, identity.tenantId, identity.portfolioId);
    const row = await lifecycle.byToken(token);
    if (!row || !lifecycle.isLive(row)) return null;
    const now = Date.now();
    if (row.lockedUntil && row.lockedUntil.getTime() > now) return null;
    const setting = await tx.researchPortfolioShareSetting.findUnique({
      where: { portfolioId: row.portfolioId },
    });
    if (!setting?.enabled || !setting.pinHash) return null;
    const tenant = await tx.tenant.findUnique({
      where: { id: row.tenantId },
      select: { settings: true },
    });
    if (!researchSharingEnabled(tenant?.settings)) return null;
    return { row, pinHash: setting.pinHash };
  }

  /** The view token is keyed on the PIN hash and the link token hash: a PIN change or a new link ends every session. */
  private viewKey(pinHash: string, tokenHash: string): Buffer {
    return createHash('sha256').update(`${pinHash}|${tokenHash}`).digest();
  }

  private signView(linkId: string, exp: number, pinHash: string, tokenHash: string): string {
    const body = `${linkId}.${exp}`;
    return `${body}.${createHmac('sha256', this.viewKey(pinHash, tokenHash)).update(body).digest('hex')}`;
  }

  private verifyView(
    viewToken: string,
    linkId: string,
    pinHash: string,
    tokenHash: string,
  ): boolean {
    if (typeof viewToken !== 'string') return false;
    const [id, exp, signature] = viewToken.split('.');
    if (
      id !== linkId ||
      !exp ||
      !signature ||
      !/^[0-9]{1,16}$/.test(exp) ||
      Number(exp) <= Date.now()
    )
      return false;
    const expected = createHmac('sha256', this.viewKey(pinHash, tokenHash))
      .update(`${linkId}.${exp}`)
      .digest();
    const given = Buffer.from(signature, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private throttleAddress(address: string): void {
    const now = Date.now();
    const recent = (this.pinAttemptsByAddress.get(address) ?? []).filter(
      (at) => now - at < this.ADDRESS_WINDOW_MS,
    );
    if (recent.length >= this.ADDRESS_MAX_ATTEMPTS) throw unavailable();
    recent.push(now);
    this.pinAttemptsByAddress.set(address, recent);
  }

  private async revokeRow(
    tx: Tx,
    ctx: TenantContext,
    portfolioId: string,
    revision: number,
    linkId: string,
  ): Promise<ResearchPortfolioShareLinkDto> {
    const row = await this.shareLinks(tx).findFirst({
      where: { id: linkId, tenantId: ctx.tenantId, portfolioId },
      include: { client: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException('Share link not found');
    if (row.revokedAt) return this.linkDto(row);
    const updated = await this.shareLinks(tx).revoke(
      row,
      { revokedByUserId: ctx.userId, revokeReason: 'manual' },
      { client: { select: { name: true } } },
    );
    await this.appendEvent(tx, ctx, portfolioId, revision, 'share_link_revoked', { linkId });
    return this.linkDto(updated);
  }

  private async appendEvent(
    tx: Tx,
    ctx: TenantContext,
    portfolioId: string,
    revision: number,
    eventKind: ResearchPortfolioEventKind,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.researchPortfolioEvent.create({
      data: {
        tenantId: ctx.tenantId,
        portfolioId,
        eventKind,
        aggregateRevision: revision,
        actorUserId: ctx.userId,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }

  private async settingsDto(
    tx: Tx,
    tenantId: string,
    portfolioId: string,
  ): Promise<ResearchPortfolioShareSettingsDto> {
    const [setting, activeLinkCount, tenant] = await Promise.all([
      tx.researchPortfolioShareSetting.findUnique({ where: { portfolioId } }),
      this.shareLinks(tx).count({
        where: { tenantId, portfolioId, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
      tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } }),
    ]);
    return {
      portfolioId,
      enabled: setting?.enabled ?? false,
      tenantEnabled: researchSharingEnabled(tenant?.settings),
      pinSet: Boolean(setting?.pinHash),
      pinUpdatedAt: asIso(setting?.pinUpdatedAt),
      activeLinkCount,
      updatedAt: asIso(setting?.updatedAt),
    };
  }

  private designDto(row: {
    id: string;
    portfolioId: string;
    name: string;
    version: number;
    layout: unknown;
    createdByUserId: string;
    updatedByUserId: string;
    createdAt: Date;
    updatedAt: Date;
  }): ResearchPortfolioDashboardDesignDto {
    return {
      id: row.id,
      portfolioId: row.portfolioId,
      name: row.name,
      version: row.version,
      layout: row.layout as ResearchPortfolioDashboardLayoutDto,
      createdByUserId: row.createdByUserId,
      updatedByUserId: row.updatedByUserId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private linkDto(row: {
    id: string;
    portfolioId: string;
    clientId: string;
    snapshotId: string;
    snapshotName: string;
    designId: string | null;
    designVersion: number;
    branding: boolean;
    publishedByUserId: string;
    publishedAt: Date;
    expiresAt: Date;
    revokedAt: Date | null;
    openCount: number;
    lastOpenedAt: Date | null;
    failedPinAttempts: number;
    client: { name: string };
  }): ResearchPortfolioShareLinkDto {
    const status = row.revokedAt
      ? 'revoked'
      : row.expiresAt.getTime() <= Date.now()
        ? 'expired'
        : 'active';
    return {
      id: row.id,
      portfolioId: row.portfolioId,
      clientId: row.clientId,
      clientName: row.client.name,
      snapshotId: row.snapshotId,
      snapshotName: row.snapshotName,
      designId: row.designId,
      designVersion: row.designVersion,
      branding: row.branding,
      status,
      publishedByUserId: row.publishedByUserId,
      publishedAt: row.publishedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: asIso(row.revokedAt),
      openCount: row.openCount,
      lastOpenedAt: asIso(row.lastOpenedAt),
      failedPinAttempts: row.failedPinAttempts,
    };
  }
}
