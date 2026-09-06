import { IsIn, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { STRATEGY_TYPES, type StrategyTypeValue } from './create-strategy.dto.js';

/**
 * Strategy meta edit (title/type/owner/targetDate/goal/meriContext) — the
 * documented PATCH /strategies/:id surface. Every field optional; present-null
 * clears a nullable column. `changeNote` labels the version/audit entry.
 */
export class PatchStrategyDto {
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @Matches(/\S/, { message: 'title must not be blank' })
  @MaxLength(200)
  title?: string;

  @ValidateIf((_o, value) => value !== undefined)
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

  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @MaxLength(120)
  @Matches(/\S/, { message: 'ownerUserId must not be blank' })
  ownerUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  changeNote?: string;
}
