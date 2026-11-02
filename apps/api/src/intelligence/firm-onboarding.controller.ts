import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { FirmOnboardingService } from './firm-onboarding.service.js';
import { IMPORT_JOB_PAGE_MAX } from './firm-import-job.contracts.js';

class SearchRegistrantsQueryDto {
  @IsString()
  @Length(2, 200)
  q!: string;
}

class SetRegistrantDto {
  @IsInt()
  @Min(1)
  registrantId!: number;
}

class ImportClientsDto {
  @IsArray()
  @ArrayMinSize(1)
  // Each id creates a Client + runs the prepopulation cascade synchronously in
  // the request (~several DB round trips each); 100 keeps a single import well
  // under the ALB idle timeout. The UI chunks larger selections into batches.
  @ArrayMaxSize(100)
  @IsInt({ each: true })
  ldaClientIds!: number[];

  /**
   * Stable client-supplied request identity for interrupted-response lookup.
   * Optional so existing callers keep their behavior; a replayed identity with
   * the same selection reconciles the persisted job, a changed one conflicts.
   */
  @IsOptional()
  @IsUUID()
  requestId?: string;
}

class ListImportJobsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(IMPORT_JOB_PAGE_MAX)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @IsUUID()
  requestId?: string;
}

/**
 * Firm-registrant onboarding + "import your clients". Reads are open to any
 * member; mutating the firm anchor and importing clients are user_admin (the
 * same bar as client create/update).
 */
@Controller('firm')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class FirmOnboardingController {
  constructor(private readonly svc: FirmOnboardingService) {}

  @Get('lda-registrants')
  searchRegistrants(@Query() query: SearchRegistrantsQueryDto) {
    return this.svc.searchRegistrants(query.q);
  }

  @Get('registrant')
  getRegistrant(@CurrentTenant() ctx: TenantContext) {
    return this.svc.getTenantRegistrant(ctx);
  }

  @Put('registrant')
  @Roles('user_admin')
  setRegistrant(@CurrentTenant() ctx: TenantContext, @Body() body: SetRegistrantDto) {
    return this.svc.setTenantRegistrant(ctx, body.registrantId);
  }

  @Get('import-candidates')
  importCandidates(@CurrentTenant() ctx: TenantContext) {
    return this.svc.listImportCandidates(ctx);
  }

  @Post('import')
  @Roles('user_admin')
  importClients(@CurrentTenant() ctx: TenantContext, @Body() body: ImportClientsDto) {
    return this.svc.importClients(ctx, body.ldaClientIds, { requestId: body.requestId });
  }

  /**
   * Durable status of the existing importer. Reads stay at the same bar as the
   * rest of onboarding (any member); tenant scoping/foreign-id behavior comes
   * from the service's withTenant reads.
   */
  @Get('import-jobs')
  listImportJobs(@CurrentTenant() ctx: TenantContext, @Query() query: ListImportJobsQueryDto) {
    return this.svc.listImportJobs(ctx, {
      limit: query.limit,
      cursor: query.cursor,
      requestKey: query.requestId,
    });
  }

  @Get('import-jobs/:jobId')
  getImportJob(
    @CurrentTenant() ctx: TenantContext,
    @Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string,
  ) {
    return this.svc.getImportJob(ctx, jobId);
  }

  @Get('import-jobs/:jobId/status')
  getImportJobStatus(
    @CurrentTenant() ctx: TenantContext,
    @Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string,
  ) {
    return this.svc.getImportJobStatus(ctx, jobId);
  }
}
