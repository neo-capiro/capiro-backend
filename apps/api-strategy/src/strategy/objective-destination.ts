import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { IsInt, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import {
  ClientObjectiveDestinationError,
  normalizeClientObjectiveDestination,
  requireClientObjectiveDestinationRevision,
  type ClientObjectiveDestinationInput,
  type ClientObjectiveDestinationTx,
} from '@capiro/shared';
import type { AuthTenantContext } from '../auth/tenant-context.js';

export class ObjectiveDestinationQueryDto implements ClientObjectiveDestinationInput {
  @IsUUID()
  clientId!: string;
  @IsUUID()
  objectiveId!: string;
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  objectiveVersion!: number;
}

function rethrowDestinationError(error: unknown): never {
  if (error instanceof ClientObjectiveDestinationError) {
    if (error.code === 'OBJECTIVE_DESTINATION_INVALID')
      throw new BadRequestException('Invalid Objective destination binding');
    if (error.code === 'OBJECTIVE_VERSION_CONFLICT')
      throw new ConflictException({
        code: error.code,
        message: 'Objective changed. Reload it before opening this destination.',
      });
    throw new NotFoundException('Objective destination not found');
  }
  throw error;
}

export function normalizeObjectiveDestination(input: ClientObjectiveDestinationInput) {
  try {
    return normalizeClientObjectiveDestination(input);
  } catch (error) {
    return rethrowDestinationError(error);
  }
}

export async function requireObjectiveDestinationRevision(
  tx: ClientObjectiveDestinationTx,
  ctx: AuthTenantContext,
  input: ClientObjectiveDestinationInput,
) {
  try {
    return await requireClientObjectiveDestinationRevision(tx, ctx, input);
  } catch (error) {
    return rethrowDestinationError(error);
  }
}
