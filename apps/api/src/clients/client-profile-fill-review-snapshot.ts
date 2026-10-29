import { createHash } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { requireOwnerClient } from './client-ordered-owner.access.js';
import { stableJson } from './client-profile-fill.helpers.js';
import type { AdvancedFindingRow } from './client-profile-fill-finding-review.shared.js';

export const reviewHash = (value: unknown) =>
  createHash('sha256')
    .update(stableJson(JSON.parse(JSON.stringify(value))))
    .digest('hex');

type ReviewedFindingRow = AdvancedFindingRow & {
  runId: string;
  clientId: string;
  appliedAt: Date | null;
  createdAt: Date;
  rejectionReason: string | null;
};

/** Hash canonical records, never a previously cached research snapshot. Row locks
 * keep edits stable through application; the client lock also excludes FK inserts. */
export async function currentReviewRevision(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  write: boolean,
) {
  const records: unknown[] = [];
  for (const table of [
    'clients',
    'client_people',
    'client_facilities',
    'client_capabilities',
    'client_intel_mapping',
    'client_advocacy_record',
    'client_advocacy_matter',
    'outcome_event',
  ]) {
    records.push(
      await tx.$queryRawUnsafe<Array<{ value: unknown }>>(
        `SELECT to_jsonb(r) AS value FROM ${table} r WHERE tenant_id=$1::uuid
        AND ${table === 'clients' ? 'id' : 'client_id'}=$2::uuid ORDER BY id
        FOR ${write ? 'UPDATE' : 'SHARE'} OF r`,
        ctx.tenantId,
        clientId,
      ),
    );
  }
  return reviewHash(records);
}

export async function loadReviewFindings(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  runId: string,
  write = false,
) {
  const run = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM client_profile_fill_run WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND id=$3::uuid FOR SHARE`,
    ctx.tenantId,
    clientId,
    runId,
  );
  if (!run.length) throw new NotFoundException('Research run not found');
  return tx.$queryRawUnsafe<ReviewedFindingRow[]>(
    `SELECT id, run_id AS "runId", client_id AS "clientId", applied_at AS "appliedAt",
       created_at AS "createdAt", rejection_reason AS "rejectionReason",
       kind, target_key AS "targetKey", source, fact_kind AS "factKind",
       current_value_jsonb AS "currentValue", proposed_value_jsonb AS "proposedValue",
       evidence_jsonb AS evidence, confidence::float8 AS confidence, status, content_hash AS "contentHash"
     FROM client_profile_fill_finding WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND run_id=$3::uuid
     ORDER BY id FOR ${write ? 'UPDATE' : 'SHARE'}`,
    ctx.tenantId,
    clientId,
    runId,
  );
}

export function readReviewSnapshot(
  prisma: PrismaService,
  ctx: TenantContext,
  clientId: string,
  runId: string,
) {
  return prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    await requireOwnerClient(tx, ctx, clientId, false, false, 'share');
    const clientRevision = await currentReviewRevision(tx, ctx, clientId, false);
    const findings = await loadReviewFindings(tx, ctx, clientId, runId);
    return {
      clientId,
      runId,
      clientRevision,
      findings: findings.map((finding) => ({ ...finding, revision: reviewHash(finding) })),
    };
  });
}
