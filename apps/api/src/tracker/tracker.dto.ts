import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { WatchlistTag } from './tracker.types.js';

export class WatchlistDto {
  @IsArray()
  @IsString({ each: true })
  issueAreas!: string[];

  // Array of watchlist-tag objects; validated/normalized server-side in
  // TrackerService.normalizeTag (kept opaque here so nested fields survive the
  // global whitelist pipe).
  @IsArray()
  tags!: WatchlistTag[];
}

export class AlertPrefsDto {
  @IsArray()
  @IsString({ each: true })
  triggers!: string[];

  @IsIn(['low', 'medium', 'high'])
  materiality!: 'low' | 'medium' | 'high';

  @IsBoolean()
  emailEnabled!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  emailAddress?: string | null;

  @IsIn(['realtime', 'daily', 'weekly'])
  emailCadence!: 'realtime' | 'daily' | 'weekly';

  @IsBoolean()
  smsEnabled!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  smsPhone?: string | null;

  @IsBoolean()
  smsPhoneVerified!: boolean;

  @IsIn(['realtime', 'daily'])
  smsCadence!: 'realtime' | 'daily';

  @IsOptional()
  @IsString()
  @MaxLength(5)
  quietHoursStart?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(5)
  quietHoursEnd?: string | null;
}

export class FeedbackDto {
  @IsString()
  billId!: string;

  @IsIn(['tracked', 'dismissed', 'marked_irrelevant', 'opened'])
  signal!: 'tracked' | 'dismissed' | 'marked_irrelevant' | 'opened';
}

export class TrackDto {
  @IsString()
  billId!: string;

  @IsOptional()
  @IsIn(['recommended', 'manual_search', 'imported'])
  source?: 'recommended' | 'manual_search' | 'imported';
}

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
