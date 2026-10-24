import { IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class CreateSupportRequestDto {
  @IsUUID()
  id!: string;

  @IsString()
  @Length(1, 200)
  summary!: string;

  @IsString()
  @Length(1, 5000)
  detail!: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  runReference?: string | null;
}

export class ListSupportRequestsDto {
  @IsUUID()
  tenantId!: string;

  @IsOptional()
  @IsUUID()
  cursor?: string;
}
