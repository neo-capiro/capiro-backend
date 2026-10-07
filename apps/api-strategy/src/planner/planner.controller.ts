import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { PlannerService } from './planner.service.js';
import { PlannerContextGuard } from './planner-context.guard.js';

/** Work Planner has its own project ACLs; it does not inherit the PPBE rollout flag. */
@Controller('planner')
@UseGuards(TenantGuard, PlannerContextGuard)
export class PlannerController {
  constructor(private readonly planner: PlannerService) {}
  @Get('bootstrap') bootstrap(@CurrentTenant() ctx: AuthTenantContext) {
    return this.planner.bootstrap(ctx);
  }
  @Get('queue') queue(@CurrentTenant() ctx: AuthTenantContext) {
    return this.planner.queue(ctx);
  }
  @Post('forms/:id/share') shareForm(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: unknown,
  ) {
    return this.planner.shareForm(ctx, id, dto);
  }
  @Post('projects') createProject(
    @CurrentTenant() ctx: AuthTenantContext,
    @Body() dto: unknown,
    @Req() req: Request,
  ) {
    return this.planner.saveProject(ctx, null, dto, req.headers.authorization);
  }
  @Post('projects/:id/duplicate') duplicateProject(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: unknown,
  ) {
    return this.planner.duplicateProject(ctx, id, dto);
  }
  @Post('projects/:id/reorder') reorder(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: unknown,
  ) {
    return this.planner.reorderTasks(ctx, id, dto);
  }
  @Patch('projects/:id') updateProject(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: unknown,
    @Req() req: Request,
  ) {
    return this.planner.saveProject(ctx, id, dto, req.headers.authorization);
  }
  @Get('tasks') tasks(
    @CurrentTenant() ctx: AuthTenantContext,
    @Query()
    query: {
      projectId?: string;
      mine?: string;
      search?: string;
      cursor?: string;
      archived?: string;
      parentId?: string;
    },
  ) {
    return this.planner.tasks(ctx, query);
  }
  @Get('tasks/:id') task(@CurrentTenant() ctx: AuthTenantContext, @Param('id') id: string) {
    return this.planner.task(ctx, id);
  }
  @Post('tasks') createTask(
    @CurrentTenant() ctx: AuthTenantContext,
    @Body() dto: unknown,
    @Req() req: Request,
  ) {
    return this.planner.saveTask(ctx, null, dto, req.headers.authorization);
  }
  @Patch('tasks/:id') updateTask(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: unknown,
    @Req() req: Request,
  ) {
    return this.planner.saveTask(ctx, id, dto, req.headers.authorization);
  }
  @Get('tasks/:id/events') taskEvents(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Query() query: { paged?: string; cursor?: string },
  ) {
    return this.planner.events(ctx, { taskId: id }, query);
  }
  @Post('tasks/:id/events') addTaskEvent(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: unknown,
  ) {
    return this.planner.addEvent(ctx, { taskId: id }, dto);
  }
  @Get('projects/:id/events') projectEvents(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Query() query: { paged?: string; cursor?: string },
  ) {
    return this.planner.events(ctx, { projectId: id }, query);
  }
  @Post('projects/:id/events') addProjectEvent(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: unknown,
  ) {
    return this.planner.addEvent(ctx, { projectId: id }, dto);
  }
  @Get('inbox') inbox(
    @CurrentTenant() ctx: AuthTenantContext,
    @Query() query: { paged?: string; cursor?: string; archived?: string },
  ) {
    return this.planner.inbox(ctx, query);
  }
  @Patch('inbox/:id') updateInbox(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: unknown,
  ) {
    return this.planner.updateInbox(ctx, id, dto);
  }
  @Get('resources') resources(@CurrentTenant() ctx: AuthTenantContext) {
    return this.planner.resources(ctx);
  }
  @Post('resources') createResource(@CurrentTenant() ctx: AuthTenantContext, @Body() dto: unknown) {
    return this.planner.saveResource(ctx, null, dto);
  }
  @Patch('resources/:id') updateResource(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: unknown,
  ) {
    return this.planner.saveResource(ctx, id, dto);
  }
  @Post('templates/:id/instantiate') instantiate(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: unknown,
  ) {
    return this.planner.instantiateTemplate(ctx, id, dto);
  }
  @Post('forms/:id/submit') submit(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: unknown,
  ) {
    return this.planner.submitForm(ctx, id, dto);
  }
}
