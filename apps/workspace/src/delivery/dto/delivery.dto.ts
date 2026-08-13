import { IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreateApprovalRequestDto {
  @IsOptional() @IsString() versionId?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() idempotencyKey?: string;
}

export class ApprovalDecisionDto {
  @IsString() decision!: 'approved' | 'rejected';
  @IsOptional() @IsString() note?: string;
}

export class CreateShareLinkDto {
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsInt() @Min(1) expiresInDays?: number;
  @IsOptional() @IsString() versionId?: string;
  @IsOptional() @IsString() idempotencyKey?: string;
}

export class GuestCommentDto {
  @IsString() @MinLength(1) text!: string;
  @IsOptional() @IsString() name?: string;
}
