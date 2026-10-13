import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import type { Response } from 'express';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { EngagementRuntimeAction } from './runtime/engagement-runtime-action.decorator.js';
import { NewsletterOutreachService } from './newsletter-outreach.service.js';

class DestinationDto {
  @IsEmail() @MaxLength(320) email!: string;
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsString() @MaxLength(200) directoryContactId?: string;
  @IsOptional() @IsString() @MaxLength(200) company?: string;
  @IsOptional() @IsString() @MaxLength(100) phone?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsEmail({}, { each: true }) cc?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsEmail({}, { each: true }) bcc?: string[];
}
class PrepareDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => DestinationDto)
  recipients!: DestinationDto[];
  @IsArray() @ArrayMaxSize(500) @IsObject({ each: true }) targets!: object[];
  @IsUUID() senderConnectionId!: string;
  @IsString() @Length(1, 300) subject!: string;
}
class SendDto {
  @IsString() @Length(8, 128) requestKey!: string;
  @IsUUID() senderConnectionId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('4', { each: true }) versionIds!: string[];
}
class SurveyDto {
  @IsString() @Length(1, 100) block!: string;
  @IsString() @Length(1, 500) answer!: string;
}
@Controller('engagement/newsletters')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class NewsletterOutreachController {
  constructor(private readonly service: NewsletterOutreachService) {}
  @Get('stages/:id') stage(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.stage(ctx, id);
  }
  @Post('stages/:id/open') open(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.open(ctx, id);
  }
  @Get(':id') get(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.get(ctx, id);
  }
  @Post(':id/prepare') prepare(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: PrepareDto,
  ) {
    return this.service.prepare(ctx, id, body);
  }
  @Post(':id/send')
  @EngagementRuntimeAction('outreach_send')
  send(@CurrentTenant() ctx: TenantContext, @Param('id') id: string, @Body() body: SendDto) {
    return this.service.send(ctx, id, body);
  }
  @Post(':id/test')
  @EngagementRuntimeAction('outreach_test_send', { testMode: true })
  test(@CurrentTenant() ctx: TenantContext, @Param('id') id: string, @Body() body: SendDto) {
    return this.service.send(ctx, id, body, true);
  }
}

/** Only these capability routes bypass Clerk; the authoring API stays private. */
@Controller('engagement/newsletter-public')
export class NewsletterPublicController {
  constructor(private readonly service: NewsletterOutreachService) {}
  private html(res: Response, html: string) {
    res
      .set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https: http:; form-action 'self'; frame-ancestors 'none'",
      })
      .send(html);
  }
  @Get(':token/archive') async archive(@Param('token') token: string, @Res() res: Response) {
    this.html(res, await this.service.publicArchive(token));
  }
  @Get(':token/unsubscribe') async unsubscribe(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    this.html(res, await this.service.preferences(token));
  }
  @Post(':token/unsubscribe') async confirmUnsubscribe(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    this.html(res, await this.service.preferences(token, true));
  }
  @Get(':token/preferences') async preferences(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    this.html(res, await this.service.preferences(token));
  }
  @Post(':token/preferences') async savePreferences(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    this.html(res, await this.service.preferences(token, true));
  }
  @Get(':token/survey') async survey(
    @Param('token') token: string,
    @Query() query: SurveyDto,
    @Res() res: Response,
  ) {
    this.html(res, await this.service.survey(token, query.block, query.answer));
  }
  @Post(':token/survey') async submitSurvey(
    @Param('token') token: string,
    @Query() query: SurveyDto,
    @Res() res: Response,
  ) {
    this.html(res, await this.service.survey(token, query.block, query.answer, true));
  }
}
