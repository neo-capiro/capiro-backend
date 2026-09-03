import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateHillDayDocumentDto {
  @IsString() @Length(1, 128) blueprintId!: string;
  @IsUUID() clientId!: string;
  @IsString() @Length(1, 200) name!: string;
  @IsOptional() @IsInt() @Min(7) @Max(365) lookbackDays?: number;
  @IsOptional() @IsString() @Length(1, 64) timeZone?: string;
}

export class SetMeetingsDto {
  @IsArray() @ArrayMaxSize(80) @IsString({ each: true }) eventIds!: string[];
  /** ISO date (YYYY-MM-DD) of the Monday the picker showed. */
  @IsOptional() @IsString() @Length(10, 10) weekStart?: string;
  @IsOptional() @IsString() @Length(1, 64) timeZone?: string;
}

export const CORRECTION_KINDS = [
  'assign_staffer',
  'manual_attendee',
  'accept_stale',
  'create_directory_record',
  'change_office',
  'edit_meeting_facts',
] as const;

export class ResolutionCorrectionDto {
  @IsIn(CORRECTION_KINDS) kind!: (typeof CORRECTION_KINDS)[number];
  @IsOptional() @IsString() @Length(1, 64) attendeeId?: string;
  @IsOptional() @IsString() @Length(1, 64) stafferId?: string;
  @IsOptional() @IsString() @Length(1, 200) name?: string;
  @IsOptional() @IsString() @MaxLength(200) role?: string;
  @IsOptional() @IsString() @Length(3, 320) address?: string;
  @IsOptional() @IsString() @Length(1, 64) memberId?: string;
  @IsOptional() @IsIn(['directory', 'invite']) useOffice?: 'directory' | 'invite';
  // edit_meeting_facts — every field optional so a form can submit only what changed.
  @IsOptional() @IsString() @Length(1, 240) subject?: string;
  @IsOptional() @IsISO8601() startsAt?: string;
  @IsOptional() @IsISO8601() endsAt?: string;
  @IsOptional() @IsString() @Length(1, 240) location?: string;
}

export class AddManualMeetingDto {
  @IsString() @Length(1, 64) memberId!: string;
}

export class CarrySelectionDto {
  @IsBoolean() committees!: boolean;
  @IsBoolean() bio!: boolean;
  @IsArray() @ArrayMaxSize(64) @IsString({ each: true }) issueAreas!: string[];
  @IsArray() @ArrayMaxSize(64) @IsString({ each: true }) staffers!: string[];
}

export class PutMeetingContextDto {
  @IsString() @MaxLength(4000) note!: string;
  @ValidateNested() @Type(() => CarrySelectionDto) carry!: CarrySelectionDto;
  @IsArray() @ArrayMaxSize(64) @IsString({ each: true }) threadIds!: string[];
  @IsOptional() @IsInt() @Min(7) @Max(365) lookbackDays?: number;
}

export class SectionEditDto {
  @IsString() @Length(1, 64) sectionId!: string;
  @IsOptional() @IsString() @MaxLength(20000) focus?: string;
  @IsOptional() @IsString() @MaxLength(20000) background?: string;
}

export class RefineSectionTextDto {
  @IsIn(['focus', 'background']) field!: 'focus' | 'background';
  @IsString() @Length(1, 20000) text!: string;
}

export class PatchHillDayDocumentDto {
  @IsOptional() @IsString() @Length(1, 200) name?: string;
  @IsOptional() @ValidateNested() @Type(() => SectionEditDto) section?: SectionEditDto;
  @IsOptional() @IsIn(['draft', 'delivered']) status?: 'draft' | 'delivered';
  @IsOptional() @IsInt() @Min(7) @Max(365) lookbackDays?: number;
}

export class CreateExportDto {
  @IsOptional() @IsIn(['letter', 'a4']) pageSize?: 'letter' | 'a4';
}
