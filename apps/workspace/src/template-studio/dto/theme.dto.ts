import {
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
  IsObject,
  Matches,
  ValidateIf,
} from 'class-validator';

/** Optional precondition captured from the saved theme version displayed to the editor. */
export class ThemeVersionExpectationDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^[a-f\d]{64}$/)
  expectedSettingsHash?: string;
}

/** Create a new document theme. */
export class CreateThemeDto {
  @IsString() @MinLength(1) @MaxLength(120) slug!: string;
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

/** Save (update) a draft theme version's settings. */
export class SaveThemeDraftDto extends ThemeVersionExpectationDto {
  @IsObject() settings!: Record<string, unknown>;
}

/** Create a new draft version of an existing theme. */
export class CreateThemeVersionDto {
  @IsOptional() @IsObject() settings?: Record<string, unknown>;
}
