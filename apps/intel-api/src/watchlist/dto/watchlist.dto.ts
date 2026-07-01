import { IsArray, IsBoolean, IsNumber, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class WatchlistTermDto {
  @IsString() @MaxLength(40) termType!: string;
  @IsString() @MaxLength(200) value!: string;
  @IsOptional() @IsNumber() weight?: number;
}

export class CreateWatchlistDto {
  @IsString() @MaxLength(120) clientId!: string;
  @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => WatchlistTermDto)
  terms?: WatchlistTermDto[];
}

export class AddTermDto {
  @IsString() @MaxLength(40) termType!: string;
  @IsString() @MaxLength(200) value!: string;
  @IsOptional() @IsNumber() weight?: number;
}

export class SetActiveDto {
  @IsBoolean() active!: boolean;
}
