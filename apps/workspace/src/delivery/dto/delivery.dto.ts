import { IsInt, IsOptional, IsString, Min, MaxLength, MinLength } from 'class-validator';

export class CreateShareLinkDto {
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsInt() @Min(1) expiresInDays?: number;
  @IsOptional() @IsString() versionId?: string;
  @IsOptional() @IsString() idempotencyKey?: string;
}

export class GuestCommentDto {
  @IsString() @MinLength(1) @MaxLength(2000) text!: string;
  @IsOptional() @IsString() @MaxLength(200) name?: string;
}
