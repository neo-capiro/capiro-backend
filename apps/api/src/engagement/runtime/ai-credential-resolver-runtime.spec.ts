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

describe('AiCredentialResolverService runtime ownership', () => {
  it('does not touch Prisma during shadow onModuleInit', async () => {
    const withSystem = jest.fn();
    const prisma = { withSystem } as never;
    const runtime = new EngagementRuntimePolicyService({
      serviceName: 'engagement-api',
      processMode: 'shadow',
      backgroundOwner: 'disabled',
      externalActions: 'disabled',
      callbacksEnabled: false,
      recallWebhookEnabled: false,
    });
    const service = new AiCredentialResolverService(config, prisma, runtime);
    await service.onModuleInit();
    expect(withSystem).not.toHaveBeenCalled();
  });
});
