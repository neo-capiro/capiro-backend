import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type {
  TenantContext,
  ChangeResearchPortfolioSharePinDto,
  EnableResearchPortfolioSharingDto,
  PublishResearchPortfolioShareLinkDto,
  ResearchPortfolioDashboardDesignDto,
  ResearchPortfolioDashboardLayoutDto,
  ResearchPortfolioDashboardWidgetDto,
  ResearchPortfolioDashboardWidgetKind,
  ResearchPortfolioShareAvailabilityDto,
  ResearchPortfolioShareDashboardDto,
  ResearchPortfolioShareLinkDto,
  ResearchPortfolioShareLinkPublishedDto,
  ResearchPortfolioShareSettingsDto,
  ResearchPortfolioShareViewSessionDto,
  SaveResearchPortfolioDashboardDesignDto,
  ResearchPortfolioEventKind,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  assertResearchPortfolioClientAccess,
  loadAuthorizedResearchPortfolio,
} from './research-portfolio-access.js';
import { ResearchPortfolioAnalyticsService } from './research-portfolio-analytics.service.js';
import { ResearchPortfolioChangesService } from './research-portfolio-changes.service.js';
import { ResearchPortfolioPhase11Service } from './research-portfolio-phase11.service.js';

type Tx = Prisma.TransactionClient;

/** Fixed by decision: a link lives exactly one week, never extended. */
export const SHARE_LINK_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** A viewing session after a correct PIN; the PIN is asked again afterwards. */
export const SHARE_VIEW_SESSION_MS = 30 * 60 * 1000;
export const SHARE_PIN_MAX_FAILURES = 5;
export const SHARE_PIN_LOCK_MS = 15 * 60 * 1000;
const PIN_PATTERN = /^[0-9]{6,12}$/;
const SCRYPT_N = 16384;
const GRID_COLUMNS = 12;
const MAX_WIDGETS = 40;
const WIDGET_KINDS: ReadonlySet<ResearchPortfolioDashboardWidgetKind> = new Set([
  'header',
  'key_totals',
  'funding_table',
  'client_fit',
  'changes',
  'subjects',
  'sources',
  'snapshot_comparison',
  'commentary',
  'image',
]);
/** Portfolio history kinds a recipient may see. Grants, client links and sharing itself stay internal. */
const RECIPIENT_EVENT_KINDS: ReadonlySet<string> = new Set([
  'member_added',
  'member_decided',
  'member_excluded',
  'member_reinstated',
  'member_resolved',
  'rule_published',
  'review_updated',
  'annual_reopened',
  'import_created',
  'import_action',
]);
const UNAVAILABLE = 'This link is not available';
/** One message for missing, expired, revoked and locked links: the page never reveals which. */
const unavailable = () => new NotFoundException(UNAVAILABLE);
const asIso = (value: Date | null | undefined) => (value ? value.toISOString() : null);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

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

export function validateLayout(input: unknown): ResearchPortfolioDashboardLayoutDto {
  const layout = input as Partial<ResearchPortfolioDashboardLayoutDto> | null;
  if (
    !layout ||
    typeof layout !== 'object' ||
    layout.columns !== GRID_COLUMNS ||
    !Array.isArray(layout.widgets)
  )
    throw new BadRequestException('Dashboard layout must have 12 columns and a widgets array');
  if (layout.widgets.length > MAX_WIDGETS)
    throw new BadRequestException(`A dashboard holds at most ${MAX_WIDGETS} widgets`);
  const ids = new Set<string>();
  const widgets: ResearchPortfolioDashboardWidgetDto[] = layout.widgets.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new BadRequestException('Each widget must be an object');
    const widget = raw as Partial<ResearchPortfolioDashboardWidgetDto>;
    if (
      typeof widget.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(widget.id) ||
      ids.has(widget.id)
    )
      throw new BadRequestException('Each widget needs a unique id');
    ids.add(widget.id);
    if (!WIDGET_KINDS.has(widget.kind as ResearchPortfolioDashboardWidgetKind))
      throw new BadRequestException(`Unknown widget kind: ${String(widget.kind)}`);
    const { x, y, w, h } = widget;
    if (
      ![x, y, w, h].every((value) => Number.isInteger(value)) ||
      x! < 0 ||
      y! < 0 ||
      w! < 1 ||
      h! < 1 ||
      x! + w! > GRID_COLUMNS
    )
      throw new BadRequestException(`Widget ${widget.id} must fit the 12-column grid`);
    const settings =
      widget.settings && typeof widget.settings === 'object' && !Array.isArray(widget.settings)
        ? widget.settings
        : {};
    if (JSON.stringify(settings).length > 4000)
      throw new BadRequestException(`Widget ${widget.id} settings are too large`);
    return {
      id: widget.id,
      kind: widget.kind as ResearchPortfolioDashboardWidgetKind,
      x: x!,
      y: y!,
      w: w!,
      h: h!,
      settings,
    };
  });
  // Widgets may not overlap: the editor refuses an invalid drop, and the server refuses an invalid save.
  for (let i = 0; i < widgets.length; i += 1) {
    for (let j = i + 1; j < widgets.length; j += 1) {
      const a = widgets[i]!,
        b = widgets[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
        throw new BadRequestException(`Widgets ${a.id} and ${b.id} overlap`);
    }
  }
  const phoneOrder = Array.isArray(layout.phoneOrder)
    ? [
        ...new Set(
          layout.phoneOrder.filter((id): id is string => typeof id === 'string' && ids.has(id)),
        ),
      ]
    : [];
  const ordered = [
    ...phoneOrder,
    ...widgets.map((w) => w.id).filter((id) => !phoneOrder.includes(id)),
  ];
  return { columns: GRID_COLUMNS, widgets, phoneOrder: ordered };
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
      await this.lockPortfolio(tx, ctx.tenantId, portfolioId);
      const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'owner');
      if (portfolio.lifecycle === 'archived')
        throw new ConflictException('Archived portfolios cannot be shared');
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
      await tx.researchPortfolioShareLink.updateMany({
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
      const revoked = await tx.researchPortfolioShareLink.updateMany({
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
      const rows = await tx.researchPortfolioShareLink.findMany({
        where: { tenantId: ctx.tenantId, portfolioId },
        include: { client: { select: { name: true } } },
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      });
      return rows.map((row) => this.linkDto(row));
    });
  }

  /** Tenant-wide list for administrators: every link that is still live. */
  async listTenantActiveLinks(
    ctx: TenantContext,
  ): Promise<readonly ResearchPortfolioShareLinkDto[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.researchPortfolioShareLink.findMany({
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
    // Reads that build the frozen payload use the existing owners (each re-checks current access).
    const snapshot = await this.analytics.snapshot(ctx, portfolioId, input.snapshotId);
    const fit = await this.phase11.getFit(ctx, portfolioId);
    const changes = await this.changes.listChanges(ctx, portfolioId, null, 50);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.lockPortfolio(tx, ctx.tenantId, portfolioId);
      const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'editor');
      const replay = await tx.researchPortfolioShareLink.findUnique({
        where: {
          tenantId_operationKey: { tenantId: ctx.tenantId, operationKey: input.operationKey },
        },
        include: { client: { select: { name: true } } },
      });
      if (replay) {
        if (
          replay.portfolioId !== portfolioId ||
          replay.snapshotId !== input.snapshotId ||
          replay.clientId !== input.clientId ||
          replay.designId !== input.designId ||
          replay.branding !== branding
        )
          throw new ConflictException('This publish operation key was used for a different link');
        return { link: this.linkDto(replay), token: null, replayed: true };
      }
      if (portfolio.lifecycle === 'archived')
        throw new ConflictException('Archived portfolios cannot be shared');
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
      const design = await tx.researchPortfolioDashboardDesign.findFirst({
        where: { id: input.designId, tenantId: ctx.tenantId, portfolioId },
      });
      if (!design) throw new NotFoundException('Dashboard design not found');
      const client = await tx.client.findFirst({
        where: { tenantId: ctx.tenantId, id: input.clientId },
        select: { name: true },
      });
      if (!client) throw new NotFoundException('Client not found');
      const tenant = branding
        ? await tx.tenant.findUnique({
            where: { id: ctx.tenantId },
            select: { name: true, logoS3Key: true },
          })
        : null;
      const layout = validateLayout(design.layout);
      this.assertWidgetsPublishable(layout, {
        fitKnown: fit.clientFits.some((entry) => entry.clientId === input.clientId),
      });
      const publishedAt = new Date();
      const expiresAt = new Date(publishedAt.getTime() + SHARE_LINK_LIFETIME_MS);
      const clientFit = fit.clientFits.find((entry) => entry.clientId === input.clientId) ?? null;
      const payload: ResearchPortfolioShareDashboardDto = {
        schemaVersion: 1,
        portfolioName: portfolio.name,
        portfolioPurpose: portfolio.purpose ?? null,
        asOf: snapshot.capturedAt,
        preparedFor: { clientName: client.name },
        branding: tenant
          ? { firmName: tenant.name, logoAvailable: Boolean(tenant.logoS3Key) }
          : null,
        layout,
        data: {
          totals: snapshot.projection.totals,
          contributions: snapshot.projection.contributions,
          coverage: snapshot.projection.coverage,
          limitations: snapshot.limitations,
          subjects: snapshot.membership.map((member) => ({
            id: member.id,
            targetKind: member.targetKind,
            targetId: member.targetId,
            label: member.label,
            disposition: member.disposition,
          })),
          sources: snapshot.versions.sources.map((source) => ({
            id: String((source as { id?: unknown }).id ?? ''),
          })),
          clientFit: clientFit
            ? {
                availability: clientFit.availability ?? 'unavailable',
                fitScore: clientFit.fitScore,
                basis: clientFit.basis ?? null,
                refreshedAt: clientFit.refreshedAt,
              }
            : null,
          changes: changes.items
            .filter((change) => RECIPIENT_EVENT_KINDS.has(change.eventKind))
            .map((change) => ({
              id: change.id,
              eventKind: change.eventKind,
              occurredAt: change.occurredAt,
              summary: change.eventKind.replaceAll('_', ' '),
            })),
          comparison: null,
        },
        snapshot: {
          id: snapshot.id,
          name: snapshot.name,
          capturedAt: snapshot.capturedAt,
          portfolioRevision: snapshot.portfolioRevision,
          calculationVersion: snapshot.calculationVersion,
        },
        publishedAt: publishedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      const token = randomBytes(32).toString('hex');
      const row = await tx.researchPortfolioShareLink.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId,
          clientId: input.clientId,
          snapshotId: snapshot.id,
          snapshotName: snapshot.name,
          designId: design.id,
          designVersion: design.version,
          branding,
          operationKey: input.operationKey,
          tokenHash: sha256(token),
          payload: payload as unknown as Prisma.InputJsonValue,
          payloadHash: sha256(JSON.stringify(payload)),
          publishedByUserId: ctx.userId,
          publishedAt,
          expiresAt,
        },
        include: { client: { select: { name: true } } },
      });
      await this.appendEvent(tx, ctx, portfolioId, portfolio.revision, 'share_link_published', {
        linkId: row.id,
        clientId: input.clientId,
        snapshotId: snapshot.id,
        designId: design.id,
        designVersion: design.version,
        branding,
      });
      return { link: this.linkDto(row), token, replayed: false };
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
      const row = await tx.researchPortfolioShareLink.findFirst({
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
        await tx.researchPortfolioShareLink.update({
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
      await tx.researchPortfolioShareLink.update({
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
      return live.row.payload as unknown as ResearchPortfolioShareDashboardDto;
    });
  }

  // ---------------------------------------------------------------- internals

  private requirePin(pin: unknown): string {
    if (typeof pin !== 'string' || !PIN_PATTERN.test(pin))
      throw new BadRequestException('The PIN must be 6 to 12 digits');
    return pin;
  }

  private assertWidgetsPublishable(
    layout: ResearchPortfolioDashboardLayoutDto,
    facts: { fitKnown: boolean },
  ): void {
    if (layout.widgets.length === 0)
      throw new BadRequestException('Add at least one widget before publishing');
    for (const widget of layout.widgets) {
      if (widget.kind === 'client_fit' && !facts.fitKnown)
        throw new ConflictException(
          `Widget ${widget.id} (client fit) cannot be published: no fit result exists for this client yet`,
        );
      if (
        widget.kind === 'image' &&
        typeof widget.settings['url'] === 'string' &&
        !/^https:\/\//.test(widget.settings['url'] as string)
      )
        throw new BadRequestException(`Widget ${widget.id} (image) must use an https address`);
    }
  }

  /** All share operations lock the existing portfolio before settings/link rows.
   * Public lookup only identifies the lock; current authority is reread afterwards. */
  private async lockPortfolio(tx: Tx, tenantId: string, portfolioId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM research_portfolios
      WHERE tenant_id = ${tenantId}::uuid AND id = ${portfolioId}::uuid FOR UPDATE`;
  }

  private async findLiveLink(tx: Tx, token: string) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
    const tokenHash = sha256(token);
    const identity = await tx.researchPortfolioShareLink.findUnique({
      where: { tokenHash },
      select: { tenantId: true, portfolioId: true },
    });
    if (!identity) return null;
    await this.lockPortfolio(tx, identity.tenantId, identity.portfolioId);
    const row = await tx.researchPortfolioShareLink.findUnique({ where: { tokenHash } });
    if (!row) return null;
    const stored = Buffer.from(row.tokenHash, 'hex'),
      given = Buffer.from(tokenHash, 'hex');
    if (stored.length !== given.length || !timingSafeEqual(stored, given)) return null;
    const now = Date.now();
    if (row.revokedAt || row.expiresAt.getTime() <= now) return null;
    if (row.lockedUntil && row.lockedUntil.getTime() > now) return null;
    const setting = await tx.researchPortfolioShareSetting.findUnique({
      where: { portfolioId: row.portfolioId },
    });
    if (!setting?.enabled || !setting.pinHash) return null;
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
    const row = await tx.researchPortfolioShareLink.findFirst({
      where: { id: linkId, tenantId: ctx.tenantId, portfolioId },
      include: { client: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException('Share link not found');
    if (row.revokedAt) return this.linkDto(row);
    const updated = await tx.researchPortfolioShareLink.update({
      where: { id: linkId },
      data: { revokedAt: new Date(), revokedByUserId: ctx.userId, revokeReason: 'manual' },
      include: { client: { select: { name: true } } },
    });
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
    const [setting, activeLinkCount] = await Promise.all([
      tx.researchPortfolioShareSetting.findUnique({ where: { portfolioId } }),
      tx.researchPortfolioShareLink.count({
        where: { tenantId, portfolioId, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
    ]);
    return {
      portfolioId,
      enabled: setting?.enabled ?? false,
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
