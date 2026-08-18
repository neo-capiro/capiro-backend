import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../roles/roles.decorator.js';
import { RolesGuard } from '../roles/roles.guard.js';
import { DefenseCurrentTenant } from '../roles/current-tenant.decorator.js';
import { TenantGuard } from '@capiro/auth';
import { DefenseMemberResolverGuard } from '../roles/defense-member-resolver.guard.js';
import type { DefenseTenantContext } from './program-elements.shared.js';
import { ProgramsService } from './programs.service.js';
import {
  CreateAliasDto,
  MatchQueueQueryDto,
  MergeProgramsDto,
  ProgramSearchDto,
  ResolveMatchDto,
  UpdateAliasDto,
} from './dto/program-elements.dto.js';

@Controller('programs')
@UseGuards(TenantGuard, DefenseMemberResolverGuard, RolesGuard)
@Roles('standard_user')
export class ProgramsController {
  constructor(private readonly service: ProgramsService) {}

  @Get('admin/match-queue')
  @Roles('capiro_admin')
  matchQueue(@Query() query: MatchQueueQueryDto) {
    return this.service.listMatchQueue(query.status, query.page, query.limit);
  }

  @Post('admin/match-queue/:id/resolve')
  @Roles('capiro_admin')
  resolveMatch(@DefenseCurrentTenant() ctx: DefenseTenantContext, @Param('id') id: string, @Body() body: ResolveMatchDto) {
    return this.service.resolveMatch(id, { decision: body.decision, notes: body.notes }, ctx);
  }

  @Get('admin/duplicate-aliases')
  @Roles('capiro_admin')
  duplicateAliases() {
    return this.service.listDuplicateAliases();
  }

  @Post('admin/merge')
  @Roles('capiro_admin')
  merge(@DefenseCurrentTenant() ctx: DefenseTenantContext, @Body() body: MergeProgramsDto) {
    return this.service.mergePrograms({ keepProgramId: body.keepProgramId, mergeProgramId: body.mergeProgramId }, ctx);
  }

  @Get('admin/:programId/aliases')
  @Roles('capiro_admin')
  listAliases(@Param('programId') programId: string) {
    return this.service.listAliases(programId);
  }

  @Post('admin/:programId/aliases')
  @Roles('capiro_admin')
  createAlias(@DefenseCurrentTenant() ctx: DefenseTenantContext, @Param('programId') programId: string, @Body() body: CreateAliasDto) {
    return this.service.createAlias(programId, { alias: body.alias, aliasType: body.aliasType, source: body.source }, ctx);
  }

  @Patch('admin/aliases/:id')
  @Roles('capiro_admin')
  updateAlias(@DefenseCurrentTenant() ctx: DefenseTenantContext, @Param('id') id: string, @Body() body: UpdateAliasDto) {
    return this.service.updateAlias(id, { alias: body.alias, aliasType: body.aliasType }, ctx);
  }

  @Delete('admin/aliases/:id')
  @Roles('capiro_admin')
  deleteAlias(@DefenseCurrentTenant() ctx: DefenseTenantContext, @Param('id') id: string) {
    return this.service.deleteAlias(id, ctx);
  }

  @Get()
  search(@Query() query: ProgramSearchDto) {
    return this.service.searchPrograms(query.q, query.limit);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.service.getProgram(id);
  }
}
