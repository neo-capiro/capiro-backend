import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class FolderActivityQueryDto {
  @IsString() @Matches(/^[A-Z]{2}$/) jurisdiction!: string;
  @IsString() @Matches(/^\d{3,4}(x\d+)?$/) sessionKey!: string;
  @IsOptional() @IsUUID() folderId?: string;
  @IsOptional() @IsUUID() clientId?: string;
  @IsIn(['action', 'text', 'amendment']) kind!: 'action' | 'text' | 'amendment';
  @IsOptional() @IsIn(['true']) onlyTracked?: string;
  @IsOptional() @IsIn(['upper', 'lower']) chamber?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  @IsOptional() @IsString() @MaxLength(600) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}
export const IMPORTANCE = ['normal', 'low', 'medium', 'high'] as const;
export const POSITION = ['none', 'support', 'oppose', 'monitor', 'neutral'] as const;
export class FolderFieldsDto {
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsOptional() @IsString() @MaxLength(40) code?: string;
  @IsOptional() @IsUUID() clientId?: string | null;
  @IsOptional() @IsString() @MaxLength(100) ownerClerkId?: string;
  @IsOptional() @IsIn(['read_only', 'read_change']) otherUserAccess?: string;
  @IsOptional() @IsString() @Matches(/^(current|\d{3,4}(x\d+)?)$/) defaultSession?: string;
  @IsOptional() @IsString() @Matches(/^[A-Z]{2}$/) jurisdiction?: string;
  @IsOptional() @IsBoolean() archived?: boolean;
}
export class UpdateFolderDto extends FolderFieldsDto {
  @IsInt() @Min(0) expectedVersion!: number;
}
/**
 * Global corpus search query. Deliberately separate from FolderBoardQueryDto:
 * it has NO folderId/clientId/comments/priority/importance/position fields, so
 * the public route can never express a tenant-private filter.
 */
export class BillCorpusQueryDto {
  /** Omit to search every ingested jurisdiction (all states + US). */
  @IsOptional() @IsString() @Matches(/^[A-Z]{2}$/) jurisdiction?: string;
  /** Omit to search every ingested session (regular + special + all Congresses). */
  @IsOptional() @IsString() @Matches(/^\d{3,4}(x\d+)?$/) sessionKey?: string;
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  @IsOptional() @IsString() @MaxLength(100) sponsor?: string;
  @IsOptional() @IsString() @MaxLength(100) status?: string;
  @IsOptional() @IsIn(['upper', 'lower']) chamber?: string;
  @IsOptional() @IsIn(['bill', 'title', 'sponsor', 'lastAction']) sort?: string;
  @IsOptional() @IsIn(['asc', 'desc']) direction?: string;
  @IsOptional() @IsString() @MaxLength(300) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  /** Additive parity: provider bill-type code (e.g. 'bill'|'resolution'). */
  @IsOptional() @IsString() @MaxLength(40) classification?: string;
  /** Provider category/subject tag (ILIKE ANY). */
  @IsOptional() @IsString() @MaxLength(100) subject?: string;
  /** Current committee referral exact label. */
  @IsOptional() @IsString() @MaxLength(160) committee?: string;
  /** Explicit summary-text predicate (state_bill.description ILIKE). */
  @IsOptional() @IsString() @MaxLength(200) summary?: string;
  /** Explicit latest-action-text predicate. */
  @IsOptional() @IsString() @MaxLength(200) actionText?: string;
  /** Display flag: project summary/committee/classification into rows. */
  @IsOptional() @IsIn(['true']) summaryIncluded?: string;
}
export class FolderBoardQueryDto {
  @IsOptional() @IsUUID() folderId?: string;
  @IsOptional() @IsUUID() clientId?: string;
  /** Optional on the global-search path; the board path enforces presence in the service. */
  @IsOptional() @IsString() @Matches(/^[A-Z]{2}$/) jurisdiction?: string;
  /** Optional on the global-search path; the board path enforces presence in the service. */
  @IsOptional() @IsString() @Matches(/^\d{3,4}(x\d+)?$/) sessionKey?: string;
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  @IsOptional() @IsString() @MaxLength(100) sponsor?: string;
  @IsOptional() @IsString() @MaxLength(100) status?: string;
  @IsOptional() @IsIn(['upper', 'lower']) chamber?: string;
  @IsOptional() @IsIn(['internal', 'external', 'any', 'none']) comments?: string;
  @IsOptional() @IsIn(['true', 'false']) topPriority?: string;
  @IsOptional() @IsIn(IMPORTANCE) importance?: string;
  @IsOptional() @IsIn(POSITION) position?: string;
  @IsOptional() @IsIn(['bill', 'title', 'sponsor', 'lastAction', 'added']) sort?: string;
  @IsOptional() @IsIn(['asc', 'desc']) direction?: string;
  @IsOptional() @IsString() @MaxLength(300) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  /** Additive parity: provider bill-type code (e.g. 'bill'|'resolution'). */
  @IsOptional() @IsString() @MaxLength(40) classification?: string;
  /** Provider category/subject tag (ILIKE ANY). */
  @IsOptional() @IsString() @MaxLength(100) subject?: string;
  /** Current committee referral exact label. */
  @IsOptional() @IsString() @MaxLength(160) committee?: string;
  /** Explicit summary-text predicate (state_bill.description ILIKE). */
  @IsOptional() @IsString() @MaxLength(200) summary?: string;
  /** Explicit latest-action-text predicate. */
  @IsOptional() @IsString() @MaxLength(200) actionText?: string;
  /** Display flag: project summary/committee/classification into rows. */
  @IsOptional()
  @IsIn(['true'])
  summaryIncluded?: string;
}
export class FolderContextDto {
  @IsInt() @Min(0) expectedVersion!: number;
  @IsBoolean() topPriority!: boolean;
  @IsIn(IMPORTANCE) importance!: string;
  @IsIn(POSITION) position!: string;
  @IsString() @MaxLength(10000) internalComments!: string;
  @IsString() @MaxLength(10000) externalComments!: string;
}
export class ResolveBillsDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID(undefined, { each: true })
  folderIds?: string[];
  @IsString() @Matches(/^[A-Z]{2}$/) jurisdiction!: string;
  @IsString() @Matches(/^\d{3,4}(x\d+)?$/) sessionKey!: string;
  @IsString() @MinLength(1) @MaxLength(4000) billNumbers!: string;
}
export class BulkFolderBillsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  billIds!: string[];
  @IsIn(['add', 'remove']) action!: 'add' | 'remove';
}
export class FolderExportDto extends FolderBoardQueryDto {
  @IsIn(['selected', 'filtered']) scope!: 'selected' | 'filtered';
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) selectedIds?: string[];
  @IsBoolean() includeInternalComments!: boolean;
  @IsBoolean() includeExternalComments!: boolean;
}
