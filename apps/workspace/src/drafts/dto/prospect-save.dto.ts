import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

/** A manual prospect save cannot change its origin, template or publication. */
export class SaveProspectDraftDto {
  @IsUUID() requestId!: string;
  @IsUUID() expectedProspectId!: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/) expectedStateHash!: string;
  @IsString() @MaxLength(500) title!: string;
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  names!: string[];
  @IsObject() sections!: Record<string, string>;
}
