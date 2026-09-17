import { IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import type { VendorReferenceInput } from './vendor-reference.types.js';

/**
 * Query DTO for GET /vendor-reference/pull and /vendor-reference/markdown.
 * The global ValidationPipe runs with whitelist + forbidNonWhitelisted, so
 * every accepted key must be declared here.
 */
export class VendorReferencePullDto implements VendorReferenceInput {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  /** SAM Unique Entity ID — 12 alphanumerics. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{12}$/, { message: 'uei must be 12 alphanumeric characters' })
  uei?: string;

  /** CAGE code — 5 alphanumerics. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{5}$/, { message: 'cage must be 5 alphanumeric characters' })
  cage?: string;

  /** 2-letter state code of the facility relevant to the request. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/, { message: 'state must be a 2-letter code' })
  state?: string;

  /** Congressional district in facility style ('02', '11', '00'/'AL' for at-large). */
  @IsOptional()
  @IsString()
  @Matches(/^(?:[0-9]{1,2}|AL)$/i, { message: 'district must be 1-2 digits or AL' })
  district?: string;

  /** One-line street address of the facility, geocoded (Census) when state/district are absent. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  facilityAddress?: string;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsUUID()
  strategyId?: string;
}
