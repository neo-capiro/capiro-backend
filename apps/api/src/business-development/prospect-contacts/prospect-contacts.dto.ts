import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const optionalText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;
export class ProspectContactParams {
  @IsUUID() prospectId!: string;
}
export class ProspectContactIdParams extends ProspectContactParams {
  @IsUUID() contactId!: string;
}
export class ProspectContactQuery {
  @IsOptional() @IsUUID() after?: string;
}
export class ProspectContactFields {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) name!: string;
  @Transform(optionalText) @IsOptional() @IsString() @MaxLength(300) title?: string | null;
  @Transform(optionalText) @IsOptional() @IsEmail() @MaxLength(320) email?: string | null;
  @Transform(optionalText) @IsOptional() @IsString() @MaxLength(120) phone?: string | null;
  @Transform(optionalText) @IsOptional() @IsString() @MaxLength(4000) notes?: string | null;
}
export class CreateProspectContactDto extends ProspectContactFields {
  @IsUUID() requestId!: string;
}
export class UpdateProspectContactDto extends ProspectContactFields {
  @IsInt() @Min(1) expectedVersion!: number;
}
export class RemoveProspectContactDto {
  @IsInt() @Min(1) expectedVersion!: number;
}
