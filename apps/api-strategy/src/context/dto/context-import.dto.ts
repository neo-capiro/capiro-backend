import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class ResolveContextImportDto {
  @IsUUID()
  clientId!: string;

  @IsOptional()
  @IsUUID()
  strategyId?: string;

  @IsUUID()
  attachmentId!: string;
}

export class AnalyzeContextImportDto {
  @IsString()
  @MinLength(1)
  @MaxLength(700000)
  token!: string;
}

export class SaveContextImportDto extends AnalyzeContextImportDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(14)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  selectedDocumentIds!: string[];
}
