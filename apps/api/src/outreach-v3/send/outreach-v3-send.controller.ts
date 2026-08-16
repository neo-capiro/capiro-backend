import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { EngagementRuntimeAction } from '../../engagement/runtime/engagement-runtime-action.decorator.js';
import { OutreachV3ExceptionFilter } from '../api/outreach-v3-exception.filter.js';
import { OutreachV3StateGuard } from '../api/outreach-v3-state.guard.js';
import { OutreachV3SendGuard } from './outreach-v3-send.guard.js';
import {
  OutreachV3SendService,
  type OutreachV3PreflightRequest,
  type OutreachV3SendSettingsInput,
} from './outreach-v3-send.service.js';

@Controller('engagement/outreach-v3/sessions/:sessionId/send')
@UseGuards(OutreachV3StateGuard, OutreachV3SendGuard, RolesGuard)
@UseFilters(OutreachV3ExceptionFilter)
@Roles('standard_user')
export class OutreachV3SendController {
  constructor(private readonly send: OutreachV3SendService) {}

  @Get('settings')
  getSettings(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.send.getSettings(ctx, sessionId);
  }

  @Put('settings')
  saveSettings(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: unknown,
  ) {
    return this.send.saveSettings(ctx, sessionId, settingsBody(body));
  }

  @Post('preflight')
  preflight(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: unknown,
  ) {
    return this.send.preflight(ctx, sessionId, preflightBody(body));
  }

  @Post('test')
  @EngagementRuntimeAction('outreach_v3_test_send', { testMode: true })
  testSend(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: unknown,
  ) {
    const parsed = intentBody(body, true);
    return this.send.createIntent(ctx, sessionId, parsed.requestKey, parsed.request);
  }

  @Post('intent')
  @EngagementRuntimeAction('outreach_v3_send')
  createIntent(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: unknown,
  ) {
    const parsed = intentBody(body, false);
    return this.send.createIntent(ctx, sessionId, parsed.requestKey, parsed.request);
  }

  @Get('intents/:intentId')
  getIntent(
    @CurrentTenant() ctx: TenantContext,
    @Param('intentId', ParseUUIDPipe) intentId: string,
  ) {
    return this.send.getIntent(ctx, intentId);
  }

  @Post('intents/:intentId/refresh')
  @EngagementRuntimeAction('outreach_v3_send')
  refreshIntent(
    @CurrentTenant() ctx: TenantContext,
    @Param('intentId', ParseUUIDPipe) intentId: string,
  ) {
    return this.send.refreshIntent(ctx, intentId);
  }

  @Post('intents/:intentId/cancel')
  @EngagementRuntimeAction('outreach_v3_send')
  cancelIntent(
    @CurrentTenant() ctx: TenantContext,
    @Param('intentId', ParseUUIDPipe) intentId: string,
  ) {
    return this.send.cancelIntent(ctx, intentId);
  }
}

function settingsBody(value: unknown): OutreachV3SendSettingsInput {
  const body = strictObject(value, ['senderConnectionId', 'appendSignature', 'attachmentIds']);
  if (typeof body.senderConnectionId !== 'string') {
    throw invalid('senderConnectionId is required.');
  }
  if (body.appendSignature !== undefined && typeof body.appendSignature !== 'boolean') {
    throw invalid('appendSignature must be a boolean.');
  }
  if (
    body.attachmentIds !== undefined &&
    (!Array.isArray(body.attachmentIds) ||
      body.attachmentIds.some((entry) => typeof entry !== 'string'))
  ) {
    throw invalid('attachmentIds must be an array of ids.');
  }
  return {
    senderConnectionId: body.senderConnectionId,
    appendSignature: body.appendSignature !== false,
    attachmentIds: (body.attachmentIds as string[] | undefined) ?? [],
  };
}

function preflightBody(value: unknown): OutreachV3PreflightRequest {
  if (value === undefined || value === null) return {};
  const body = strictObject(value, [
    'excludedGenerationKeys',
    'testGenerationKey',
    'acknowledgeHeldOut',
  ]);
  if (
    body.excludedGenerationKeys !== undefined &&
    (!Array.isArray(body.excludedGenerationKeys) ||
      body.excludedGenerationKeys.some((entry) => typeof entry !== 'string'))
  ) {
    throw invalid('excludedGenerationKeys must be an array of generation keys.');
  }
  if (
    body.testGenerationKey !== undefined &&
    body.testGenerationKey !== null &&
    typeof body.testGenerationKey !== 'string'
  ) {
    throw invalid('testGenerationKey must be a generation key or null.');
  }
  if (body.acknowledgeHeldOut !== undefined && typeof body.acknowledgeHeldOut !== 'boolean') {
    throw invalid('acknowledgeHeldOut must be a boolean.');
  }
  return {
    excludedGenerationKeys: body.excludedGenerationKeys as string[] | undefined,
    testGenerationKey: body.testGenerationKey as string | null | undefined,
    acknowledgeHeldOut: body.acknowledgeHeldOut as boolean | undefined,
  };
}

function intentBody(
  value: unknown,
  testMode: boolean,
): { requestKey: string; request: OutreachV3PreflightRequest } {
  const body = strictObject(value, [
    'requestKey',
    'excludedGenerationKeys',
    'testGenerationKey',
    'acknowledgeHeldOut',
  ]);
  if (
    typeof body.requestKey !== 'string' ||
    body.requestKey.trim().length < 8 ||
    body.requestKey.trim().length > 128
  ) {
    throw invalid('requestKey must contain between eight and 128 characters.');
  }
  const request = preflightBody({
    excludedGenerationKeys: body.excludedGenerationKeys,
    testGenerationKey: body.testGenerationKey,
    acknowledgeHeldOut: body.acknowledgeHeldOut,
  });
  if (testMode && !request.testGenerationKey) {
    throw invalid('A test send requires one testGenerationKey.');
  }
  if (!testMode && request.testGenerationKey) {
    throw invalid('Real send does not accept testGenerationKey.');
  }
  return { requestKey: body.requestKey.trim(), request };
}

function strictObject(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('Request body must be an object.');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw invalid('Request body contains an unsupported field.');
  }
  return record;
}

function invalid(message: string): BadRequestException {
  return new BadRequestException(message);
}
