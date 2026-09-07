import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import { TenantGuard } from '../auth/tenant.guard.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { AgenticGuard } from '../flags/agentic.guard.js';
import { ContextStewardGuard } from '../flags/context-steward.guard.js';
import { StrategyPlannerGuard } from '../flags/strategy-planner.guard.js';
import { ContextImportService } from './context-import.service.js';
import { AnalyzeContextImportDto, ResolveContextImportDto, SaveContextImportDto } from './dto/context-import.dto.js';

@Controller('context/imports')
@UseGuards(TenantGuard, StrategyPlannerGuard, AgenticGuard, ContextStewardGuard)
export class ContextImportController {
  constructor(private readonly imports: ContextImportService) {}

  @Post('resolve')
  resolve(@CurrentTenant() tc: AuthTenantContext, @Req() req: Request, @Body() dto: ResolveContextImportDto) {
    return this.imports.resolve(tc, req.headers.authorization, dto);
  }

  @Post('analyze')
  analyze(@CurrentTenant() tc: AuthTenantContext, @Req() req: Request, @Body() dto: AnalyzeContextImportDto) {
    return this.imports.analyze(tc, req.headers.authorization, dto.token);
  }

  @Post('save')
  save(@CurrentTenant() tc: AuthTenantContext, @Req() req: Request, @Body() dto: SaveContextImportDto) {
    return this.imports.save(tc, req.headers.authorization, dto);
  }
}
