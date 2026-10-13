import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class ProspectBriefCommandDto {
  @IsUUID() requestId!: string;
  @Matches(/^[0-9a-f]{64}$/) expectedStateHash!: string;
  // Missing is invalid; explicit null means an unconverted prospect.
  @ValidateIf((_o, value) => value !== null) @IsUUID() expectedClientId!: string | null;
}

export class CopyProspectBriefDto extends ProspectBriefCommandDto {
  @IsObject() source!: Record<string, unknown>;
}

export class SaveProspectBriefCopyDto extends ProspectBriefCommandDto {
  @IsObject() body!: Record<string, unknown>;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(300) name?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100000) ordinal?: number;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(500) docTitle?: string;
  @IsOptional() @IsString() @MaxLength(300) label?: string;
}
