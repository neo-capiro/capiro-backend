import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CapabilityAuthorizationService } from '../capability-authorization.service.js';
import type { AuthorizedCapabilityContext } from '../capability-context.js';
import { isUuid } from '../capability-context.js';
import type { CapabilityDefinition, CapabilityRuntimeSchema } from '../capability-definition.js';
import { CapabilityError } from '../capability-errors.js';
import { assertCapabilityResult, type CapabilityProvenance, type CapabilityResult } from '../capability-result.js';

export interface GetRecentActivityInput {
  clientId: string;
  limit: number;
}

export interface RecentActivityItem {
  recordType: 'meeting' | 'engagement_task';
  recordId: string;
  title: string;
  occurredAt: string;
  status: string;
}

export interface RecentActivityData {
  items: RecentActivityItem[];
  totalReturned: number;
  truncated: boolean;
}

const inputSchema: CapabilityRuntimeSchema<GetRecentActivityInput> = {
  name: 'get_recent_activity.input.v1',
  parse(value) {
    const raw = (value ?? {}) as { clientId?: unknown; limit?: unknown };
    if (!isUuid(raw.clientId)) {
      throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'A valid clientId is required.');
    }
    const limit = raw.limit == null ? 20 : Number(raw.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'limit must be an integer from 1 to 50.');
    }
    return { clientId: raw.clientId, limit };
  },
};

const outputSchema: CapabilityRuntimeSchema<CapabilityResult<RecentActivityData>> = {
  name: 'get_recent_activity.output.v1',
  parse(value) {
    return assertCapabilityResult<RecentActivityData>(value, 'get_recent_activity');
  },
};

@Injectable()
export class GetRecentActivityCapability {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: CapabilityAuthorizationService,
  ) {}

  definition(): CapabilityDefinition<GetRecentActivityInput, RecentActivityData> {
    return {
      name: 'get_recent_activity',
      description: 'Return recent authorized meetings and commitments in deterministic order.',
      version: 1,
      readOnly: true,
      riskClass: 'read',
      surfaces: ['meri_chat', 'outreach', 'workspace', 'strategy', 'internal'],
      supportsClientScope: true,
      requiresClientScope: false,
      timeoutMs: 10_000,
      maxResultCount: 50,
      maxResultBytes: 64_000,
      provenanceRequired: true,
      inputSchema,
      outputSchema,
      execute: (ctx, input) => this.execute(ctx, input),
    };
  }

  async execute(
    ctx: AuthorizedCapabilityContext,
    input: GetRecentActivityInput,
  ): Promise<CapabilityResult<RecentActivityData>> {
    await this.authorization.authorizeClient(ctx, input.clientId);
    const rows = await this.prisma.withTenantUser(ctx.tenantId, ctx.actorUserId, async (tx) => {
      const [meetings, tasks] = await Promise.all([
        tx.meeting.findMany({
          where: {
            tenantId: ctx.tenantId,
            clientId: input.clientId,
            OR: [{ visibility: 'shared' }, { createdByUserId: ctx.actorUserId }],
          },
          select: { id: true, subject: true, startsAt: true, status: true, updatedAt: true },
          orderBy: [{ startsAt: 'desc' }, { id: 'asc' }],
          take: input.limit + 1,
        }),
        tx.engagementTask.findMany({
          where: { tenantId: ctx.tenantId, clientId: input.clientId },
          select: { id: true, title: true, status: true, updatedAt: true },
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
          take: input.limit + 1,
        }),
      ]);
      return { meetings, tasks };
    });

    const combined: RecentActivityItem[] = [
      ...rows.meetings.map((row) => ({
        recordType: 'meeting' as const,
        recordId: row.id,
        title: row.subject,
        occurredAt: row.startsAt.toISOString(),
        status: row.status,
      })),
      ...rows.tasks.map((row) => ({
        recordType: 'engagement_task' as const,
        recordId: row.id,
        title: row.title,
        occurredAt: row.updatedAt.toISOString(),
        status: row.status,
      })),
    ].sort((a, b) =>
      b.occurredAt.localeCompare(a.occurredAt) ||
      a.recordType.localeCompare(b.recordType) ||
      a.recordId.localeCompare(b.recordId),
    );
    const items = combined.slice(0, input.limit);
    const now = new Date().toISOString();
    const provenance: CapabilityProvenance[] = items.map((item) => ({
      recordType: item.recordType,
      recordId: item.recordId,
      sourceSystem: 'capiro',
      sourceDate: item.occurredAt,
      lastVerifiedAt: item.occurredAt,
      retrievedAt: now,
      verificationClass: 'first_party',
      classification: 'fact',
    }));

    return {
      capability: 'get_recent_activity',
      schemaVersion: 1,
      data: {
        items,
        totalReturned: items.length,
        truncated: combined.length > input.limit,
      },
      provenance,
      exclusions: [],
      scope: { tenantId: ctx.tenantId, clientId: input.clientId },
      freshness: {
        asOf: items[0]?.occurredAt ?? now,
        degraded: false,
        reasons: [],
      },
      authorization: { filtered: false, restrictedCount: 0 },
    };
  }
}
