import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { isISO8601 } from 'class-validator';
import type { Prisma } from '@prisma/client';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EngagementService } from '../engagement/engagement.service.js';
import { ownMeetingWhere, ownOutreachRecordWhere } from '../engagement/engagement-access.helpers.js';

/**
 * Client relationship history — the normalized CRM activity read model
 * (Figma `906:3360`, contract §9).
 *
 * One timeline, two origins:
 *
 *   RECORDED  rows in `client_activity` — what a person logs by hand (call,
 *             note, decision, commitment, request, logged email). These have no
 *             other home, so they are stored.
 *   DERIVED   meetings, attachments and outreach records already exist as
 *             first-class rows. They are NOT copied into `client_activity`;
 *             they are unioned here at read time. Copying them would create the
 *             duplicate store §9 forbids and would go stale the moment the
 *             underlying record changed.
 *
 * Every item keeps `sourceType`/`sourceId` so the UI can open the underlying
 * meeting, file or outreach record when one exists.
 */

export const ACTIVITY_KINDS = [
  'email',
  'call',
  'note',
  'meeting',
  'outreach',
  'document',
  'request',
  'decision',
  'commitment',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Kinds a user may create by hand. Derived kinds are produced by their owner. */
export const RECORDABLE_KINDS: readonly ActivityKind[] = [
  'email',
  'call',
  'note',
  'request',
  'decision',
  'commitment',
];

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  occurredAt: string;
  createdAt?: string;
  title: string;
  body: string | null;
  personId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  pinned: boolean;
  dueAt: string | null;
  settledAt: string | null;
  /** `recorded` rows are editable; `derived` rows are owned elsewhere. */
  origin: 'recorded' | 'derived';
}

export interface CreateActivityInput {
  kind: ActivityKind;
  title: string;
  body?: string | null;
  occurredAt?: string;
  personId?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  dueAt?: string | null;
  pinned?: boolean;
}

@Injectable()
export class ClientActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engagement: EngagementService,
  ) {}

  async list(
    ctx: TenantContext,
    clientId: string,
    options: { kinds?: ActivityKind[]; limit?: number } = {},
  ): Promise<ActivityItem[]> {
    // A non-numeric ?limit= string arrives as NaN — Math.min/max propagate
    // NaN into Prisma's `take`, which throws a validation error that
    // surfaces as a 500. A malformed limit is a client error, not a server
    // fault: fall back to the default window.
    const rawLimit = options.limit ?? 200;
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 200;

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.requireClientWall(tx, ctx, clientId);
      const client = await tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
        select: { id: true },
      });
      if (!client) throw new NotFoundException('Client not found');

      const [recorded, meetings, attachments, outreach, mailThreads] = await Promise.all([
        tx.clientActivity.findMany({
          where: { tenantId: ctx.tenantId, clientId },
          orderBy: { occurredAt: 'desc' },
          take: limit,
        }),
        tx.meeting.findMany({
          // Same visibility contract as the Meetings surface and
          // getMeeting(): a colleague's private meeting must not appear in
          // this client's Timeline when its own GET would 404 — otherwise
          // the row renders but the "Open meeting" action dead-ends.
          where: { tenantId: ctx.tenantId, clientId, ...ownMeetingWhere(ctx.userId) },
          orderBy: { startsAt: 'desc' },
          take: limit,
          select: { id: true, subject: true, startsAt: true, location: true },
        }),
        tx.engagementAttachment.findMany({
          where: { prospectId: null, tenantId: ctx.tenantId, clientId },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: { id: true, fileName: true, createdAt: true, source: true },
        }),
        tx.outreachRecord.findMany({
          // Timeline must only surface drafts THIS caller can actually open.
          // getOutreachRecord() (the single-record read the "Open outreach"
          // action calls) enforces ownOutreachRecordWhere — owner-private,
          // reserved outreach_v3 roots excluded. Without the same predicate
          // here, this list showed every same-tenant colleague's draft too;
          // clicking one 404'd against the single-record read, and the
          // wizard's URL-sync effect silently treated that 404 as "no draft
          // exists" and started a brand-new blank campaign instead of
          // opening the referenced one (Q02).
          where: { tenantId: ctx.tenantId, clientId, ...ownOutreachRecordWhere(ctx.userId) },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: { id: true, title: true, subject: true, createdAt: true, type: true, status: true },
        }),
        this.engagement.listMailThreads(ctx, { clientId }),
      ]);

      const items: ActivityItem[] = [
        ...recorded.map((row) => ({
          id: row.id,
          kind: row.kind as ActivityKind,
          occurredAt: row.occurredAt.toISOString(),
          createdAt: row.createdAt?.toISOString(),
          title: row.title,
          body: row.body,
          personId: row.personId,
          sourceType: row.sourceType,
          sourceId: row.sourceId,
          pinned: row.pinned,
          dueAt: row.dueAt ? row.dueAt.toISOString() : null,
          settledAt: row.settledAt ? row.settledAt.toISOString() : null,
          origin: 'recorded' as const,
        })),
        ...meetings.map((row) => ({
          id: `meeting:${row.id}`,
          kind: 'meeting' as const,
          occurredAt: row.startsAt.toISOString(),
          title: row.subject,
          body: row.location,
          personId: null,
          sourceType: 'meeting',
          sourceId: row.id,
          pinned: false,
          dueAt: null,
          settledAt: null,
          origin: 'derived' as const,
        })),
        ...attachments.map((row) => ({
          id: `document:${row.id}`,
          kind: 'document' as const,
          occurredAt: row.createdAt.toISOString(),
          title: row.fileName,
          body: row.source,
          personId: null,
          sourceType: 'attachment',
          sourceId: row.id,
          pinned: false,
          dueAt: null,
          settledAt: null,
          origin: 'derived' as const,
        })),
        ...outreach.map((row) => ({
          id: `outreach:${row.id}`,
          kind: 'outreach' as const,
          occurredAt: row.createdAt.toISOString(),
          title: row.subject ?? row.title,
          body: [row.type, row.status].filter(Boolean).join(' · ') || null,
          personId: null,
          sourceType: 'outreach',
          sourceId: row.id,
          pinned: false,
          dueAt: null,
          settledAt: null,
          origin: 'derived' as const,
        })),
        ...mailThreads.map((row) => ({
          id: `email:${row.id}`,
          kind: 'email' as const,
          occurredAt: (row.lastMessageAt ?? row.createdAt).toISOString(),
          title: row.subject,
          body: row.snippet,
          personId: null,
          sourceType: 'mail_thread',
          sourceId: row.id,
          pinned: false,
          dueAt: null,
          settledAt: null,
          origin: 'derived' as const,
        })),
      ];

      const filtered = options.kinds?.length
        ? items.filter((item) => options.kinds!.includes(item.kind))
        : items;

      // Newest first (§9). Pinned rows are NOT hoisted here — the UI shows them
      // in their own rail so the timeline stays chronological.
      return filtered
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
        .slice(0, limit);
    });
  }

  private async requireClientWall(tx: Prisma.TransactionClient, ctx: TenantContext, clientId: string) {
    if (!await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId ?? null, clientId))
      throw new NotFoundException('Client not found');
  }

  private validateCreate(input: CreateActivityInput) {
    if (!RECORDABLE_KINDS.includes(input.kind)) {
      // meeting/document/outreach are owned by their own features; letting the
      // quick-add write one would create a second, diverging copy.
      throw new BadRequestException(`${input.kind} activity is recorded by its own feature`);
    }
    if (input.occurredAt != null) {
      const occurredAt = new Date(input.occurredAt);
      if (!isISO8601(input.occurredAt, { strict: true, strictSeparator: true }) || !Number.isFinite(occurredAt.getTime())) throw new BadRequestException('Enter a valid activity date and time');
      if (occurredAt.getTime() > Date.now()) throw new BadRequestException('Activity must have already occurred');
    }
    if (input.dueAt && input.kind !== 'commitment' && input.kind !== 'request') {
      throw new BadRequestException('Only commitments and requests carry a due date');
    }
  }

  async create(ctx: TenantContext, clientId: string, input: CreateActivityInput) {
    this.validateCreate(input);
    return this.prisma.withTenant(ctx.tenantId, (tx) => this.createInTransaction(tx, ctx, clientId, input));
  }

  /** Compose canonical creation with an owner's receipt in the same transaction. */
  async createInTransaction(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    clientId: string,
    input: CreateActivityInput,
  ) {
    this.validateCreate(input);
    await this.requireClientWall(tx, ctx, clientId);
    const client = await tx.client.findFirst({
      where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
      select: { id: true },
    });
    if (!client) throw new NotFoundException('Client not found');

    // personId must name a contact of THIS client. Without the check the
    // FK constraint (client_person.id) happily accepts another client's —
    // or another tenant's — person, and the activity row then points at a
    // contact the caller cannot see (cross-client data write defect found
    // in the boundary audit).
    if (input.personId) {
      const person = await tx.clientPerson.findFirst({
        where: { id: input.personId, tenantId: ctx.tenantId, clientId },
        select: { id: true },
      });
      if (!person) throw new BadRequestException('That person is not a contact of this client');
    }

    return tx.clientActivity.create({
      data: {
        tenantId: ctx.tenantId,
        clientId,
        kind: input.kind,
        title: input.title.trim(),
        body: input.body?.trim() || null,
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
        personId: input.personId ?? null,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        pinned: input.pinned ?? false,
        actorUserId: ctx.userId ?? null,
        createdByUserId: ctx.userId ?? null,
      },
    });
  }

  /** Pin/unpin, settle a commitment, or edit a recorded row. */
  async update(
    ctx: TenantContext,
    clientId: string,
    id: string,
    input: { pinned?: boolean; settled?: boolean; title?: string; body?: string | null },
  ) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.requireClientWall(tx, ctx, clientId);
      const existing = await tx.clientActivity.findFirst({
        where: { id, tenantId: ctx.tenantId, clientId },
        select: { id: true, dueAt: true },
      });
      // A derived row has no id in this table, so this is also the guard that
      // stops anyone trying to pin a meeting through the activity endpoint.
      if (!existing) throw new NotFoundException('Activity not found');

      if (input.settled != null && !existing.dueAt) {
        throw new BadRequestException('Only a commitment or request can be settled');
      }

      return tx.clientActivity.update({
        where: { id },
        data: {
          ...(input.pinned != null ? { pinned: input.pinned } : {}),
          ...(input.settled != null ? { settledAt: input.settled ? new Date() : null } : {}),
          ...(input.title != null ? { title: input.title.trim() } : {}),
          ...('body' in input ? { body: input.body?.trim() || null } : {}),
        },
      });
    });
  }

  async remove(ctx: TenantContext, clientId: string, id: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.requireClientWall(tx, ctx, clientId);
      const result = await tx.clientActivity.deleteMany({
        where: { id, tenantId: ctx.tenantId, clientId },
      });
      if (result.count === 0) throw new NotFoundException('Activity not found');
      return { ok: true };
    });
  }
}

