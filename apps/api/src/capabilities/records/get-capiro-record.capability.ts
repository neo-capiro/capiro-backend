import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CapabilityAuthorizationService } from '../capability-authorization.service.js';
import type { AuthorizedCapabilityContext } from '../capability-context.js';
import { isUuid } from '../capability-context.js';
import type { CapabilityDefinition, CapabilityRuntimeSchema } from '../capability-definition.js';
import { CapabilityError } from '../capability-errors.js';
import { assertCapabilityResult, type CapabilityResult } from '../capability-result.js';

export const CAPIRO_RECORD_TYPES = ['client', 'meeting', 'engagement_task'] as const;
export type CapiroRecordType = (typeof CAPIRO_RECORD_TYPES)[number];

export interface GetCapiroRecordInput {
  recordType: CapiroRecordType;
  recordId: string;
}

export interface CapiroRecordData {
  recordType: CapiroRecordType;
  record: Record<string, unknown>;
}

const inputSchema: CapabilityRuntimeSchema<GetCapiroRecordInput> = {
  name: 'get_capiro_record.input.v1',
  parse(value) {
    const raw = (value ?? {}) as { recordType?: unknown; recordId?: unknown };
    if (!CAPIRO_RECORD_TYPES.includes(raw.recordType as CapiroRecordType)) {
      throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'The requested record type is not allowed.');
    }
    if (!isUuid(raw.recordId)) {
      throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'A valid recordId is required.');
    }
    return { recordType: raw.recordType as CapiroRecordType, recordId: raw.recordId };
  },
};

const outputSchema: CapabilityRuntimeSchema<CapabilityResult<CapiroRecordData>> = {
  name: 'get_capiro_record.output.v1',
  parse(value) {
    return assertCapabilityResult<CapiroRecordData>(value, 'get_capiro_record');
  },
};

@Injectable()
export class GetCapiroRecordCapability {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: CapabilityAuthorizationService,
  ) {}

  definition(): CapabilityDefinition<GetCapiroRecordInput, CapiroRecordData> {
    return {
      name: 'get_capiro_record',
      description: 'Read one reauthorized Capiro record from a strict record-type allowlist.',
      version: 1,
      readOnly: true,
      riskClass: 'read',
      surfaces: ['meri_chat', 'outreach', 'workspace', 'strategy', 'internal'],
      supportsClientScope: true,
      requiresClientScope: false,
      timeoutMs: 5_000,
      maxResultCount: 1,
      maxResultBytes: 32_000,
      provenanceRequired: true,
      inputSchema,
      outputSchema,
      execute: (ctx, input) => this.execute(ctx, input),
    };
  }

  async execute(
    ctx: AuthorizedCapabilityContext,
    input: GetCapiroRecordInput,
  ): Promise<CapabilityResult<CapiroRecordData>> {
    const { record, clientId, verifiedAt } = await this.readRecord(ctx, input);
    if (clientId) await this.authorization.authorizeClient(ctx, clientId);
    const now = new Date().toISOString();
    return {
      capability: 'get_capiro_record',
      schemaVersion: 1,
      data: { recordType: input.recordType, record },
      provenance: [
        {
          recordType: input.recordType,
          recordId: input.recordId,
          sourceSystem: 'capiro',
          sourceDate: verifiedAt,
          lastVerifiedAt: verifiedAt,
          retrievedAt: now,
          verificationClass: 'first_party',
          classification: 'fact',
        },
      ],
      exclusions: [],
      scope: { tenantId: ctx.tenantId, clientId },
      freshness: { asOf: verifiedAt, degraded: false, reasons: [] },
      authorization: { filtered: false, restrictedCount: 0 },
    };
  }

  private async readRecord(
    ctx: AuthorizedCapabilityContext,
    input: GetCapiroRecordInput,
  ): Promise<{ record: Record<string, unknown>; clientId: string | null; verifiedAt: string }> {
    if (input.recordType === 'client') {
      const client = await this.authorization.authorizeClient(ctx, input.recordId);
      return {
        record: {
          id: client.id,
          name: client.name,
          website: client.website,
          description: client.description,
          sectorTag: client.sectorTag,
          status: client.status,
        },
        clientId: client.id,
        verifiedAt: client.updatedAt.toISOString(),
      };
    }

    return this.prisma.withTenantUser(ctx.tenantId, ctx.actorUserId, async (tx) => {
      if (input.recordType === 'meeting') {
        const row = await tx.meeting.findFirst({
          where: { id: input.recordId, tenantId: ctx.tenantId },
          select: {
            id: true,
            clientId: true,
            subject: true,
            startsAt: true,
            endsAt: true,
            status: true,
            visibility: true,
            createdByUserId: true,
            updatedAt: true,
          },
        });
        if (!row || (row.visibility !== 'shared' && row.createdByUserId !== ctx.actorUserId)) {
          throw new CapabilityError('CAPABILITY_NOT_FOUND', 'The requested record was not found.');
        }
        return {
          record: {
            id: row.id,
            subject: row.subject,
            startsAt: row.startsAt.toISOString(),
            endsAt: row.endsAt.toISOString(),
            status: row.status,
            visibility: row.visibility,
          },
          clientId: row.clientId,
          verifiedAt: row.updatedAt.toISOString(),
        };
      }

      const row = await tx.engagementTask.findFirst({
        where: { id: input.recordId, tenantId: ctx.tenantId },
        select: {
          id: true,
          clientId: true,
          title: true,
          description: true,
          status: true,
          dueDate: true,
          updatedAt: true,
        },
      });
      if (!row) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'The requested record was not found.');
      return {
        record: {
          id: row.id,
          title: row.title,
          description: row.description,
          status: row.status,
          dueDate: row.dueDate?.toISOString().slice(0, 10) ?? null,
        },
        clientId: row.clientId,
        verifiedAt: row.updatedAt.toISOString(),
      };
    });
  }
}
