import { BadRequestException } from '@nestjs/common';
import { InternalAiCredentialsController } from './internal-ai-credentials.controller.js';
import type { AiCredentialResolverService } from './ai-credential-resolver.service.js';

describe('InternalAiCredentialsController', () => {
  it('requires tenantId', async () => {
    const aiCredentials = {
      resolveProviderByTenantId: jest.fn(),
    } as unknown as AiCredentialResolverService;
    const controller = new InternalAiCredentialsController(aiCredentials);
    await expect(controller.resolve({ tenantId: '' })).rejects.toBeInstanceOf(BadRequestException);
    // Missing tenantId: the global ValidationPipe now rejects this pre-handler
    // (the DTO is decorated), but the handler still defends — cast past the
    // now-required field to exercise that defensive throw directly.
    await expect(controller.resolve({} as { tenantId: string })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('resolves anthropic by default and returns the resolved shape', async () => {
    const resolveSpy = jest.fn().mockResolvedValue({
      provider: 'anthropic',
      apiKey: 'sk-tenant',
      model: 'claude-x',
      usedTenantKey: true,
      modelOverridden: false,
    });
    const aiCredentials = {
      resolveProviderByTenantId: resolveSpy,
    } as unknown as AiCredentialResolverService;
    const controller = new InternalAiCredentialsController(aiCredentials);

    const result = await controller.resolve({ tenantId: 'tenant-1' });
    expect(resolveSpy).toHaveBeenCalledWith('tenant-1', 'anthropic');
    expect(result).toEqual({
      resolved: true,
      provider: 'anthropic',
      apiKey: 'sk-tenant',
      model: 'claude-x',
      usedTenantKey: true,
      modelOverridden: false,
    });
  });

  it('honors an explicit openai provider', async () => {
    const resolveSpy = jest.fn().mockResolvedValue(null);
    const aiCredentials = {
      resolveProviderByTenantId: resolveSpy,
    } as unknown as AiCredentialResolverService;
    const controller = new InternalAiCredentialsController(aiCredentials);

    const result = await controller.resolve({ tenantId: 'tenant-1', provider: 'openai' });
    expect(resolveSpy).toHaveBeenCalledWith('tenant-1', 'openai');
    expect(result).toEqual({ resolved: false });
  });

  it('returns resolved:false when the tenant has no credential (no global fallback either)', async () => {
    const aiCredentials = {
      resolveProviderByTenantId: jest.fn().mockResolvedValue(null),
    } as unknown as AiCredentialResolverService;
    const controller = new InternalAiCredentialsController(aiCredentials);
    expect(await controller.resolve({ tenantId: 'tenant-1' })).toEqual({ resolved: false });
  });
});
