import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import {
  CreateObjectiveDto,
  ObjectiveTransitionDto,
  ObjectiveVersionDto,
  UpdateObjectiveDto,
} from './objective.dto.js';
import { ClientObjectivesService } from './objectives.service.js';

@Controller('clients/:clientId/objectives')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientObjectivesController {
  constructor(private readonly service: ClientObjectivesService) {}

  @Get()
  read(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Query('objectiveId', new ParseUUIDPipe({ optional: true })) objectiveId?: string,
  ) {
    return objectiveId
      ? this.service.get(ctx, clientId, objectiveId)
      : this.service.list(ctx, clientId);
  }

  @Post()
  create(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Body() body: CreateObjectiveDto,
  ) {
    return this.service.create(ctx, clientId, body);
  }

  @Patch()
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Query('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Body() body: UpdateObjectiveDto,
  ) {
    const { expectedVersion, ...fields } = body;
    return this.service.update(ctx, clientId, objectiveId, expectedVersion, fields);
  }

  @Post('transition')
  transition(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Query('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Body() body: ObjectiveTransitionDto,
  ) {
    return this.service.transition(ctx, clientId, objectiveId, body.expectedVersion, body.action);
  }

  @Delete()
  remove(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Query('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Body() body: ObjectiveVersionDto,
  ) {
    return this.service.remove(ctx, clientId, objectiveId, body.expectedVersion);
  }
}
