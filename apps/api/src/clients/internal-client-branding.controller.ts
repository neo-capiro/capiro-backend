import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { InternalServiceGuard } from '../auth/internal-service.guard.js';
import { ClientsService } from './clients.service.js';

/**
 * Backend-only co-branding read for apps/workspace's Hill Day packet: the
 * sponsor's logo and the firm's logo as short-lived signed URLs, so the
 * server-side PDF renderer can embed the marks without S3 access of its own.
 * Gated by InternalServiceGuard (shared service secret, fail-closed).
 */
@Controller('internal/clients')
@UseGuards(InternalServiceGuard)
export class InternalClientBrandingController {
  constructor(private readonly clients: ClientsService) {}

  @Get(':clientId/branding')
  branding(@Param('clientId') clientId: string, @Query('tenantId') tenantId?: string) {
    if (!tenantId?.trim()) throw new BadRequestException('tenantId is required');
    return this.clients.internalBranding(tenantId.trim(), clientId);
  }
}
