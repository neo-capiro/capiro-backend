import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { AiCredentialResolverService } from '../ai-credential-resolver.service.js';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';

const config = {
  get: jest.fn((key: string) => {
    if (key === 'OPENAI_MODEL') return 'gpt-test';
    if (key === 'ANTHROPIC_MODEL') return 'claude-test';
    return undefined;
  }),
} as never;

function shadowRuntime(): EngagementRuntimePolicyService {
  return new EngagementRuntimePolicyService({
    serviceName: 'engagement-api',
    processMode: 'shadow',
    backgroundOwner: 'disabled',
    externalActions: 'disabled',
    callbacksEnabled: false,
    recallWebhookEnabled: false,
  });
}

describe('AiCredentialResolverService runtime ownership', () => {
  it('does not touch Prisma during shadow onModuleInit', async () => {
    const withSystem = jest.fn();
    const prisma = { withSystem } as never;
    const service = new AiCredentialResolverService(config, prisma, shadowRuntime());
    await service.onModuleInit();
    expect(withSystem).not.toHaveBeenCalled();
  });

  it.each([
    ['resolveOrder', [null]],
    ['resolveProvider', [null, 'openai']],
    ['resolveProviderByTenantId', ['tenant-1', 'openai']],
    ['validateKey', ['openai', 'sk-test']],
  ] as Array<[string, unknown[]]>)('blocks %s before Prisma, decryption, or fetch', async (method, args) => {
    const withTenant = jest.fn();
    const prisma = { withTenant, withSystem: jest.fn() } as never;
    const service = new AiCredentialResolverService(config, prisma, shadowRuntime()) as unknown as Record<
      string,
      (...values: unknown[]) => Promise<unknown>
    >;
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    let caught: unknown;
    try {
      await service[method]?.(...args as unknown[]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    expect((caught as ServiceUnavailableException).getResponse()).toMatchObject({
      code: 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED',
      action: 'internal_ai_credential_resolve',
    });
    expect(withTenant).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
