import type { Request } from 'express';
import { PROFILE_IDENTITY_PREVIEW_TIMEOUT_MS, withProfilePreviewAbort } from './profile-preview-abort.js';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
  Query,
  Req,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsHash,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import {
  CLIENT_PROFILE_FILL_SOURCES,
  type ClientProfileFillSource,
} from './client-profile-fill.helpers.js';
import { ClientProfileFillCompletionService } from './client-profile-fill-completion.service.js';
import { ProfileBuildService } from './profile-build.service.js';
import { profileSubject, type ProfileSubject } from './profile-subject.js';

class StartClientProfileFillDto {
  @IsOptional() @IsIn(['capabilities', 'alignment', 'business_units']) purpose?: 'capabilities' | 'alignment' | 'business_units';
  @IsOptional() @IsUUID() capabilityId?: string;
  @IsOptional() @IsUUID() businessUnitId?: string;
  /** Reuse this UUID after an interrupted response; it is also the durable run ID. */
  @IsUUID()
  requestId!: string;

  @IsOptional()
  @IsArray()
  // Explicit [] is meaningful: a legacy document-only run carries
  // requestedSources=[] (the legacy engine's own "attachmentId ? []" rule).
  // Rejecting [] at the boundary forced the workflow layer to widen it into
  // every connected source — silently broadening a document-only retry into
  // web research. Omitted still defaults to the full set in the service.
  @ArrayMaxSize(CLIENT_PROFILE_FILL_SOURCES.length)
  @IsIn(CLIENT_PROFILE_FILL_SOURCES, { each: true })
  sources?: ClientProfileFillSource[];

  /** Legacy one-document input. New clients send attachmentIds so documents and
   * connected sources can run together in the same durable workflow. */
  @IsOptional()
  @IsUUID()
  attachmentId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  attachmentIds?: string[];

  /** Imported LDA identities are always retained. These are only additional
   * identities the setup screen explicitly offered and the user selected. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  ldaClientIds?: number[];

  /** Initial profile research may propose LDA identities; it never confirms them. */
  @IsOptional()
  @IsBoolean()
  discoverLda?: boolean;

  /** Optional research-only website. Saved with the run; canonical client
   * website changes require a separate finding review/application. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string;
}

class RetryResearchTaskDto {
  @IsUUID()
  requestId!: string;

  @IsInt()
  @Min(0)
  @Max(2147483647)
  expectedAttempt!: number;

  @IsString()
  @MaxLength(80)
  expectedTaskType!: string;
}

class ReviewedFindingDto {
  @IsUUID()
  id!: string;

  @IsHash('sha256')
  revision!: string;
}

class ApplyClientProfileFillDto {
  @IsUUID()
  requestId!: string;

  @IsHash('sha256')
  expectedClientRevision!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ReviewedFindingDto)
  findings!: ReviewedFindingDto[];
}

class RejectClientProfileFillDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

/** Matches `NewMatterForRecordDto` on the advocacy-matter controller —
 *  same "create Matter" shape, reused here so a reviewer's "Create new
 *  Matter" choice on a pending finding goes through identical validation
 *  to the equivalent action elsewhere in the product. */
class NewMatterForFindingDto {
  @IsString()
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsIn([
    'funding_request',
    'legislative',
    'regulatory',
    'program_element',
    'community_project',
    'procurement',
    'other',
  ])
  matterType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  summary?: string;
}

/** §22/23 follow-up: "Attach to Matter X" / "Create new Matter" on a
 *  still-pending advocacy finding. Exactly one of `matterId`/`newMatter`
 *  is required — enforced in the service, not here, so the error message
 *  can name both fields together rather than two separate DTO-level
 *  "required" complaints depending on which one is missing. */
class AssignFindingMatterDto extends ApplyClientProfileFillDto {
  @IsOptional()
  @IsUUID()
  matterId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => NewMatterForFindingDto)
  newMatter?: NewMatterForFindingDto;
}

class UpdateClientProfileFillScheduleDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(6)
  @Max(720)
  cadenceHours?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CLIENT_PROFILE_FILL_SOURCES.length)
  @IsIn(CLIENT_PROFILE_FILL_SOURCES, { each: true })
  sources?: ClientProfileFillSource[];
}

function routeSubject(params:Record<string,string>):ProfileSubject {
 return profileSubject(params.prospectId?'prospect':'client',params.prospectId??params.clientId!);
}
@Controller(['clients/:clientId/profile-build','business-development/prospects/:prospectId/profile-build'])
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientProfileFillController {
 constructor(private readonly service:ProfileBuildService,private readonly completion:ClientProfileFillCompletionService){}
 @Get('setup') setup(@CurrentTenant()ctx:TenantContext,@Param()params:Record<string,string>){return this.service.setup(ctx,routeSubject(params));}
 @Post('runs') @HttpCode(HttpStatus.ACCEPTED)
 start(@CurrentTenant()ctx:TenantContext,@Param()params:Record<string,string>,@Body()body:StartClientProfileFillDto){
  return this.service.start(ctx,routeSubject(params),{...body,attachmentIds:[...new Set([...(body.attachmentIds??[]),...(body.attachmentId?[body.attachmentId]:[])])]});
 }
 @Get('latest') latest(@CurrentTenant()ctx:TenantContext,@Param()params:Record<string,string>){return this.service.latest(ctx,routeSubject(params));}
 @Get('runs/:runId') getRun(@CurrentTenant()ctx:TenantContext,@Param()params:Record<string,string>){return this.service.run(ctx,routeSubject(params),params.runId!);}
 @Post('runs/:runId/cancel') cancel(@CurrentTenant()ctx:TenantContext,@Param()params:Record<string,string>){return this.service.cancel(ctx,routeSubject(params),params.runId!);}
 @Post('runs/:runId/tasks/:taskId/retry') retryTask(@CurrentTenant()ctx:TenantContext,@Param()params:Record<string,string>,@Body()body:RetryResearchTaskDto){return this.service.retry(ctx,routeSubject(params),params.runId!,params.taskId!,body);}
 @Get('runs/:runId/review') review(@CurrentTenant()ctx:TenantContext,@Param()params:Record<string,string>){return this.service.review(ctx,routeSubject(params),params.runId!);}
 @Post('runs/:runId/apply') @Roles('user_admin')
 apply(@CurrentTenant()ctx:TenantContext,@Param()params:Record<string,string>,@Body()body:ApplyClientProfileFillDto){return this.service.apply(ctx,routeSubject(params),params.runId!,body);}
 @Post('findings/:findingId/reject') @Roles('user_admin')
 reject(@CurrentTenant()ctx:TenantContext,@Param()params:Record<string,string>,@Body()body:RejectClientProfileFillDto){return this.service.decision(ctx,routeSubject(params),params.findingId!,false,body.reason);}
 @Post('findings/:findingId/restore') @Roles('user_admin')
 restore(@CurrentTenant()ctx:TenantContext,@Param()params:Record<string,string>){return this.service.decision(ctx,routeSubject(params),params.findingId!,true);}
 @Get('profile') profile(@CurrentTenant()ctx:TenantContext,@Param()params:Record<string,string>){return this.service.profile(ctx,routeSubject(params));}
 @Put('profile') saveProfile(@CurrentTenant()ctx:TenantContext,@Param()params:Record<string,string>,@Body()body:unknown){return this.service.save(ctx,routeSubject(params),body);}
 @Post('facts/:factId/resolve') @Roles('user_admin')
 resolveFact(@CurrentTenant()ctx:TenantContext,@Param()params:Record<string,string>,@Body()body:{requestId:string;expectedVersion:number;resolution:'keep_current'|'accept_proposed'}){return this.service.resolveFact(ctx,routeSubject(params),params.factId!,body);}
 @Post('identity/preview') identify(@CurrentTenant()ctx:TenantContext,@Body()body:unknown,@Req()request:Request){return withProfilePreviewAbort(request, signal=>this.service.identify(ctx,body,signal),PROFILE_IDENTITY_PREVIEW_TIMEOUT_MS);}
 @Post('identity/confirm') confirmIdentity(@CurrentTenant()ctx:TenantContext,@Param()params:Record<string,string>,@Body()body:{requestId:string;expectedVersion:string;canonicalEntityId:string}){return this.service.confirmIdentity(ctx,routeSubject(params),body);}
 @Get('references') references(@CurrentTenant()ctx:TenantContext,@Query('kind')kind:string,@Query('q')q?:string){return this.service.references(ctx,kind,q);}
 @Post('refresh-now') @HttpCode(HttpStatus.ACCEPTED)
 refreshNow(@CurrentTenant()ctx:TenantContext,@Param()params:Record<string,string>,@Body()body:StartClientProfileFillDto){return params.prospectId?this.service.start(ctx,routeSubject(params),body):this.completion.refreshNow(ctx,params.clientId!);}
 @Get('refresh-schedule') getRefreshSchedule(@CurrentTenant()ctx:TenantContext,@Param()params:Record<string,string>){this.clientOnly(params);return this.completion.getSchedule(ctx,params.clientId!);}
 @Put('refresh-schedule') @Roles('user_admin')
 updateRefreshSchedule(@CurrentTenant()ctx:TenantContext,@Param()params:Record<string,string>,@Body()body:UpdateClientProfileFillScheduleDto){this.clientOnly(params);return this.completion.updateSchedule(ctx,params.clientId!,body);}
 @Get('advocacy-history/health') getAdvocacyHistoryHealth(@CurrentTenant()ctx:TenantContext,@Param()params:Record<string,string>){this.clientOnly(params);return this.completion.getAdvocacyHistoryHealth(ctx,params.clientId!);}
 @Post('runs/:runId/findings/:findingId/assign-matter') @Roles('user_admin')
 assignFindingMatter(@CurrentTenant()ctx:TenantContext,@Param()params:Record<string,string>,@Body()body:AssignFindingMatterDto){
  this.clientOnly(params);if(Boolean(body.newMatter)===Boolean(body.matterId))throw new BadRequestException('Choose exactly one matter');
  return this.completion.applyAdvocacyFindingToMatter(ctx,params.clientId!,params.runId!,params.findingId!,body.newMatter?{newMatter:body.newMatter}:{matterId:body.matterId!},body);
 }
 private clientOnly(params:Record<string,string>){if(params.prospectId)throw new BadRequestException('This ongoing client service becomes available after conversion');}
}

/** Register before ClientsController's :id route so pre-creation lookup is unambiguous. */
@Controller('clients/profile-build')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ProfileBuildEntryController{
 constructor(private readonly service:ProfileBuildService){}
 @Post('identity-preview') identify(@CurrentTenant()ctx:TenantContext,@Body()body:unknown,@Req()request:Request){return withProfilePreviewAbort(request, signal=>this.service.identify(ctx,body,signal),PROFILE_IDENTITY_PREVIEW_TIMEOUT_MS);}
 @Post('identity-confirm') confirmSource(@CurrentTenant()ctx:TenantContext,@Body()body:unknown,@Req()request:Request){return withProfilePreviewAbort(request, signal=>this.service.confirmSourceIdentity(ctx,body,signal));}
 @Get('references') references(@CurrentTenant()ctx:TenantContext,@Query('kind')kind:string,@Query('q')q?:string){return this.service.references(ctx,kind,q);}
}
