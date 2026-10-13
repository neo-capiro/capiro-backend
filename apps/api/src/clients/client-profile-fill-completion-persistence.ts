import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { asRecord, stableJson } from './client-profile-fill.helpers.js';
import type { CompletionTaskRow } from './client-profile-fill-completion-runtime.shared.js';

export interface CompletionFindingInput {
  kind: string;
  targetKey: string;
  source: string;
  factKind: 'fact' | 'recommendation';
  currentValue: unknown;
  proposedValue: unknown;
  confidence: number;
  evidence: unknown[];
  status: 'pending' | 'informational';
}

/** Canonical tenant finding ledger, confirmed identity mappings and merged cursors. */
export class ClientProfileFillCompletionPersistence {
  constructor(private readonly prisma: PrismaService) {}
  async addFinding(
    tenantId: string,
    clientId: string,
    runId: string,
    input: CompletionFindingInput,
    task?: Pick<CompletionTaskRow, 'id' | 'workerId'>,
  ): Promise<boolean> {
    const contentHash = createHash('sha256')
      .update(
        stableJson({
          kind: input.kind,
          targetKey: input.targetKey,
          source: input.source,
          proposedValue: input.proposedValue,
        }),
      )
      .digest('hex');
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (task && !(await this.hasTaskLease(tx, tenantId, clientId, runId, task))) return false;
      if (await this.hasTerminalFinding(tx, tenantId, clientId, contentHash)) return false;
      await this.retirePending(tx, tenantId, clientId, runId, contentHash);
      const inserted = await this.insertFinding(tx, tenantId, clientId, runId, input, contentHash);
      return Number(inserted) > 0;
    });
  }
  private async hasTaskLease(
    tx: Prisma.TransactionClient,
    tenantId: string,
    clientId: string,
    runId: string,
    task: Pick<CompletionTaskRow, 'id' | 'workerId'>,
  ): Promise<boolean> {
    // Serialize the audit write with retry/cancel so an invalidated audit
    // cannot append a stale score after its replacement has finished.
    const lease = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM client_profile_fill_extension_task
            WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
              AND run_id = $4::uuid AND status = 'running' AND worker_id = $5
            FOR UPDATE`,
      task.id,
      tenantId,
      clientId,
      runId,
      task.workerId,
    );
    return Boolean(lease.length);
  }
  private async hasTerminalFinding(
    tx: Prisma.TransactionClient,
    tenantId: string,
    clientId: string,
    contentHash: string,
  ): Promise<boolean> {
    const terminal = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id
           FROM client_profile_fill_finding
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND content_hash = $3
            AND status IN ('accepted', 'rejected')
          LIMIT 1`,
      tenantId,
      clientId,
      contentHash,
    );
    return Boolean(terminal.length);
  }
  private async retirePending(
    tx: Prisma.TransactionClient,
    tenantId: string,
    clientId: string,
    runId: string,
    contentHash: string,
  ) {
    await tx.$executeRawUnsafe(
      `UPDATE client_profile_fill_finding
            SET status = 'informational', updated_at = now()
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND content_hash = $3
            AND run_id <> $4::uuid AND status = 'pending'`,
      tenantId,
      clientId,
      contentHash,
      runId,
    );
  }
  private async insertFinding(
    tx: Prisma.TransactionClient,
    tenantId: string,
    clientId: string,
    runId: string,
    input: CompletionFindingInput,
    contentHash: string,
  ) {
    return tx.$executeRawUnsafe(
      `INSERT INTO client_profile_fill_finding
           (run_id, tenant_id, client_id, kind, target_key, source, fact_kind,
            current_value_jsonb, proposed_value_jsonb, evidence_jsonb, confidence,
            status, content_hash)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7,
                 $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13)
         ON CONFLICT (run_id, content_hash) DO NOTHING`,
      runId,
      tenantId,
      clientId,
      input.kind,
      input.targetKey,
      input.source,
      input.factKind,
      JSON.stringify(input.currentValue ?? null),
      JSON.stringify(input.proposedValue),
      JSON.stringify(input.evidence),
      Math.max(0, Math.min(1, input.confidence)),
      input.status,
      contentHash,
    );
  }
  async getConfirmedIntelMappingKeys(
    ctx: TenantContext,
    clientId: string,
    source: string,
  ): Promise<Set<string>> {
    const confirmedMappings = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId, source, confirmed: true },
        select: { externalId: true },
      }),
    );
    return new Set(confirmedMappings.map((m) => m.externalId));
  }
  async getCursor(tenantId: string, clientId: string, source: string) {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ watermark: unknown }>>(
        `SELECT watermark_jsonb AS watermark
           FROM client_profile_fill_source_cursor
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND source = $3`,
        tenantId,
        clientId,
        source,
      ),
    );
    return asRecord(rows[0]?.watermark);
  }
  async recordCursor(
    tenantId: string,
    clientId: string,
    source: string,
    watermark: Record<string, unknown>,
  ) {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO client_profile_fill_source_cursor
           (tenant_id, client_id, source, watermark_jsonb, last_successful_at,
            last_attempt_at, last_error, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, now(), now(), NULL, now())
         ON CONFLICT (tenant_id, client_id, source) DO UPDATE
           SET watermark_jsonb = client_profile_fill_source_cursor.watermark_jsonb || EXCLUDED.watermark_jsonb,
               last_successful_at = now(), last_attempt_at = now(), last_error = NULL,
               updated_at = now()`,
        tenantId,
        clientId,
        source,
        JSON.stringify(watermark),
      ),
    );
  }
}
