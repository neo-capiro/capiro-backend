import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { STRATEGY_TYPES, type StrategyTypeValue } from '../../strategy/dto/create-strategy.dto.js';

/** POST /strategies/draft — AI create from goal (+ optional docs). CRT-11/12. */
export class DraftStrategyDto {
  @IsUUID()
  clientId!: string;

  @IsIn(STRATEGY_TYPES)
  type!: StrategyTypeValue;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  goal?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  meriContext?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  ownerUserId?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'targetDate must be YYYY-MM-DD' })
  targetDate?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  attachmentIds?: string[];
}

/** POST /strategies/:id/assistant — rail edit engine (NOD-4 node / MRI-3 strategy). */
export class AssistantDto {
  @IsIn(['node', 'strategy'])
  scope!: 'node' | 'strategy';

  @IsOptional()
  @IsUUID()
  nodeId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  instruction!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  attachmentIds?: string[];
}

/** POST /reference-calendars/:kind/assist — REF-4 Meri row edits (returned, not saved). */
export class ReferenceAssistDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  instruction!: string;

  /** The modal's current working rows (opaque pass-through to the orchestrator). */
  @IsArray()
  @ArrayMaxSize(60)
  rows!: unknown[];
}
