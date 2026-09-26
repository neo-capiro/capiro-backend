import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MeriV3InternalServiceGuard } from './meri-v3-internal-service.guard.js';
import { isMeriFinalProviderTools, MERI_FINAL_SCHEMA_VERSION } from './meri-tool-availability-proof.contract.js';
import { MeriToolAvailabilityProofService } from './meri-tool-availability-proof.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Internal dry-proof endpoint. The normal API tenant middleware still requires
 * the caller's bearer JWT; this strict additional guard requires service identity. */
@Controller('clio/internal/tool-availability-proof')
@UseGuards(RolesGuard, MeriV3InternalServiceGuard)
@Roles('standard_user')
export class MeriToolAvailabilityProofController {
  constructor(private readonly proof: MeriToolAvailabilityProofService) {}

  @Post()
  check(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('Body must contain only a valid turn-bound proof request');
    }
    const input = body as Record<string, unknown>;
    if (
      Object.keys(input).length !== 5 ||
      typeof input.conversationId !== 'string' ||
      !UUID_RE.test(input.conversationId) ||
      typeof input.turnNonce !== 'string' ||
      !UUID_RE.test(input.turnNonce) ||
      (input.surface !== 'chat' && input.surface !== 'research') ||
      input.finalSchemaVersion !== MERI_FINAL_SCHEMA_VERSION ||
      !isMeriFinalProviderTools(input.finalOfferedTools)
    ) {
      throw new BadRequestException('Body must contain only a valid turn-bound proof request');
    }
    return this.proof.prove(ctx, input.conversationId, {
      nonce: input.turnNonce,
      surface: input.surface,
      finalSchemaVersion: input.finalSchemaVersion,
      finalOfferedTools: input.finalOfferedTools,
    });
  }
}
