import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { STRATEGY_TYPES, type StrategyTypeValue } from './create-strategy.dto.js';

/**
 * Strategy meta edit (title/type/owner/targetDate/goal/meriContext) — the
 * documented PATCH /strategies/:id surface. Every field optional; present-null
 * clears a nullable column. `changeNote` labels the version/audit entry.
 */
export class PatchStrategyDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsIn(STRATEGY_TYPES)
  type?: StrategyTypeValue;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  goal?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  meriContext?: string | null;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'targetDate must be YYYY-MM-DD' })
  targetDate?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  ownerUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  changeNote?: string;
}
