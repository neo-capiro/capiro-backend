import { IsArray, IsDateString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { EXPECTED_CONFIDENCE_LEVELS, EXPECTED_MILESTONE_TYPES } from '@capiro/shared';

/**
 * DTOs for the P1.1 aux tracker endpoints (ported from apps/api
 * tracker.dto.ts). The global ValidationPipe is whitelist +
 * forbidNonWhitelisted, so each route body/query needs an explicit class.
 */
export class BillSearchQueryDto {
  @IsString()
  q!: string;
}

/**
 * Body for PUT /clients/:c/bills/:b/context (Bill 360, Release R1, §1.3). Every
 * field is OPTIONAL so a partial PUT never nulls unspecified context; `note` is
 * intentionally NOT here (the write must never touch the legacy note). All fields
 * are analyst-owned context and never affect the canonical bill status.
 */
export class UpdateBillContextDto {
  @IsOptional()
  @IsIn(['support', 'oppose', 'monitor'])
  position?: string;

  @IsOptional()
  @IsIn(['low', 'med', 'high'])
  priority?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  analystNote?: string;

  @IsOptional()
  @IsIn([...EXPECTED_MILESTONE_TYPES])
  expectedMilestoneType?: string;

  @IsOptional()
  @IsDateString()
  expectedWindowStart?: string;

  @IsOptional()
  @IsDateString()
  expectedWindowEnd?: string;

  @IsOptional()
  @IsIn([...EXPECTED_CONFIDENCE_LEVELS])
  expectedConfidence?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  expectedRationale?: string;
}

export class SmsStartDto {
  @IsString()
  @MaxLength(20)
  phone!: string;
}

export class SmsConfirmDto {
  @IsString()
  @MaxLength(20)
  phone!: string;

  @IsString()
  @MaxLength(6)
  code!: string;
}

export class TestAlertDto {
  @IsArray()
  @IsIn(['email', 'sms', 'in_app'], { each: true })
  channels!: ('email' | 'sms' | 'in_app')[];
}
