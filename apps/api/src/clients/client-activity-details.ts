import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  ClientObjectiveDestinationError,
  requireClientObjectiveDestinationRevision,
  type TenantContext,
} from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
export const activityDetailFields = {
  direction: z.enum(['we_owe', 'they_owe']).nullable().optional(),
  // A manually entered label, not an assertion about a Directory identity.
  counterparty: z.string().trim().min(1).max(300).nullable().optional(),
  objectiveId: uuid.nullable().optional(),
  objectiveVersion: z.number().int().min(1).max(2147483647).nullable().optional(),
};
export const activityDetailsInput = z
  .object(activityDetailFields)
  .strict()
  .refine(
    (input) => (input.objectiveId != null) === (input.objectiveVersion != null),
    'Objective ID and version are required together',
  );
export type ActivityDetailsInput = z.infer<typeof activityDetailsInput>;
export interface ActivityDetails {
  direction: 'we_owe' | 'they_owe' | null;
  counterparty: string | null;
  objective: {
    objectiveId: string;
    objectiveVersion: number;
    objectiveRevisionId: string;
    availability: 'current' | 'changed' | 'unavailable';
  } | null;
}
const storedDetails = z
  .object({
    version: z.literal(1),
    direction: z.enum(['we_owe', 'they_owe']).nullable(),
    counterparty: z.string().min(1).max(300).nullable(),
    objective: z
      .object({
        objectiveId: uuid,
        objectiveVersion: z.number().int().min(1).max(2147483647),
        objectiveRevisionId: uuid,
      })
      .strict()
      .nullable(),
  })
  .strict();

export function normalizeActivityDetails(input: ActivityDetailsInput, kind: string) {
  const result = activityDetailsInput.safeParse({
    direction: input.direction,
    counterparty: input.counterparty,
    objectiveId: input.objectiveId,
    objectiveVersion: input.objectiveVersion,
  });
  if (!result.success) throw new BadRequestException('Invalid activity details');
  if (result.data.direction && kind !== 'commitment' && kind !== 'request')
    throw new BadRequestException('Only commitments and requests carry an obligation direction');
  return result.data;
}

export async function activityDetailsMetadata(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  input: ActivityDetailsInput,
) {
  let objective: z.infer<typeof storedDetails>['objective'] = null;
  if (input.objectiveId && input.objectiveVersion) {
    try {
      const binding = await requireClientObjectiveDestinationRevision(tx, ctx, {
        clientId,
        objectiveId: input.objectiveId,
        objectiveVersion: input.objectiveVersion,
      });
      objective = {
        objectiveId: binding.objectiveId,
        objectiveVersion: binding.objectiveVersion,
        objectiveRevisionId: binding.objectiveRevisionId,
      };
    } catch (error) {
      if (!(error instanceof ClientObjectiveDestinationError)) throw error;
      if (error.code === 'OBJECTIVE_VERSION_CONFLICT')
        throw new ConflictException('Objective changed; select its current version');
      if (error.code === 'OBJECTIVE_DESTINATION_INVALID')
        throw new BadRequestException('Invalid Objective binding');
      throw new NotFoundException('Objective not found');
    }
  }
  if (!input.direction && !input.counterparty && !objective) return undefined;
  return {
    quickLog: {
      version: 1 as const,
      direction: input.direction ?? null,
      counterparty: input.counterparty ?? null,
      objective,
    },
  };
}

function readDetails(metadata: unknown) {
  const envelope = z.object({ quickLog: storedDetails }).safeParse(metadata);
  return envelope.success ? envelope.data.quickLog : null;
}

// Same read policy as ClientObjectivesService.assertClient: Objective ownership
// is attribution, not a narrower ACL. Recheck after lookup as that owner does.
async function requireObjectiveRead(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
) {
  const client = await tx.client.findFirst({
    where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
    select: { id: true },
  });
  if (!client || !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId)))
    throw new NotFoundException('Client not found');
}

/** Historical references never grant access or imply a current Objective version. */
export async function projectActivityDetails(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  rows: readonly { metadata?: unknown }[],
): Promise<ActivityDetails[]> {
  const details = rows.map((row) => readDetails(row.metadata));
  const ids = [
    ...new Set(details.flatMap((item) => (item?.objective ? [item.objective.objectiveId] : []))),
  ];
  if (ids.length) await requireObjectiveRead(tx, ctx, clientId);
  const objectives = ids.length
    ? await tx.clientObjective.findMany({
        where: { tenantId: ctx.tenantId, clientId, deletedAt: null, id: { in: ids } },
        select: { id: true, version: true },
      })
    : [];
  if (ids.length) await requireObjectiveRead(tx, ctx, clientId);
  const versions = new Map(objectives.map((item) => [item.id, item.version]));
  return details.map((item) => ({
    direction: item?.direction ?? null,
    counterparty: item?.counterparty ?? null,
    objective: item?.objective
      ? {
          ...item.objective,
          availability: !versions.has(item.objective.objectiveId)
            ? ('unavailable' as const)
            : versions.get(item.objective.objectiveId) === item.objective.objectiveVersion
              ? ('current' as const)
              : ('changed' as const),
        }
      : null,
  }));
}
