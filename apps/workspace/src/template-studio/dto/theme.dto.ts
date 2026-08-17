import {
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
  IsObject,
} from 'class-validator';

/** Create a new document theme. */
export class CreateThemeDto {
  @IsString() @MinLength(1) @MaxLength(120) slug!: string;
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

/** Save (update) a draft theme version's settings. */
export class SaveThemeDraftDto {
  @IsObject() settings!: Record<string, unknown>;
}

/** Create a new draft version of an existing theme. */
export class CreateThemeVersionDto {
  @IsOptional() @IsObject() settings?: Record<string, unknown>;
}
