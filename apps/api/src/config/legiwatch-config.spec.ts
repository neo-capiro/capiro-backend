import { configSchema, validateConfig } from './config.schema.js';

describe('LegiWatch runtime configuration', () => {
  const base = {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    CLERK_SECRET_KEY: 'synthetic', CLERK_WEBHOOK_SIGNING_SECRET: 'synthetic',
  };
  test('preserves the Bedrock default and bounded aggregate limits', () => {
    expect(validateConfig(base)).toMatchObject({
      LEGIWATCH_AGENT_PROVIDER: 'bedrock', LEGIWATCH_AGENT_TIMEOUT_MS: 90_000,
      LEGIWATCH_AGENT_MAX_TURNS: 4, LEGIWATCH_AGENT_MAX_BUDGET_USD: 0.5,
      LEGIWATCH_IMPACT_REFRESH_TIMEOUT_MS: 240_000,
    });
  });
  test('requires both an explicit Anthropic model and task-injected credential', () => {
    for (const incomplete of [{}, { ANTHROPIC_API_KEY: 'synthetic' },
      { LEGIWATCH_AGENT_MODEL: 'synthetic-claude' },
      { LEGIWATCH_AGENT_MODEL: 'synthetic-claude', ANTHROPIC_API_KEY: ' ' }]) {
      expect(() => validateConfig({ ...base, LEGIWATCH_AGENT_PROVIDER: 'anthropic', ...incomplete }))
        .toThrow('LegiWatch Anthropic provider requires');
    }
    expect(validateConfig({ ...base, LEGIWATCH_AGENT_PROVIDER: 'anthropic',
      LEGIWATCH_AGENT_MODEL: 'synthetic-claude', ANTHROPIC_API_KEY: 'synthetic' }))
      .toMatchObject({ LEGIWATCH_AGENT_PROVIDER: 'anthropic', LEGIWATCH_AGENT_MODEL: 'synthetic-claude' });
  });
  test('rejects unsupported providers and over-ceiling settings', () => {
    expect(() => configSchema.shape.LEGIWATCH_AGENT_PROVIDER.parse('openai')).toThrow();
    expect(() => configSchema.shape.LEGIWATCH_AGENT_TIMEOUT_MS.parse('120001')).toThrow();
    expect(() => configSchema.shape.LEGIWATCH_AGENT_MAX_TURNS.parse('9')).toThrow();
    expect(() => configSchema.shape.LEGIWATCH_AGENT_MAX_BUDGET_USD.parse('2.01')).toThrow();
    expect(() => configSchema.shape.LEGIWATCH_IMPACT_REFRESH_TIMEOUT_MS.parse('900001')).toThrow();
  });
});
