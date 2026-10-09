import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { KrispNotetakerPreference, Prisma } from '@prisma/client';
import type { TenantContext, TenantRole } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  krispImportMode,
  krispNotetakerEnabled,
  krispTenantEnabled,
} from '../../common/krisp-notetaker-flags.js';
import { MeetingCapturePersistenceService } from '../../meeting-capture/meeting-capture-persistence.service.js';
import { formatDebriefBody } from '../notetaker/meeting-debrief-format.js';
import { MeriManagedMcpService } from '../../meri/meri-managed-mcp.service.js';
import { managedAppAvailable } from '../../meri/meri-managed-mcp.helpers.js';
import { ownMeetingWhere } from '../engagement-access.helpers.js';
import { MeetingNotesCryptoService } from '../meeting-notes-crypto.service.js';
import { EngagementRuntimePolicyService } from '../runtime/engagement-runtime-policy.service.js';
import {
  KRISP_CATALOG_ID,
  KRISP_LEASE_MS,
  krispArguments,
  krispPayload,
  krispRows,
  krispNotes,
  krispTranscript,
  krispNextPage,
  matchKrispMeeting,
  normalizeKrispMeeting,
} from './krisp.helpers.js';

const scope = (ctx: TenantContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });
const publicImport = {
  id: true,
  documentId: true,
  title: true,
  startsAt: true,
  meetingId: true,
  status: true,
  error: true,
  noteId: true,
  debriefId: true,
  updatedAt: true,
} as const;

@Injectable()
export class KrispNotetakerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly managed: MeriManagedMcpService,
    private readonly crypto: MeetingNotesCryptoService,
    private readonly runtime: EngagementRuntimePolicyService,
    private readonly persistence: MeetingCapturePersistenceService,
  ) {}

  private async assertEnabled(ctx: TenantContext) {
    const tenant = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.tenant.findUnique({ where: { id: ctx.tenantId }, select: { slug: true, settings: true } }),
    );
    if (!tenant || !krispNotetakerEnabled(tenant.settings))
      throw new NotFoundException('Krisp Notetaker is not enabled for this organization.');
    return krispImportMode(tenant.slug);
  }

  async status(ctx: TenantContext) {
    const importMode = await this.assertEnabled(ctx);
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => ({
      importMode,
      preference: await tx.krispNotetakerPreference.findUnique({
        where: { tenantId_userId: scope(ctx) },
        select: {
          enabled: true,
          folderId: true,
          enabledAt: true,
          lastCheckedAt: true,
          lastError: true,
        },
      }),
      imports: await tx.krispMeetingImport.findMany({
        where: scope(ctx),
        orderBy: { startsAt: 'desc' },
        take: 50,
        select: publicImport,
      }),
    }));
  }

  async configure(ctx: TenantContext, input: { enabled: boolean; folderId?: string | null }) {
    const importMode = await this.assertEnabled(ctx);
    if (!input.enabled) {
      await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
        tx.krispNotetakerPreference.updateMany({
          where: scope(ctx),
          data: { enabled: false, revision: { increment: 1 } },
        }),
      );
      return this.status(ctx);
    }
    const app = (await this.managed.listApps(ctx)).find((item) => item.id === 'krisp');
    if (!app?.connected) throw new BadRequestException('Connect your Krisp account first.');
    const schemas = await this.managed.schemasForMeriV3(ctx);
    for (const name of ['search_meetings', 'get_multiple_documents']) {
      const schema = schemas.find(
        (tool) => tool.appId === 'krisp' && tool.name.endsWith('__' + name),
      );
      if (!schema)
        throw new BadRequestException(
          'Krisp is missing required meeting access. Reconnect your account.',
        );
      try {
        krispArguments(
          schema.input_schema,
          name === 'search_meetings'
            ? { since: new Date().toISOString(), folderId: input.folderId }
            : {
                ids: ['0'.repeat(32)],
                content: importMode === 'direct_notes' ? 'notes' : 'transcript',
              },
        );
      } catch {
        throw new BadRequestException(
          'This Krisp tool version is not supported for automatic import yet.',
        );
      }
    }
    if (input.folderId) {
      const folders = await this.folders(ctx);
      if (!folders.some((folder) => folder.id === input.folderId))
        throw new BadRequestException('Choose a folder from your connected Krisp account.');
    }
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const server = await tx.clioMcpServer.findFirst({
        where: {
          tenantId: ctx.tenantId,
          ownerUserId: ctx.userId,
          scope: 'user',
          catalogId: KRISP_CATALOG_ID,
          enabled: true,
          connectionStatus: 'connected',
        },
      });
      if (!server) throw new BadRequestException('Connect your Krisp account first.');
      const previous = await tx.krispNotetakerPreference.findUnique({
        where: { tenantId_userId: scope(ctx) },
      });
      const folderId = input.folderId || null;
      const unchanged =
        previous?.enabled && previous.serverId === server.id && previous.folderId === folderId;
      await tx.krispNotetakerPreference.upsert({
        where: { tenantId_userId: scope(ctx) },
        create: {
          ...scope(ctx),
          serverId: server.id,
          enabled: true,
          folderId,
          enabledAt: new Date(),
        },
        update: {
          serverId: server.id,
          enabled: true,
          folderId,
          lastError: null,
          ...(unchanged ? {} : { enabledAt: new Date(), revision: { increment: 1 } }),
        },
      });
      if (!unchanged)
        await tx.krispMeetingImport.updateMany({
          where: { ...scope(ctx), status: { notIn: ['done', 'skipped'] } },
          data: { status: 'skipped', leaseToken: null, leaseUntil: null, error: null },
        });
    });
    return this.status(ctx);
  }

  private async read(
    ctx: TenantContext,
    name: string,
    values: Parameters<typeof krispArguments>[1],
  ) {
    await this.assertEnabled(ctx);
    this.runtime.assertExternalAction('integration_sync');
    const schema = (await this.managed.schemasForMeriV3(ctx)).find(
      (tool) => tool.appId === 'krisp' && tool.name.endsWith('__' + name),
    );
    if (!schema)
      throw new ServiceUnavailableException('Reconnect Krisp to restore meeting access.');
    return krispPayload(
      await this.managed.executeRead(
        ctx,
        schema.name,
        krispArguments(schema.input_schema, values),
        { structuredRead: true },
      ),
    );
  }

  async folders(ctx: TenantContext) {
    const payload = await this.read(ctx, 'list_folders', {});
    return krispRows(payload, ['folders', 'results', 'items']).flatMap((row) => {
      const id = row.id ?? row.folder_id;
      return typeof id === 'string' && typeof row.name === 'string' ? [{ id, name: row.name }] : [];
    });
  }

  async candidates(ctx: TenantContext, id: string) {
    await this.assertEnabled(ctx);
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const item = await tx.krispMeetingImport.findFirst({ where: { id, ...scope(ctx) } });
      if (!item) throw new NotFoundException('Import not found.');
      return tx.meeting.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...ownMeetingWhere(ctx.userId),
          startsAt: {
            gte: new Date(item.startsAt.getTime() - 86_400_000),
            lte: new Date(item.startsAt.getTime() + 86_400_000),
          },
        },
        select: { id: true, subject: true, startsAt: true },
        orderBy: { startsAt: 'asc' },
        take: 100,
      });
    });
  }

  async assign(ctx: TenantContext, id: string, meetingId: string) {
    await this.assertEnabled(ctx);
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const preference = await tx.krispNotetakerPreference.findUnique({
        where: { tenantId_userId: scope(ctx) },
      });
      if (!preference?.enabled) throw new BadRequestException('Enable automatic import first.');
      const meeting = await tx.meeting.findFirst({
        where: {
          id: meetingId,
          tenantId: ctx.tenantId,
          ...ownMeetingWhere(ctx.userId),
        },
      });
      if (!meeting) throw new NotFoundException('Meeting not found.');
      const changed = await tx.krispMeetingImport.updateMany({
        where: { id, ...scope(ctx), status: { in: ['needs_match', 'failed'] } },
        data: { meetingId, status: 'pending', attempts: 0, error: null },
      });
      if (!changed.count) throw new BadRequestException('This import cannot be reassigned.');
    });
    return this.status(ctx);
  }

  /** Called only by the existing Engagement background owner. */
  async sweep() {
    this.runtime.assertBackgroundOwner('krisp-notetaker');
    if (!managedAppAvailable('krisp', {})) return;
    const preferences = await this.prisma.withSystem((tx) =>
      tx.krispNotetakerPreference.findMany({
        where: { enabled: true },
        orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
        take: 100,
      }),
    );
    for (const preference of preferences) {
      const ctx = await this.context(preference);
      if (!ctx || !(await krispTenantEnabled(this.prisma, ctx.tenantId))) continue;
      let error: string | null = null;
      try {
        await this.assertActive(ctx, preference);
        try {
          await this.discover(ctx, preference);
        } catch {
          error =
            'Meeting discovery could not finish. Check your Krisp connection or selected folder.';
        }
        const imports = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
          tx.krispMeetingImport.findMany({
            where: {
              ...scope(ctx),
              meetingId: { not: null },
              attempts: { lt: 10 },
              OR: [
                { status: { in: ['pending', 'failed'] } },
                { status: 'processing', leaseUntil: { lt: new Date() } },
              ],
            },
            orderBy: { updatedAt: 'asc' },
            take: 10,
          }),
        );
        for (const item of imports) await this.process(ctx, preference, item.id);
      } catch {
        // Provider errors may contain meeting text or OAuth URLs. Keep them out of logs/UI.
        error = 'Import paused. Check your Krisp connection and selected folder, then try again.';
      }
      await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
        tx.krispNotetakerPreference.updateMany({
          where: { id: preference.id, revision: preference.revision },
          data: { lastCheckedAt: new Date(), lastError: error },
        }),
      );
    }
  }

  private async discover(ctx: TenantContext, preference: KrispNotetakerPreference) {
    // A rolling overlap catches delayed notes; existing pending imports retry independently.
    const since = new Date(Math.max(preference.enabledAt.getTime(), Date.now() - 7 * 86_400_000));
    let cursor: string | undefined;
    let offset = 0;
    const cursors = new Set<string>();
    for (let page = 0; page < 20; page++) {
      await this.assertActive(ctx, preference);
      const payload = await this.read(ctx, 'search_meetings', {
        since: since.toISOString(),
        until: new Date().toISOString(),
        folderId: preference.folderId,
        cursor,
        offset,
        page: page + 1,
      });
      const rows = krispRows(payload, ['meetings', 'results', 'items', 'documents']);
      for (const raw of rows) {
        const source = normalizeKrispMeeting(raw);
        if (!source) throw new Error('Unsupported Krisp meeting metadata.');
        if (source.startsAt < since || source.startsAt.getTime() > Date.now()) continue;
        await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
          const existing = await tx.krispMeetingImport.findUnique({
            where: { tenantId_userId_documentId: { ...scope(ctx), documentId: source.documentId } },
          });
          if (existing) return;
          const candidates = await tx.meeting.findMany({
            where: {
              tenantId: ctx.tenantId,
              ...ownMeetingWhere(ctx.userId),
              startsAt: {
                gte: new Date(source.startsAt.getTime() - 600_000),
                lte: new Date(source.startsAt.getTime() + 600_000),
              },
            },
            select: {
              id: true,
              subject: true,
              startsAt: true,
              iCalUId: true,
              externalId: true,
              joinLink: true,
              organizerEmail: true,
            },
          });
          const meetingId = matchKrispMeeting(source, candidates);
          await tx.krispMeetingImport.createMany({
            data: [
              {
                ...scope(ctx),
                documentId: source.documentId,
                title: source.title,
                startsAt: source.startsAt,
                meetingId,
                status: meetingId ? 'pending' : 'needs_match',
              },
            ],
            skipDuplicates: true,
          });
        });
      }
      const next = krispNextPage(payload, rows.length, offset);
      if (!next.more) return;
      if (!rows.length) throw new Error('Empty Krisp pagination page.');
      offset += rows.length;
      if (next.cursor) {
        if (cursors.has(next.cursor)) throw new Error('Krisp pagination repeated.');
        cursors.add(next.cursor);
      }
      cursor = next.cursor;
    }
    throw new Error('Krisp import window exceeds the page limit. Select a smaller folder.');
  }

  private async process(ctx: TenantContext, preference: KrispNotetakerPreference, id: string) {
    const leaseToken = randomUUID();
    const claimed = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.krispMeetingImport.updateMany({
        where: {
          id,
          ...scope(ctx),
          attempts: { lt: 10 },
          OR: [
            { status: { in: ['pending', 'failed'] } },
            { status: 'processing', leaseUntil: { lt: new Date() } },
          ],
        },
        data: {
          status: 'processing',
          leaseToken,
          leaseUntil: new Date(Date.now() + KRISP_LEASE_MS),
          attempts: { increment: 1 },
        },
      }),
    );
    if (!claimed.count) return;
    try {
      const importMode = await this.assertActive(ctx, preference);
      const item = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
        tx.krispMeetingImport.findFirst({ where: { id, ...scope(ctx), leaseToken } }),
      );
      if (!item?.meetingId) throw new Error('Choose a meeting.');
      const meeting = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.meeting.findFirst({
          where: { id: item.meetingId!, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
          select: { id: true, clientId: true, updatedAt: true },
        }),
      );
      if (!meeting) throw new Error('Meeting is no longer available.');
      const direct = importMode === 'direct_notes';
      const sourceText = (direct ? krispNotes : krispTranscript)(
        await this.read(ctx, 'get_multiple_documents', {
          ids: [item.documentId],
          content: direct ? 'notes' : 'transcript',
        }),
        item.documentId,
      );
      if (!sourceText) {
        await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
          tx.krispMeetingImport.updateMany({
            where: { id, ...scope(ctx), leaseToken },
            data: {
              status: 'pending',
              leaseToken: null,
              leaseUntil: null,
              attempts: { decrement: 1 },
              error: direct
                ? 'Waiting for Krisp to finish the notes.'
                : 'Waiting for Krisp to finish the transcript.',
            },
          }),
        );
        return;
      }
      if ((await this.assertActive(ctx, preference)) !== importMode)
        throw new Error('Krisp import mode changed.');
      this.runtime.assertExternalAction('meeting_debrief_generate');
      const generatedBody = formatDebriefBody(
        await this.persistence.generateMeetingDebriefDraft(ctx, meeting.id, {
          method: 'upload',
          sourceText,
        }),
      );
      // C2 keeps Krisp's finished notes in Meeting Notes and generates only the
      // Debrief. Other tenants retain their transcript -> generated pair flow.
      const noteEncrypted = this.crypto.encrypt(direct ? sourceText : generatedBody);
      const debriefEncrypted = direct ? this.crypto.encrypt(generatedBody) : noteEncrypted;
      await this.assertActive(ctx, preference);
      await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        // Lock consent, connection, tenant flag, membership, and meeting before committing.
        // The lease fences old workers; both artifacts and completion commit together.
        await tx.$queryRaw`SELECT id FROM krisp_notetaker_preferences WHERE id = ${preference.id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM clio_mcp_servers WHERE id = ${preference.serverId}::uuid FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${ctx.tenantId}::uuid FOR SHARE`;
        await tx.$queryRaw`SELECT user_id FROM tenant_memberships WHERE tenant_id = ${ctx.tenantId}::uuid AND user_id = ${ctx.userId}::uuid FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM meetings WHERE id = ${meeting.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
        if ((await this.assertActiveTx(tx, ctx, preference)) !== importMode)
          throw new Error('Krisp import mode changed.');
        const current = await tx.meeting.findFirst({
          where: {
            id: meeting.id,
            tenantId: ctx.tenantId,
            ...ownMeetingWhere(ctx.userId),
          },
        });
        if (
          !current ||
          current.clientId !== meeting.clientId ||
          current.updatedAt.getTime() !== meeting.updatedAt.getTime()
        )
          throw new Error('Meeting changed during import.');
        const completion = await tx.krispMeetingImport.updateMany({
          where: {
            id,
            ...scope(ctx),
            status: 'processing',
            leaseToken,
            leaseUntil: { gt: new Date() },
          },
          data: { status: 'done', leaseToken: null, leaseUntil: null, error: null },
        });
        if (!completion.count) throw new Error('Import lease expired.');
        const data = {
          tenantId: ctx.tenantId,
          meetingId: meeting.id,
          clientId: current.clientId,
          authorUserId: ctx.userId,
          confidential: true,
          accessLevel: 'tenant_admins_and_author',
        };
        const note = await tx.meetingNote.create({
          data: {
            ...data,
            ...noteEncrypted,
            status: 'approved',
            approvedAt: new Date(),
            approvedByUserId: ctx.userId,
          },
        });
        const debrief = await tx.meetingDebrief.create({
          data: { ...data, ...debriefEncrypted, status: 'approved' },
        });
        await tx.krispMeetingImport.update({
          where: { id },
          data: { noteId: note.id, debriefId: debrief.id },
        });
      });
    } catch {
      await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
        tx.krispMeetingImport.updateMany({
          where: { id, ...scope(ctx), leaseToken },
          data: {
            status: 'failed',
            leaseToken: null,
            leaseUntil: null,
            error:
              'Import could not finish. Check your Krisp connection or choose the meeting again. Automatic retries are limited to 10 attempts.',
          },
        }),
      );
    }
  }

  private async assertActive(ctx: TenantContext, preference: KrispNotetakerPreference) {
    this.runtime.assertBackgroundOwner('krisp-notetaker');
    if (!managedAppAvailable('krisp', ctx)) throw new Error('Krisp is disabled.');
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      this.assertActiveTx(tx, ctx, preference),
    );
  }

  private async assertActiveTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    preference: KrispNotetakerPreference,
  ) {
    const [tenant, membership, current, server] = await Promise.all([
      tx.tenant.findUnique({ where: { id: ctx.tenantId } }),
      tx.tenantMembership.findFirst({ where: { ...scope(ctx), status: 'active' } }),
      tx.krispNotetakerPreference.findFirst({
        where: { id: preference.id, ...scope(ctx), enabled: true, revision: preference.revision },
      }),
      tx.clioMcpServer.findFirst({
        where: {
          id: preference.serverId,
          tenantId: ctx.tenantId,
          ownerUserId: ctx.userId,
          scope: 'user',
          catalogId: KRISP_CATALOG_ID,
          enabled: true,
          connectionStatus: 'connected',
        },
      }),
    ]);
    if (
      !tenant ||
      tenant.status !== 'active' ||
      !krispNotetakerEnabled(tenant.settings) ||
      !membership ||
      !current ||
      !server
    )
      throw new Error('Krisp authorization changed.');
    return krispImportMode(tenant.slug);
  }

  private async context(preference: KrispNotetakerPreference): Promise<TenantContext | null> {
    return this.prisma.withSystem(async (tx) => {
      const [tenant, user, membership] = await Promise.all([
        tx.tenant.findUnique({ where: { id: preference.tenantId } }),
        tx.user.findUnique({ where: { id: preference.userId } }),
        tx.tenantMembership.findFirst({
          where: { tenantId: preference.tenantId, userId: preference.userId, status: 'active' },
        }),
      ]);
      if (!tenant || tenant.status !== 'active' || !user || !membership) return null;
      return {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        userId: user.id,
        clerkUserId: user.clerkUserId,
        role: membership.role as TenantRole,
      };
    });
  }
}
