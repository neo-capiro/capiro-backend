import { Type } from 'class-transformer';
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
  ValidateNested,
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

/**
 * Phase 2: the immutable DISPLAY snapshot of one attachment on the user's chat
 * message — filename/kind/status as the uploader saw them. Grounding still comes
 * from `attachmentIds` (resolved server-side); this is what the bubble renders,
 * snapshotted so a later rename or delete cannot rewrite chat history. Ids not
 * present in `attachmentIds` are dropped server-side.
 */
export class ChatAttachmentDto {
  @IsUUID()
  id!: string;

  @IsString()
  @MaxLength(200)
  filename!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  kind?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  status?: string;
}

/** POST /strategies/:id/assistant — panel edit engine (NOD-4 node / MRI-3 strategy). */
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

  /**
   * Phase 2: required. The web mints one UUID per user send so a retried POST —
   * dropped response, double-click — reuses the stored user message instead of
   * posting a second bubble. Required rather than optional precisely so a caller
   * cannot silently opt out of idempotency.
   */
  @IsUUID()
  clientMessageId!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ChatAttachmentDto)
  attachments?: ChatAttachmentDto[];
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
