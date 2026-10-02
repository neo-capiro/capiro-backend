import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MeriSourceService, type MeriSourceKind } from './meri-source.service.js';

class SourceQuery {
  @IsIn(['email', 'client', 'memory', 'document', 'controlled_read']) kind!: MeriSourceKind;
  @IsUUID() recordId!: string;
  @IsOptional() @IsUUID() conversationId?: string;
  @IsOptional() @IsUUID() threadId?: string;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsString() @MaxLength(100) section?: string;
  @IsOptional() @IsString() @MaxLength(4000) cursor?: string;
  @IsOptional() @IsString() @MaxLength(200) version?: string;
}

@Controller('clio/sources')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MeriSourceController {
  constructor(private readonly sources: MeriSourceService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  read(@CurrentTenant() ctx: TenantContext, @Query() query: SourceQuery) {
    return this.sources.read(ctx, query);
  }
}
