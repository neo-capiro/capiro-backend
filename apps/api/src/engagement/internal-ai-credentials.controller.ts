import { BadRequestException, Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { InternalServiceGuard } from '../auth/internal-service.guard.js';
import { AiCredentialResolverService, type AiProvider } from './ai-credential-resolver.service.js';

// The global ValidationPipe runs whitelist:true + forbidNonWhitelisted:true, so
// an UNdecorated DTO has every property stripped/rejected -> the body arrives
// empty -> "tenantId is required" 400 -> intel-api's hearing BYOK3 resolve
// silently falls back to the global key, never the tenant's. These decorators
// whitelist the two fields so the tenant credential actually resolves.
class ResolveAiCredentialDto {
  @IsString()
  tenantId!: string;

  @IsOptional()
  @IsIn(['openai', 'anthropic'])
  provider?: 'openai' | 'anthropic';
}

/**
 * Internal-only (InternalServiceGuard) tenant-AI-credential resolve, for
 * backend-service callers that hold a tenantId but no Clerk-authenticated
 * TenantContext — currently intel-api's live-hearing extraction path (BYOK3,
 * "OPEN DECISION" in the MeriV2 migration readiness report). Mirrors
 * `resolveProviderByTenantId` (already built for scheduled-job / non-request
 * callers); returns the same shape apps/api forwards to the MeriV2
 * orchestrator as `x-capiro-ai-provider` for the in-editor BYOK path, so
 * callers can build that header identically.
 *
 * NOT reachable by an ordinary user JWT (InternalServiceGuard, not
 * RolesGuard) — this is the one route in the codebase that returns a raw
 * decrypted provider key, so it must never accept a browser-held token.
 */
@Controller('internal/ai-credentials')
@UseGuards(InternalServiceGuard)
export class InternalAiCredentialsController {
  constructor(private readonly aiCredentials: AiCredentialResolverService) {}

  @Post('resolve')
  @HttpCode(200)
  async resolve(@Body() dto: ResolveAiCredentialDto) {
    const tenantId = typeof dto?.tenantId === 'string' ? dto.tenantId.trim() : '';
    if (!tenantId) throw new BadRequestException('tenantId is required');
    const provider: AiProvider = dto.provider === 'openai' ? 'openai' : 'anthropic';

    const resolved = await this.aiCredentials.resolveProviderByTenantId(tenantId, provider);
    if (!resolved) return { resolved: false as const };
    return {
      resolved: true as const,
      provider: resolved.provider,
      apiKey: resolved.apiKey,
      model: resolved.model,
      usedTenantKey: resolved.usedTenantKey,
      modelOverridden: resolved.modelOverridden,
    };
  }
}
