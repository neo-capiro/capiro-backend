import { IsArray, IsIn, IsString, MaxLength } from 'class-validator';

/**
 * DTOs for the P1.1 aux tracker endpoints (ported from apps/api
 * tracker.dto.ts). The global ValidationPipe is whitelist +
 * forbidNonWhitelisted, so each route body/query needs an explicit class.
 */
export class BillSearchQueryDto {
  @IsString()
  q!: string;
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
