import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { HIERARCHY_LEVELS } from './client-hierarchy.helpers.js';
import { ClientPeopleService } from './client-people.service.js';

class CreatePersonDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  lastContact?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

class UpdatePersonDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  lastContact?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

class UpdatePersonHierarchyDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsIn(HIERARCHY_LEVELS)
  hierarchyLevel?: (typeof HIERARCHY_LEVELS)[number] | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  reportsToPersonId?: string | null;

  @IsOptional()
  @IsBoolean()
  resetToAutomatic?: boolean;

  @IsOptional()
  @IsBoolean()
  reviewRequired?: boolean;
}

@Controller('clients/:clientId/people')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientPeopleController {
  constructor(private readonly service: ClientPeopleService) {}

  @Get()
  listPeople(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.listPeople(ctx, clientId);
  }

  @Post()
  createPerson(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: CreatePersonDto,
  ) {
    return this.service.createPerson(ctx, clientId, body);
  }

  @Patch(':id')
  updatePerson(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('id') id: string,
    @Body() body: UpdatePersonDto,
  ) {
    return this.service.updatePerson(ctx, clientId, id, body);
  }

  /**
   * Manual hierarchy placement, kept off PATCH :id so that editing a phone
   * number can never flip a person from automatic to manual placement.
   */
  @Patch(':id/hierarchy')
  updatePersonHierarchy(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('id') id: string,
    @Body() body: UpdatePersonHierarchyDto,
  ) {
    return this.service.updatePersonHierarchy(ctx, clientId, id, body);
  }

  @Delete(':id')
  deletePerson(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('id') id: string,
  ) {
    return this.service.deletePerson(ctx, clientId, id);
  }
}
