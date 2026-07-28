import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { TenantContext } from '@capiro/shared';
import { GRANTS_GOV_APPLICANT_TYPES } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { ClientsService } from './clients.service.js';

class CreateClientDto {
  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsUrl({ require_protocol: false })
  website?: string;

  @IsOptional()
  @IsString()
  @MinLength(0)
  description?: string;

  @IsOptional()
  @IsString()
  productDescription?: string;

  @IsOptional()
  @IsString()
  primaryContactName?: string;

  @IsOptional()
  @IsEmail()
  primaryContactEmail?: string;

  @IsOptional()
  @IsString()
  primaryContactPhone?: string;

  @IsOptional()
  @IsObject()
  intakeData?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  profileType?: string;

  @IsOptional()
  @IsString()
  sectorTag?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  submissionTracks?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  issueCodes?: string[];

  @IsOptional()
  @IsString()
  profileStatus?: string;

  // Step 2.3 — government identifiers for procurement matching. All OPTIONAL;
  // only `name` is required to create a client. The Add Client form posts these,
  // so they must be whitelisted here or the global ValidationPipe
  // (forbidNonWhitelisted) rejects the whole request with 400.
  @IsOptional()
  @IsString()
  @Length(0, 12)
  uei?: string;

  @IsOptional()
  @IsString()
  @Length(0, 5)
  cageCode?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  naicsCodes?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pscCodes?: string[];
}

class BulkImportClientsDto {
  // 500 cap is a sanity bound, most CSV imports we expect are <50 rows.
  // class-validator's array limits guard against accidental gigabyte
  // pastes that would otherwise OOM the per-tenant transaction.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CreateClientDto)
  rows!: CreateClientDto[];
}

class UpdateClientDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsUrl({ require_protocol: false })
  website?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  productDescription?: string;

  @IsOptional()
  @IsString()
  primaryContactName?: string;

  @IsOptional()
  @IsEmail()
  primaryContactEmail?: string;

  @IsOptional()
  @IsString()
  primaryContactPhone?: string;

  @IsOptional()
  @IsObject()
  intakeData?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  profileType?: string;

  @IsOptional()
  @IsString()
  sectorTag?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  submissionTracks?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  issueCodes?: string[];

  @IsOptional()
  @IsString()
  profileStatus?: string;

  // Step 2.3 — government identifiers used for procurement/client<->PE matching.
  // All optional, light validation: lengths mirror the schema column caps.
  @IsOptional()
  @IsString()
  @Length(0, 12)
  uei?: string;

  @IsOptional()
  @IsString()
  @Length(0, 5)
  cageCode?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  naicsCodes?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pscCodes?: string[];

  /**
   * Grants.gov "Eligible Applicants" values. Drives District Nexus F3
   * eligibility, which can only return `eligible` once this is set — an empty
   * array honestly reads as `needs_review`, so leaving it unset degrades rather
   * than misleads.
   *
   * Constrained to the exact label strings `federal_grant.eligibility` carries,
   * because F3 compares the two by string. A free-text field here would let a
   * plausible-looking value ("Small Business", "23") be saved that can never
   * match anything — a client that looks configured and still never evaluates as
   * eligible, which is worse than an empty column.
   */
  @IsOptional()
  @IsArray()
  @IsIn(GRANTS_GOV_APPLICANT_TYPES as unknown as string[], { each: true })
  applicantTypes?: string[];
}

class ListClientsQueryDto {
  @IsOptional()
  @IsString()
  profileStatus?: string;

  @IsOptional()
  @IsString()
  sectorTag?: string;

  // Query params arrive as strings; compared against 'true' in the handler.
  @IsOptional()
  @IsString()
  includeArchived?: string;
}

class ClientLogoUploadUrlDto {
  @IsString()
  @IsIn(['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'])
  contentType!: string;

  @IsInt()
  @Min(1)
  @Max(2 * 1024 * 1024)
  contentLength!: number;
}

class ConfirmClientLogoUploadDto {
  @IsString()
  s3Key!: string;

  @IsString()
  @IsIn(['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'])
  contentType!: string;
}

class AppendClientNoteDto {
  @IsString()
  @Length(1, 4000)
  body!: string;
}

class UpdateProfileNotesDto {
  // Empty string is valid — it clears the notes.
  @IsString()
  @Length(0, 20000)
  notes!: string;
}

class UpdateMemoryAccessDto {
  @IsBoolean()
  memoryWall!: boolean;

  // The COMPLETE grant roster (replace-set semantics): users allowed to recall
  // this client's memory while the wall is up. Empty array + memoryWall=true =
  // nobody can (a deliberate lockout is expressible; the audit log shows who).
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  userIds!: string[];
}

/**
 * Clients API, the lobbying firm's customer records.
 *
 * Read access: any tenant member (standard_user and above).
 * Create: any standard_user and above.
 * Update: user_admin or capiro_admin only.
 * Archive/remove: any standard_user and above.
 */
@Controller('clients')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientsController {
  constructor(private readonly service: ClientsService) {}

  @Get()
  list(@CurrentTenant() ctx: TenantContext, @Query() query: ListClientsQueryDto) {
    return this.service.list(ctx, {
      profileStatus: query.profileStatus,
      sectorTag: query.sectorTag,
      includeArchived: query.includeArchived === 'true',
    });
  }

  @Get(':id')
  get(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.get(ctx, id);
  }

  @Post()
  create(@CurrentTenant() ctx: TenantContext, @Body() body: CreateClientDto) {
    return this.service.create(ctx, body);
  }

  // Bulk CSV import. The frontend parses the CSV client-side and POSTs the
  // already-typed row array, keeping multipart out of this controller.
  // Per-row errors are returned in the response (NOT thrown) so a single
  // bad row doesn't abort the whole import; the UI surfaces them inline.
  @Post('bulk-import')
  bulkImport(@CurrentTenant() ctx: TenantContext, @Body() body: BulkImportClientsDto) {
    return this.service.bulkImport(ctx, body.rows);
  }

  @Put(':id')
  @Roles('user_admin')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: UpdateClientDto,
  ) {
    return this.service.update(ctx, id, body);
  }

  @Delete(':id')
  @Roles('standard_user')
  archive(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.archive(ctx, id);
  }

  // Targeted save for the profile Notes editor. Unlike PUT :id (which replaces
  // the whole intakeData object), this merges ONLY intakeData.profileNotes so a
  // stale editor can't clobber sibling intakeData keys written concurrently.
  @Put(':id/profile-notes')
  @Roles('user_admin')
  updateProfileNotes(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: UpdateProfileNotesDto,
  ) {
    return this.service.updateProfileNotes(ctx, id, body.notes);
  }

  // Ethical wall (master plan Phase 1): wall state + grant roster for one
  // client. GET reads it; PUT atomically sets the flag AND replaces the grant
  // set (one lever, so a wall can never be erected with a half-written
  // roster). user_admin only; every change is audit-logged. Admins are NOT
  // exempt from the wall itself — an admin who needs the memory must appear
  // in userIds, and that self-grant is visible in the audit trail.
  @Get(':id/memory-access')
  @Roles('user_admin')
  getMemoryAccess(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.getMemoryAccess(ctx, id);
  }

  @Put(':id/memory-access')
  @Roles('user_admin')
  setMemoryAccess(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: UpdateMemoryAccessDto,
  ) {
    return this.service.setMemoryAccess(ctx, id, body);
  }

  // Quick Log: append a timestamped personal note to the client's profile
  // notes (intakeData.profileNotes), shown in the profile Documents → Notes.
  @Post(':id/notes')
  appendNote(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: AppendClientNoteDto,
  ) {
    return this.service.appendClientNote(ctx, id, body.body);
  }

  @Post(':id/logo/upload-url')
  createLogoUploadUrl(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: ClientLogoUploadUrlDto,
  ) {
    return this.service.createLogoUploadUrl(ctx, id, body.contentType, body.contentLength);
  }

  @Post(':id/logo/confirm')
  confirmLogoUpload(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: ConfirmClientLogoUploadDto,
  ) {
    return this.service.confirmLogoUpload(ctx, id, body.s3Key, body.contentType);
  }
}
