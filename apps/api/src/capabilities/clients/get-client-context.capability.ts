import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CapabilityAuthorizationService } from '../capability-authorization.service.js';
import type { AuthorizedCapabilityContext } from '../capability-context.js';
import type { CapabilityDefinition, CapabilityRuntimeSchema } from '../capability-definition.js';
import { CapabilityError } from '../capability-errors.js';
import { assertCapabilityResult, type CapabilityProvenance, type CapabilityResult } from '../capability-result.js';
import { isUuid } from '../capability-context.js';

export interface GetClientContextInput {
  clientId: string;
}

export interface ClientContextPacket {
  client: {
    id: string;
    name: string;
    website: string | null;
    description: string | null;
    sectorTag: string | null;
    status: string;
  };
  capabilities: Array<{ id: string; name: string; type: string }>;
  recentMeetings: Array<{
    id: string;
    subject: string;
    startsAt: string;
    endsAt: string;
    status: string;
  }>;
  openCommitments: Array<{
    id: string;
    title: string;
    status: string;
    dueDate: string | null;
  }>;
  memoryReferences: [];
}

const inputSchema: CapabilityRuntimeSchema<GetClientContextInput> = {
  name: 'get_client_context.input.v1',
  parse(value) {
    const clientId = (value as { clientId?: unknown } | null)?.clientId;
    if (!isUuid(clientId)) {
      throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'A valid clientId is required.');
    }
    return { clientId };
  },
};

const outputSchema: CapabilityRuntimeSchema<CapabilityResult<ClientContextPacket>> = {
  name: 'get_client_context.output.v1',
  parse(value) {
    return assertCapabilityResult<ClientContextPacket>(value, 'get_client_context');
  },
};

@Injectable()
export class GetClientContextCapability {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: CapabilityAuthorizationService,
  ) {}

  definition(): CapabilityDefinition<GetClientContextInput, ClientContextPacket> {
    return {
      name: 'get_client_context',
      description: 'Return bounded, authorized structured context for one Capiro client.',
      version: 1,
      readOnly: true,
      riskClass: 'read',
      surfaces: ['meri_chat', 'outreach', 'workspace', 'strategy', 'internal'],
      supportsClientScope: true,
      requiresClientScope: false,
      timeoutMs: 10_000,
      maxResultCount: 40,
      maxResultBytes: 96_000,
      provenanceRequired: true,
      inputSchema,
      outputSchema,
      execute: (ctx, input) => this.execute(ctx, input),
    };
  }

  async execute(
    ctx: AuthorizedCapabilityContext,
    input: GetClientContextInput,
  ): Promise<CapabilityResult<ClientContextPacket>> {
    const client = await this.authorization.authorizeClient(ctx, input.clientId);
    const data = await this.prisma.withTenantUser(ctx.tenantId, ctx.actorUserId, async (tx) => {
      const [capabilities, meetings, tasks] = await Promise.all([
        tx.clientCapability.findMany({
          where: { tenantId: ctx.tenantId, clientId: input.clientId },
          select: { id: true, name: true, type: true },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          take: 20,
        }),
        tx.meeting.findMany({
          where: {
            tenantId: ctx.tenantId,
            clientId: input.clientId,
            OR: [{ visibility: 'shared' }, { createdByUserId: ctx.actorUserId }],
          },
          select: {
            id: true,
            subject: true,
            startsAt: true,
            endsAt: true,
            status: true,
            updatedAt: true,
          },
          orderBy: [{ startsAt: 'desc' }, { id: 'asc' }],
          take: 10,
        }),
        tx.engagementTask.findMany({
          where: {
            tenantId: ctx.tenantId,
            clientId: input.clientId,
            status: { notIn: ['done', 'canceled'] },
          },
          select: { id: true, title: true, status: true, dueDate: true, updatedAt: true },
          orderBy: [{ dueDate: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }],
          take: 10,
        }),
      ]);
      return { capabilities, meetings, tasks };
    });

    const now = new Date().toISOString();
    const provenance: CapabilityProvenance[] = [
      provenanceFor('client', client.id, client.updatedAt, now),
      ...data.capabilities.map((row) => provenanceFor('client_capability', row.id, null, now)),
      ...data.meetings.map((row) => provenanceFor('meeting', row.id, row.updatedAt, now)),
      ...data.tasks.map((row) => provenanceFor('engagement_task', row.id, row.updatedAt, now)),
    ];
    const dates = [client.updatedAt, ...data.meetings.map((row) => row.updatedAt), ...data.tasks.map((row) => row.updatedAt)];

    return {
      capability: 'get_client_context',
      schemaVersion: 1,
      data: {
        client: {
          id: client.id,
          name: client.name,
          website: client.website,
          description: client.description,
          sectorTag: client.sectorTag,
          status: client.status,
        },
        capabilities: data.capabilities,
        recentMeetings: data.meetings.map((meeting) => ({
          id: meeting.id,
          subject: meeting.subject,
          startsAt: meeting.startsAt.toISOString(),
          endsAt: meeting.endsAt.toISOString(),
          status: meeting.status,
        })),
        openCommitments: data.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          dueDate: task.dueDate?.toISOString().slice(0, 10) ?? null,
        })),
        // References, never unrestricted memory bodies. Governed memory search
        // becomes executable through search_memory in a later phase.
        memoryReferences: [],
      },
      provenance,
      exclusions: [],
      scope: { tenantId: ctx.tenantId, clientId: input.clientId },
      freshness: { asOf: newestIso(dates), degraded: false, reasons: [] },
      authorization: { filtered: false, restrictedCount: 0 },
    };
  }
}

function provenanceFor(
  recordType: string,
  recordId: string,
  verifiedAt: Date | null,
  retrievedAt: string,
): CapabilityProvenance {
  return {
    recordType,
    recordId,
    sourceSystem: 'capiro',
    sourceDate: verifiedAt?.toISOString() ?? null,
    lastVerifiedAt: verifiedAt?.toISOString() ?? null,
    retrievedAt,
    verificationClass: 'first_party',
    classification: 'fact',
  };
}

function newestIso(dates: Date[]): string {
  return new Date(Math.max(...dates.map((date) => date.getTime()))).toISOString();
}
