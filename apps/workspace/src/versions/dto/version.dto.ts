import { IsIn, IsOptional, IsString } from 'class-validator';

export class CreateVersionDto {
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsIn(['meri', 'person']) authorKind?: 'meri' | 'person';
}
