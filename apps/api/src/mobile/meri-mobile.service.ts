import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from '../engagement/engagement.service.js';
import type {
  AttachmentUploadInput,
  ConfirmAttachmentInput,
  UpdateMeetingInput,
  UpdateMeetingPrepInput,
} from '../engagement/engagement.service.js';
import { readVisibleClientIds } from '../funding-opportunities/funding-opportunity-access.js';
import { MeriFeatureFlagsService } from '../meri/meri-feature-flags.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

export const MERI_MOBILE_API_VERSION = '1.0.0';
export const MERI_DISPLAY_EVENT_VERSION = '1.0.0';

type MeetingCursor = { startsAt: string; id: string };

export interface MobileMeetingListQuery {
  clientId?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface MobileAttachmentParent {
  clientId?: string;
  meetingId?: string;
  mailMessageId?: string;
  unlinked?: boolean;
}

export interface MobileDeviceRegistration {
  deviceId: string;
  environment: 'sandbox' | 'production';
  token: string;
  appVersion?: string;
}

function revisionOf(row: unknown): string | null {
  const updatedAt = (row as { updatedAt?: unknown } | null)?.updatedAt;
  if (updatedAt instanceof Date) return updatedAt.toISOString();
  if (typeof updatedAt === 'string') return new Date(updatedAt).toISOString();
  return null;
}

function withRevision<T>(row: T): T & { revision: string | null } {
  return { ...row, revision: revisionOf(row) };
}

function encodeCursor(cursor: MeetingCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined): MeetingCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<MeetingCursor>;
    if (
      typeof parsed.startsAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.startsAt)) ||
      typeof parsed.id !== 'string' ||
      !parsed.id
    ) {
      throw new Error('invalid cursor');
    }
    return { startsAt: parsed.startsAt, id: parsed.id };
  } catch {
    throw new BadRequestException({
      code: 'invalid_cursor',
      message: 'The meeting cursor is invalid or no longer readable.',
    });
  }
}

@Injectable()
export class MeriMobileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: MeriFeatureFlagsService,
    private readonly engagement: EngagementService,
  ) {}

  async assertApi(ctx: TenantContext): Promise<void> {
    if (!(await this.flags.isMeriMobileApiEnabled(ctx.tenantId))) {
      throw new NotFoundException('Mobile API is not enabled for this tenant');
    }
  }

  async assertCapability(
    ctx: TenantContext,
    capability: 'runs' | 'meetings' | 'files' | 'deviceTokens',
  ): Promise<void> {
    if (!(await this.flags.isMeriMobileCapabilityEnabled(ctx.tenantId, capability))) {
      throw new NotFoundException('Mobile capability is not enabled for this tenant');
    }
    if (capability === 'runs') {
      throw new NotFoundException('Mobile capability is not enabled for this tenant');
    }
  }

  async bootstrap(ctx: TenantContext) {
    await this.assertApi(ctx);
    const [userTenant, meetings, files, deviceTokens] = await Promise.all([
      this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const [user, tenant] = await Promise.all([
          tx.user.findFirst({
            where: { id: ctx.userId },
            select: { id: true, email: true, firstName: true, lastName: true },
          }),
          tx.tenant.findFirst({
            where: { id: ctx.tenantId },
            select: { id: true, slug: true, name: true },
          }),
        ]);
        return { user, tenant };
      }),
      this.flags.isMeriMobileCapabilityEnabled(ctx.tenantId, 'meetings'),
      this.flags.isMeriMobileCapabilityEnabled(ctx.tenantId, 'files'),
      this.flags.isMeriMobileCapabilityEnabled(ctx.tenantId, 'deviceTokens'),
    ]);
    if (!userTenant.user || !userTenant.tenant) throw new NotFoundException('Mobile principal not found');
    const clients = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const visibleClientIds = await readVisibleClientIds(tx, ctx.tenantId, ctx.userId);
      return tx.client.findMany({
        where: { id: { in: visibleClientIds } },
        select: { id: true, name: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      });
    });
    return {
      apiVersion: MERI_MOBILE_API_VERSION,
      displayEventVersion: MERI_DISPLAY_EVENT_VERSION,
      minimumAppVersion: process.env.MERI_MOBILE_MINIMUM_APP_VERSION ?? '1.0.0',
      user: { ...userTenant.user, role: ctx.role },
      tenant: userTenant.tenant,
      clients,
      features: {
        runs: false,
        meetings,
        files,
        deviceTokens,
      },
      actions: {
        runStart: { available: false, confirmation: 'none', onlineRequired: true },
        runStop: { available: false, confirmation: 'explicit_tap', onlineRequired: true },
        meetingWrite: { available: meetings, confirmation: 'explicit_save', onlineRequired: true },
        fileConfirm: { available: files, confirmation: 'explicit_upload', onlineRequired: true },
        pushRegistration: { available: deviceTokens, confirmation: 'system_permission', onlineRequired: true },
      },
      manifestIsAuthorization: false,
    };
  }

  async listMeetings(ctx: TenantContext, query: MobileMeetingListQuery) {
    await this.assertCapability(ctx, 'meetings');
    if (query.from && query.to) {
      const from = Date.parse(query.from);
      const to = Date.parse(query.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
        throw new BadRequestException({ code: 'invalid_date_window', message: 'Invalid meeting date range.' });
      }
      if (to - from > 366 * 24 * 60 * 60 * 1000) {
        throw new BadRequestException({ code: 'date_window_too_large', message: 'Meeting date range must be 366 days or less.' });
      }
    }
    const limit = Math.max(1, Math.min(100, query.limit ?? 25));
    const rows = (await this.engagement.listMeetings(ctx, {
      clientId: query.clientId,
      from: query.from,
      to: query.to,
      cursor: decodeCursor(query.cursor),
      limit: limit + 1,
    })) as unknown as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(withRevision);
    const last = items.at(-1);
    const startsAt = last?.startsAt;
    const id = last?.id;
    return {
      items,
      nextCursor:
        hasMore && id && startsAt
          ? encodeCursor({
              id: String(id),
              startsAt: startsAt instanceof Date ? startsAt.toISOString() : String(startsAt),
            })
          : null,
    };
  }

  async getMeeting(ctx: TenantContext, id: string) {
    await this.assertCapability(ctx, 'meetings');
    return withRevision(await this.engagement.getMeeting(ctx, id));
  }

  async updateMeeting(ctx: TenantContext, id: string, expectedRevision: string, input: UpdateMeetingInput) {
    await this.assertCapability(ctx, 'meetings');
    return withRevision(await this.engagement.updateMeeting(ctx, id, { ...input, expectedRevision }));
  }

  async updateNote(
    ctx: TenantContext,
    meetingId: string,
    noteId: string,
    expectedRevision: string,
    input: { body: string; confidential?: boolean; accessLevel?: string },
  ) {
    await this.assertCapability(ctx, 'meetings');
    return withRevision(
      await this.engagement.updateMeetingNote(ctx, meetingId, noteId, { ...input, expectedRevision }),
    );
  }

  async updateDebrief(
    ctx: TenantContext,
    meetingId: string,
    debriefId: string,
    expectedRevision: string,
    input: { body: string; confidential?: boolean; accessLevel?: string },
  ) {
    await this.assertCapability(ctx, 'meetings');
    return withRevision(
      await this.engagement.updateMeetingDebrief(ctx, meetingId, debriefId, { ...input, expectedRevision }),
    );
  }

  async updatePrep(
    ctx: TenantContext,
    prepId: string,
    expectedRevision: string,
    input: UpdateMeetingPrepInput,
  ) {
    await this.assertCapability(ctx, 'meetings');
    return withRevision(await this.engagement.updateMeetingPrep(ctx, prepId, { ...input, expectedRevision }));
  }

  async createUploadUrl(ctx: TenantContext, input: AttachmentUploadInput) {
    await this.assertCapability(ctx, 'files');
    return this.engagement.createAttachmentUploadUrl(ctx, input);
  }

  async confirmUpload(ctx: TenantContext, input: ConfirmAttachmentInput) {
    await this.assertCapability(ctx, 'files');
    return this.engagement.confirmAttachment(ctx, input);
  }

  async listFiles(ctx: TenantContext, parent: MobileAttachmentParent) {
    await this.assertCapability(ctx, 'files');
    return this.engagement.listAttachments(ctx, parent);
  }

  async fileStatus(ctx: TenantContext, fileId: string, parent: MobileAttachmentParent) {
    const files = await this.listFiles(ctx, parent);
    const file = (files as Array<{ id: string }>).find((candidate) => candidate.id === fileId);
    if (!file) throw new NotFoundException('File not found');
    return file;
  }

  async registerDevice(ctx: TenantContext, input: MobileDeviceRegistration) {
    await this.assertCapability(ctx, 'deviceTokens');
    const token = input.token.replace(/[\s<>]/g, '').toLowerCase();
    if (!/^[0-9a-f]{64,512}$/.test(token) || token.length % 2 !== 0) {
      throw new BadRequestException({ code: 'invalid_device_token', message: 'APNs token must be hexadecimal.' });
    }
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const now = new Date();
    const row = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await tx.mobileDeviceToken.updateMany({
        where: {
          tokenHash,
          environment: input.environment,
          userId: { not: ctx.userId },
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      return tx.mobileDeviceToken.upsert({
        where: {
          tenantId_userId_deviceId_environment: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            deviceId: input.deviceId,
            environment: input.environment,
          },
        },
        create: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          deviceId: input.deviceId,
          environment: input.environment,
          token,
          tokenHash,
          appVersion: input.appVersion,
          lastSeenAt: now,
        },
        update: {
          token,
          tokenHash,
          appVersion: input.appVersion,
          lastSeenAt: now,
          revokedAt: null,
        },
        select: { id: true, deviceId: true, environment: true, appVersion: true, updatedAt: true },
      });
    });
    return row;
  }

  async revokeDevice(
    ctx: TenantContext,
    input: Pick<MobileDeviceRegistration, 'deviceId' | 'environment'>,
  ) {
    await this.assertCapability(ctx, 'deviceTokens');
    const result = (await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.mobileDeviceToken.updateMany({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          deviceId: input.deviceId,
          environment: input.environment,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      }),
    )) as { count: number };
    return { revoked: result.count > 0 };
  }
}
