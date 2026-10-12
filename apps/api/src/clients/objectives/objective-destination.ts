import { BadRequestException } from '@nestjs/common';
import { IsInt, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { normalizeClientObjectiveDestination } from '@capiro/shared';

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
  try {
    return normalizeClientObjectiveDestination(input);
  } catch {
    throw new BadRequestException('Invalid Objective destination binding');
  }
}
