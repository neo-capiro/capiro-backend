import { AiCredentialResolverService } from '../../ai-credentials/ai-credential-resolver.service.js';

function config() {
  const values: Record<string, unknown> = {
    OPENAI_API_KEY: 'platform-openai-key',
    ANTHROPIC_API_KEY: undefined,
    AI_PROVIDER: 'openai',
    OPENAI_MODEL: 'gpt-5.6',
    ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
    AI_CREDENTIAL_ENCRYPTION_KEY: undefined,
  };
  return {
    get: jest.fn((key: string) => values[key]),
  };
}

describe('Outreach V3 reasoning credential boundary', () => {
  it('uses the dedicated outreach_reasoning runtime action', async () => {
    const runtimePolicy = {
      assertExternalAction: jest.fn(),
      backgroundWorkersEnabled: jest.fn(() => false),
      snapshot: jest.fn(() => ({
        serviceName: 'engagement-api',
        backgroundOwner: 'disabled',
        mode: 'shadow',
      })),
    };
    const service = new AiCredentialResolverService(
      config() as never,
      {} as never,
      runtimePolicy as never,
    );

    await expect(
      service.resolveProviderForOutreachReasoning(
        { tenantId: '00000000-0000-4000-8000-000000000001' } as never,
        'openai',
      ),
    ).resolves.toMatchObject({
      provider: 'openai',
      apiKey: 'platform-openai-key',
      model: 'gpt-5.6',
      usedTenantKey: false,
    });
    expect(runtimePolicy.assertExternalAction).toHaveBeenCalledWith('outreach_reasoning');
  });

  it('does not let the reasoning-specific method bypass a denied runtime policy', async () => {
    const runtimePolicy = {
      assertExternalAction: jest.fn(() => {
        throw new Error('disabled');
      }),
      backgroundWorkersEnabled: jest.fn(() => false),
      snapshot: jest.fn(),
    };
    const service = new AiCredentialResolverService(
      config() as never,
      {} as never,
      runtimePolicy as never,
    );

    await expect(
      service.resolveProviderForOutreachReasoning(
        { tenantId: '00000000-0000-4000-8000-000000000001' } as never,
        'openai',
      ),
    ).rejects.toThrow('disabled');
  });

  it('keeps ordinary credential resolution on the pre-existing internal-ai action', async () => {
    const runtimePolicy = {
      assertExternalAction: jest.fn(),
      backgroundWorkersEnabled: jest.fn(() => false),
      snapshot: jest.fn(),
    };
    const service = new AiCredentialResolverService(
      config() as never,
      {} as never,
      runtimePolicy as never,
    );

    await service.resolveProvider(undefined, 'openai');
    expect(runtimePolicy.assertExternalAction).toHaveBeenCalledWith(
      'internal_ai_credential_resolve',
    );
  });
});
