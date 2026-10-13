import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { CompletionTaskRow } from './client-profile-fill-completion-runtime.shared.js';
import { asRecord } from './client-profile-fill.helpers.js';
import { calculateProfileCompletion } from './client-profile-fill-completion-projection.js';

export interface CompletionAuditPorts {
  persistFinding(
    tenantId: string,
    clientId: string,
    runId: string,
    input: {
      kind: string;
      targetKey: string;
      source: string;
      factKind: 'fact';
      currentValue: unknown;
      proposedValue: unknown;
      confidence: number;
      status: 'informational';
      evidence: unknown[];
    },
    task: CompletionTaskRow,
  ): Promise<boolean>;
}

export class ClientProfileFillCompletionAudit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: CompletionAuditPorts,
  ) {}

  async runCompletionAudit(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    task: CompletionTaskRow,
  ): Promise<number> {
    const snapshot = await this.readSnapshot(ctx, clientId, runId);
    const counts = Object.fromEntries(
      snapshot.findingCounts.map((row) => [row.kind, Number(row.count)]),
    );
    const federalMarket = asRecord(snapshot.client.intakeData).federalMarket;
    const completion = calculateProfileCompletion({
      federalIdentity: snapshot.client.ldaClientIds.length > 0,
      website: Boolean(snapshot.client.website?.trim()),
      overview: Boolean(snapshot.client.description?.trim()),
      governmentIdentity: Boolean(snapshot.client.uei || snapshot.client.cageCode),
      capabilities: snapshot.client._count.capabilities > 0 || Number(counts.capability ?? 0) > 0,
      relationships:
        snapshot.client._count.people > 0 &&
        snapshot.client._count.meetings + snapshot.client._count.mailThreads > 0,
      facilities: snapshot.client._count.facilities > 0 || Number(counts.facility ?? 0) > 0,
      districtNexus: snapshot.resolvedFacilities > 0,
      federalMarket: Boolean(federalMarket) || Number(counts.federal_footprint ?? 0) > 0,
      lobbyingHistory: Number(counts.lda_history ?? 0) > 0,
      advocacyHistory:
        Number(snapshot.advocacyRecords[0]?.count ?? 0) > 0 ||
        Number(counts.advocacy_record ?? 0) > 0,
      programElements: Number(counts.program_element ?? 0) > 0,
      bills: Number(counts.bill_recommendation ?? 0) > 0,
    });
    const failedTasks = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ taskType: string; errorMessage: string | null }>>(
        `SELECT task_type AS "taskType", error_message AS "errorMessage"
           FROM client_profile_fill_extension_task
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid
            AND status = 'failed'`,
        ctx.tenantId,
        clientId,
        runId,
      ),
    );
    const inserted = await this.ports.persistFinding(
      ctx.tenantId,
      clientId,
      runId,
      {
        kind: 'profile_completion',
        targetKey: 'profile-completion',
        source: 'completion_audit',
        factKind: 'fact',
        currentValue: null,
        proposedValue: {
          ...completion,
          warnings: failedTasks.map((task) => ({
            task: task.taskType,
            message: task.errorMessage ?? 'Source unavailable',
          })),
          calculatedAt: new Date().toISOString(),
        },
        confidence: 1,
        status: 'informational',
        evidence: [
          {
            label: `${completion.score}% of the defined client profile domains are complete`,
            source: 'Capiro deterministic completion audit',
            metadata: { completed: completion.completed, missing: completion.missing },
          },
        ],
      },
      task,
    );
    return inserted ? 1 : 0;
  }

  private readSnapshot(ctx: TenantContext, clientId: string, runId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const client = await tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId },
        select: {
          website: true,
          description: true,
          uei: true,
          cageCode: true,
          ldaClientIds: true,
          intakeData: true,
          _count: {
            select: {
              capabilities: true,
              people: true,
              facilities: true,
              meetings: true,
              mailThreads: true,
            },
          },
        },
      });
      if (!client) throw new NotFoundException('Client not found');
      const [resolvedFacilities, advocacyRecords, findingCounts] = await Promise.all([
        tx.clientFacility.count({
          where: {
            tenantId: ctx.tenantId,
            clientId,
            congressionalDistrict: { not: null },
          },
        }),
        tx.$queryRawUnsafe<Array<{ count: number }>>(
          `SELECT COUNT(*)::int AS count
             FROM client_advocacy_record
            WHERE tenant_id = $1::uuid AND client_id = $2::uuid`,
          ctx.tenantId,
          clientId,
        ),
        tx.$queryRawUnsafe<Array<{ kind: string; count: number }>>(
          `SELECT kind, COUNT(*)::int AS count
             FROM client_profile_fill_finding
            WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid
            GROUP BY kind`,
          ctx.tenantId,
          clientId,
          runId,
        ),
      ]);
      return { client, resolvedFacilities, advocacyRecords, findingCounts };
    });
  }
}
