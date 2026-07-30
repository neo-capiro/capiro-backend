import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { AcquisitionPersonnelWriterService } from './acquisition-personnel-writer.service.js';
import { AcquisitionPersonnelReadService } from './acquisition-personnel-read.service.js';
import { ListPersonnelDto } from './dto/list-personnel.dto.js';

// NOTE: the global ValidationPipe runs whitelist + forbidNonWhitelisted, so every
// DTO field MUST carry a class-validator decorator — otherwise it's treated as a
// non-whitelisted property and the whole request is rejected with 400
// ("property X should not exist"). page/limit arrive as query strings, so @Type
// coerces them to numbers (transformOptions has enableImplicitConversion: false).
class LinkCrmContactDto {
  @IsString()
  @IsNotEmpty()
  engagementContactId!: string;

  /** Exact PE code for the page that initiated the link (required for contact-use gate). */
  @IsString()
  @IsNotEmpty()
  peCode!: string;
}

class MergeQueueQueryDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

class ResolveMergeQueueDto {
  @IsIn(['merge', 'keep_separate', 'reject_a', 'reject_b'])
  decision!: 'merge' | 'keep_separate' | 'reject_a' | 'reject_b';

  @IsOptional()
  @IsString()
  notes?: string;
}

class PersonCandidateQueryDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

class ResolvePersonCandidateDto {
  @IsIn(['confirm', 'reject'])
  decision!: 'confirm' | 'reject';

  @IsOptional()
  @IsString()
  notes?: string;
}

class SuggestPersonDto {
  @IsString()
  @IsNotEmpty()
  fullName!: string;

  @IsOptional()
  @IsString()
  roleTitle?: string;

  @IsOptional()
  @IsString()
  organization?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

@Controller()
@UseGuards(RolesGuard)
@Roles('standard_user')
export class AcquisitionPersonnelController {
  constructor(
    private readonly readService: AcquisitionPersonnelReadService,
    private readonly writerService: AcquisitionPersonnelWriterService,
  ) {}

  @Get('acquisition-personnel')
  list(@CurrentTenant() ctx: TenantContext, @Query() query: ListPersonnelDto) {
    return this.readService.listPersonnel(query, ctx);
  }

  @Get('acquisition-personnel/:id')
  detail(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.readService.getPersonDetail(id, ctx);
  }

  @Get('program-elements/:peCode/personnel')
  listForProgramElement(@CurrentTenant() ctx: TenantContext, @Param('peCode') peCode: string) {
    return this.readService.getProgramElementPersonnel(peCode.toUpperCase(), ctx);
  }

  @Post('acquisition-personnel/:id/link-crm-contact')
  linkCrmContact(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: LinkCrmContactDto,
  ) {
    return this.readService.linkCrmContact(id, body.engagementContactId, body.peCode, ctx);
  }

  @Get('admin/acquisition-personnel/merge-queue')
  @Roles('capiro_admin')
  mergeQueue(@CurrentTenant() ctx: TenantContext, @Query() query: MergeQueueQueryDto) {
    return this.readService.listMergeQueue(query.status ?? 'open', query.page, query.limit, ctx);
  }

  @Post('admin/acquisition-personnel/merge-queue/:id/resolve')
  @Roles('capiro_admin')
  resolveMergeQueue(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: ResolveMergeQueueDto,
  ) {
    return this.readService.resolveMergeQueue(
      id,
      body.decision,
      body.notes,
      ctx,
      async (primaryId: string, secondaryId: string, userId: string) =>
        this.writerService.mergePersons(primaryId, secondaryId, userId),
    );
  }

  @Get('admin/program-elements/person-candidates')
  @Roles('capiro_admin')
  personCandidates(@CurrentTenant() ctx: TenantContext, @Query() query: PersonCandidateQueryDto) {
    return this.readService.listPersonCandidates(query.status ?? 'open', query.page, query.limit, ctx);
  }

  @Post('admin/program-elements/person-candidates/:id/resolve')
  @Roles('capiro_admin')
  resolvePersonCandidate(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: ResolvePersonCandidateDto,
  ) {
    return this.readService.resolvePersonCandidate(id, body.decision, body.notes, ctx);
  }

  // user_admin (and above) can SUGGEST a person they know for a PE. The suggestion
  // becomes an open candidate (source=user_suggested) for capiro_admin review — it
  // never auto-applies a link.
  @Post('program-elements/:peCode/suggest-person')
  @Roles('user_admin')
  suggestPerson(
    @CurrentTenant() ctx: TenantContext,
    @Param('peCode') peCode: string,
    @Body() body: SuggestPersonDto,
  ) {
    return this.readService.suggestPersonForProgramElement(
      peCode.toUpperCase(),
      { fullName: body.fullName, roleTitle: body.roleTitle, organization: body.organization, notes: body.notes },
      ctx,
    );
  }
}
