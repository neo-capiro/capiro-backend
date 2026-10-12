import { IsInt, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** The owner path supplies the draft/version and literal kind, never the query. */
export class WorkspaceObjectiveDestinationQueryDto {
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
