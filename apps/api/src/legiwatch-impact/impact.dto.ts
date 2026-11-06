import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class ImpactTrackerQuery {
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsString() @MaxLength(400) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
  @IsOptional() @IsString() @MaxLength(160) q?: string;
}

export class ImpactContextDto {
  @IsOptional() @IsIn(['support', 'oppose', 'monitor']) position?:
    'support' | 'oppose' | 'monitor' | null;
  @IsOptional() @IsIn(['low', 'med', 'high']) priority?: 'low' | 'med' | 'high' | null;
  @IsOptional() @IsString() @MaxLength(8000) analystNote?: string | null;
}
