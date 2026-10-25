import { ArrayMaxSize, IsArray, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateIf, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { UpdateDraftDto } from './draft.dto.js';

export class SaveDraftDocumentDto {
  @IsUUID() id!: string;
  @IsOptional() @IsString() @MaxLength(400) name?: string;
  @IsOptional() @IsObject() body?: Record<string, unknown>;
}

/** Explicit request identity is retained by the caller through unknown results. */
export class SaveDraftDto {
  @IsUUID() requestId!: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/) expectedStateHash!: string;
  @ValidateIf((value: SaveDraftDto) => value.expectedClientId !== null) @IsUUID()
  expectedClientId!: string | null;
  @IsOptional() @IsString() @MaxLength(200) label?: string;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => UpdateDraftDto)
  draft?: UpdateDraftDto;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => SaveDraftDocumentDto)
  documents?: SaveDraftDocumentDto[];
}
