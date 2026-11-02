import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { requireOwnerClient } from './client-ordered-owner.access.js';
import { stableJson } from './client-profile-fill.helpers.js';
import { researchWebsite } from './client-profile-fill-research-inputs.js';
import type { StartClientProfileFillWorkflowInput } from './client-profile-fill-workflow.service.js';

export type ResearchStartRequest = { schemaVersion: 1; requestId: string; sha256: string };

/** Existing run UUID/setup owns replay. No additional command or reservation ledger. */
export function researchStartRequest(
  ctx: TenantContext, clientId: string, input: StartClientProfileFillWorkflowInput,
): ResearchStartRequest | undefined {
  if (input.requestId === undefined) return undefined;
  if (!isUUID(input.requestId)) throw new BadRequestException('Invalid research request ID');
  const command = {
    schemaVersion: 1, tenantId: ctx.tenantId, clientId, actorId: ctx.userId,
    sources: input.sources === undefined ? null : [...new Set(input.sources)].sort(),
    attachmentIds: [...new Set(input.attachmentIds ?? [])].sort(),
    ldaClientIds: [...new Set(input.ldaClientIds ?? [])].sort((a, b) => a - b),
    website: researchWebsite(input.website),
  };
  return { schemaVersion: 1, requestId: input.requestId.toLowerCase(),
    sha256: createHash('sha256').update(stableJson(command)).digest('hex') };
}

export async function matchingResearchStart(
  tx: Prisma.TransactionClient, ctx: TenantContext, clientId: string, request: ResearchStartRequest,
): Promise<string | null> {
  const rows = await tx.$queryRawUnsafe<Array<{ id: string; actorId: string; request: ResearchStartRequest | null }>>(
    `SELECT id::text AS id, created_by_user_id::text AS "actorId", setup_jsonb->'startRequest' AS request
     FROM client_profile_fill_run WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND id=$3::uuid`,
    ctx.tenantId, clientId, request.requestId,
  );
  if (!rows.length) return null;
  const row = rows[0]!;
  if (row.actorId !== ctx.userId || row.request?.schemaVersion !== 1 ||
    row.request.requestId !== request.requestId || row.request.sha256 !== request.sha256)
    throw new ConflictException('Research request identity or inputs changed; the original run was not restarted');
  return row.id;
}

export function readResearchStart(
  prisma: PrismaService, ctx: TenantContext, clientId: string, request: ResearchStartRequest,
) {
  return prisma.withTenantUser(ctx.tenantId, ctx.userId, async tx => {
    await requireOwnerClient(tx, ctx, clientId, false, false, 'share');
    return matchingResearchStart(tx, ctx, clientId, request);
  });
}
