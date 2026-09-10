import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export const IMPORT_KINDS = [
  'folder',
  'assignment',
  'report',
  'alert',
  'bill_keyword',
  'news_keyword',
  'user',
  'contact',
  'mailing_list',
  'list_membership',
  'statute',
  'committee_legislator',
  'alert_target',
  'alert_channel',
  'report_observation',
] as const;
export class FolderImportItemDto {
  @IsIn(IMPORT_KINDS) kind!: (typeof IMPORT_KINDS)[number];
  @IsString() @MaxLength(200) sourceId!: string;
  @IsObject() payload!: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(500) excludedReason?: string;
}
export class PreviewFolderImportDto {
  @IsUUID() targetTenantId!: string;
  @IsString() @Matches(/^[a-zA-Z0-9:_-]{3,120}$/) sourceAccount!: string;
  @IsString() @MaxLength(120) captureId!: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/) sourceHash!: string;
  @IsObject() mappingManifest!: Record<string, unknown>;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => FolderImportItemDto)
  items!: FolderImportItemDto[];
}
export class ApplyFolderImportDto {
  @IsUUID() targetTenantId!: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/) mappingHash!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  itemIds!: string[];
}
