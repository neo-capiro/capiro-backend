import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { BusinessDevelopmentFlagGuard } from '../business-development-flag.guard.js';
import {
  CreateProspectContactDto,
  ProspectContactIdParams,
  ProspectContactParams,
  ProspectContactQuery,
  RemoveProspectContactDto,
  UpdateProspectContactDto,
} from './prospect-contacts.dto.js';
import { ProspectContactsService } from './prospect-contacts.service.js';
import { ProspectContactTransfersService } from './prospect-contact-transfers.service.js';

@Controller('business-development/prospects/:prospectId/contacts')
@UseGuards(RolesGuard, BusinessDevelopmentFlagGuard)
@Roles('standard_user', 'user_admin', 'capiro_admin')
export class ProspectContactsController {
  constructor(
    private readonly contacts: ProspectContactsService,
    private readonly transfers: ProspectContactTransfersService,
  ) {}
  @Post('transfers')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  transfer(
    @CurrentTenant() ctx: TenantContext,
    @Param('prospectId') prospectId: string,
    @Body() body: unknown,
  ) {
    return this.transfers.transfer(ctx, prospectId, body);
  }
  @Get('transfers/:requestId')
  @Header('Cache-Control', 'no-store')
  transferReceipt(
    @CurrentTenant() ctx: TenantContext,
    @Param('prospectId') prospectId: string,
    @Param('requestId') requestId: string,
  ) {
    return this.transfers.receipt(ctx, prospectId, requestId);
  }
  @Get() list(
    @CurrentTenant() ctx: TenantContext,
    @Param() p: ProspectContactParams,
    @Query() q: ProspectContactQuery,
  ) {
    return this.contacts.list(ctx, p.prospectId, q.after);
  }
  @Post() create(
    @CurrentTenant() ctx: TenantContext,
    @Param() p: ProspectContactParams,
    @Body() b: CreateProspectContactDto,
  ) {
    return this.contacts.create(ctx, p.prospectId, b);
  }
  @Patch(':contactId') update(
    @CurrentTenant() ctx: TenantContext,
    @Param() p: ProspectContactIdParams,
    @Body() b: UpdateProspectContactDto,
  ) {
    return this.contacts.update(ctx, p.prospectId, p.contactId, b);
  }
  @Delete(':contactId') remove(
    @CurrentTenant() ctx: TenantContext,
    @Param() p: ProspectContactIdParams,
    @Body() b: RemoveProspectContactDto,
  ) {
    return this.contacts.remove(ctx, p.prospectId, p.contactId, b.expectedVersion);
  }
}
