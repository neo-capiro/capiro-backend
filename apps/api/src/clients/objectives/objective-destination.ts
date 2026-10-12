import { BadRequestException } from '@nestjs/common';
import { IsInt, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** An observation of canonical state, never a bearer capability or stored link. */
export interface ObjectiveRevisionBinding {
  clientId: string;
  objectiveId: string;
  objectiveVersion: number;
  objectiveRevisionId: string;
}

export class ObjectiveDestinationQueryDto {
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

export function normalizeObjectiveDestination(input: ObjectiveDestinationQueryDto) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    !input ||
    !uuid.test(input.clientId) ||
    !uuid.test(input.objectiveId) ||
    !Number.isInteger(input.objectiveVersion) ||
    input.objectiveVersion < 1 ||
    input.objectiveVersion > 2147483647
  ) {
    throw new BadRequestException('Invalid Objective destination binding');
  }
  return {
    clientId: input.clientId.toLowerCase(),
    objectiveId: input.objectiveId.toLowerCase(),
    objectiveVersion: input.objectiveVersion,
  };
}
