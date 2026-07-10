import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, Length, MaxLength } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { DirectoryService } from './directory.service.js';

class CreateDirectoryContactNoteDto {
  @IsString()
  @Length(1, 4000)
  body!: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  directoryContactName?: string;
}

class FavoriteContactDto {
  @IsOptional()
  @IsString()
  @MaxLength(240)
  directoryContactName?: string;
}

@Controller('directory')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class DirectoryController {
  constructor(private readonly service: DirectoryService) {}

  @Get('contacts')
  contacts(
    @Query('q') q?: string,
    @Query('freshman') freshman?: string,
    @Query('chamber') chamber?: string,
    @Query('party') party?: string | string[],
    @Query('gender') gender?: string,
    @Query('leadership') leadership?: string | string[],
    @Query('committee') committee?: string | string[],
    @Query('caucus') caucus?: string | string[],
    @Query('region') region?: string,
    @Query('state') state?: string | string[],
    @Query('district') district?: string | string[],
    @Query('education') education?: string | string[],
    @Query('sort') sort?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.getContacts({
      q,
      freshman,
      chamber,
      party,
      gender,
      leadership,
      committee,
      caucus,
      region,
      state,
      district,
      education,
      sort,
      page,
      pageSize,
    });
  }

  @Get('staffers')
  staffers(
    @Query('q') q?: string,
    @Query('chamber') chamber?: string,
    @Query('state') state?: string | string[],
    @Query('issue') issue?: string | string[],
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.getStaffers({ q, chamber, state, issue, page, pageSize });
  }

  @Get('committees')
  committees(
    @Query('q') q?: string,
    @Query('chamber') chamber?: string,
    @Query('kind') kind?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.getCommittees({ q, chamber, kind, page, pageSize });
  }

  @Get('committees/:committeeId/staff')
  committeeStaff(
    @Param('committeeId') committeeId: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.getCommitteeStaff(committeeId, { q, page, pageSize });
  }

  @Get('contacts/:contactId/notes')
  contactNotes(@CurrentTenant() ctx: TenantContext, @Param('contactId') contactId: string) {
    return this.service.listContactNotes(ctx, contactId);
  }

  // Member-scoped FEC summary: the financial relationship between this member and
  // the tenant's mapped clients. Approximate (name-matched), disclaimer-wrapped.
  @Get('contacts/:contactId/fec-summary')
  contactFecSummary(@CurrentTenant() ctx: TenantContext, @Param('contactId') contactId: string) {
    return this.service.getMemberFecSummary(ctx, contactId);
  }

  // District Impact Engine (Phase 1 M1.4) — "Represents client facilities":
  // deterministic (bioguideId + district join, PD2), unlike the FEC summary.
  @Get('contacts/:contactId/representation-summary')
  contactRepresentationSummary(
    @CurrentTenant() ctx: TenantContext,
    @Param('contactId') contactId: string,
  ) {
    return this.service.getMemberRepresentationSummary(ctx, contactId);
  }

  // Recent press items for the member (pre-ingested into member_press_item by the
  // sync-member-press job). Global directory data — auth-gated by the class guard.
  @Get('contacts/:contactId/news')
  contactNews(@Param('contactId') contactId: string) {
    return this.service.getMemberNews(contactId);
  }

  @Post('contacts/:contactId/notes')
  createContactNote(
    @CurrentTenant() ctx: TenantContext,
    @Param('contactId') contactId: string,
    @Body() body: CreateDirectoryContactNoteDto,
  ) {
    return this.service.createContactNote(ctx, contactId, body);
  }

  // Per-user favorites/stars for directory members (quick access in outreach).
  @Get('favorites')
  favorites(@CurrentTenant() ctx: TenantContext) {
    return this.service.listFavorites(ctx);
  }

  @Post('contacts/:contactId/favorite')
  addFavorite(
    @CurrentTenant() ctx: TenantContext,
    @Param('contactId') contactId: string,
    @Body() body: FavoriteContactDto,
  ) {
    return this.service.addFavorite(ctx, contactId, body.directoryContactName);
  }

  @Delete('contacts/:contactId/favorite')
  removeFavorite(@CurrentTenant() ctx: TenantContext, @Param('contactId') contactId: string) {
    return this.service.removeFavorite(ctx, contactId);
  }
}
