import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** The 6 objective types (plan §4 SpStrategyType / prototype OBJECTIVE_TYPES). */
export const STRATEGY_TYPES = [
  'appropriations',
  'authorization',
  'regulatory',
  'coalition',
  'procurement',
  'earmark',
] as const;
export type StrategyTypeValue = (typeof STRATEGY_TYPES)[number];

/**
 * Manual create (G2). The AI draft-from-goal path (G5) will add attachmentIds +
 * server-side node generation; here we create an empty strategy. `title` is
 * optional — the manual modal collects a goal, not a title, so the service
 * derives a title from the goal when absent.
 */
export class CreateStrategyDto {
  @IsUUID()
  clientId!: string;

  @IsIn(STRATEGY_TYPES)
  type!: StrategyTypeValue;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  goal?: string;

  /** Clerk user id of the owner; defaults to the creator when omitted. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  ownerUserId?: string;

  /** ISO date (YYYY-MM-DD). */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  targetDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  meriContext?: string;
}
