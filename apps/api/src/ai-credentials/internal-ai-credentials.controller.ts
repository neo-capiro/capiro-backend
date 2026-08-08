import { BadRequestException, Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { InternalServiceGuard } from '../auth/internal-service.guard.js';
import { AiCredentialResolverService, type AiProvider } from './ai-credential-resolver.service.js';

class ResolveAiCredentialDto {
  @IsString()
  tenantId!: string;

  @IsOptional()
  @IsIn(['openai', 'anthropic'])
  provider?: 'openai' | 'anthropic';
}

/**
 * Internal-service-only raw credential resolution. Ordinary browser bearer
 * tokens never satisfy InternalServiceGuard.
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
