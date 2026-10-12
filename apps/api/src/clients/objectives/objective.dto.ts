import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  OBJECTIVE_ASK_TYPES,
  type ObjectiveAskType,
  type ObjectiveTransition,
} from './objective-rules.js';

export class ObjectiveDraftDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(2000)
  outcome?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(4000)
  governmentProblem?: string;

  @IsOptional()
  @IsIn(OBJECTIVE_ASK_TYPES)
  askType?: ObjectiveAskType | null;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(2000)
  minimumWin?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(4000)
  limits?: string;

  @IsOptional()
  @IsUUID()
  ownerUserId?: string | null;
}

export class UpdateObjectiveDto extends ObjectiveDraftDto {
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class CreateObjectiveDto extends ObjectiveDraftDto {
  @IsUUID()
  requestId!: string;
}

export class ObjectiveVersionDto {
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class ObjectiveTransitionDto extends ObjectiveVersionDto {
  @IsIn(['request_review', 'confirm_ready'])
  action!: ObjectiveTransition;
}
