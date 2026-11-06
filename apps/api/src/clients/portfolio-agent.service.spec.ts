import {
  PortfolioAgentService,
  portfolioAgentEnvironment,
  type PortfolioAgentRequest,
} from './portfolio-agent.service.js';

jest.mock('node:fs/promises', () => ({
  mkdtemp: jest.fn().mockResolvedValue('/tmp/portfolio-agent-fixture'),
  rm: jest.fn().mockResolvedValue(undefined),
}));

const subject = { kind: 'client' as const, id: 'synthetic-client' };
const request: PortfolioAgentRequest = {
  subject,
  task: 'capability_document',
  schemaVersion: 'v1',
  instructions: 'Extract a supported name.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: { name: { type: 'string' } },
  },
  sources: [{ id: 'source-1', text: 'Fixture makes sensors.' }],
};
const success = {
  type: 'result',
  subtype: 'success',
  num_turns: 2,
  total_cost_usd: 0.01,
  permission_denials: [],
  modelUsage: {
    model: {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  },
  structured_output: {
    subject,
    data: { name: 'sensors' },
    evidence: [{ sourceId: 'source-1', quote: 'makes sensors' }],
  },
};
function fixture(message: unknown = success) {
  const close = jest.fn();
  const query = jest.fn(() =>
    Object.assign(
      (async function* () {
        yield message;
      })(),
      { close },
    ),
  );
  const tool = jest.fn((...args: unknown[]) => args);
  const sdk = { query, tool, createSdkMcpServer: jest.fn((options: unknown) => options) };
  return { service: new PortfolioAgentService(async () => sdk as never), query, close, tool };
}
describe('bounded Portfolio Claude Agent SDK task', () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env.PORTFOLIO_AGENT_MODEL = 'fixture-bedrock-model';
    process.env.AWS_REGION = 'us-east-1';
  });
  afterEach(() => {
    process.env = { ...original };
    jest.useRealTimers();
  });
  it('uses the preset, direct IAM, only source tools, schema and bounded native limits', async () => {
    const { service, query, close, tool } = fixture();
    const onAudit = jest.fn();
    const result = await service.extract({ ...request, onAudit });
    expect(result.data).toEqual({ name: 'sensors' });
    const options = (query.mock.calls[0] as unknown as [{ options: Record<string, any> }])[0]
      .options;
    expect(options.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
    expect(options.env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(options.tools).toEqual([]);
    expect(options.maxTurns).toBe(4);
    expect(options.maxBudgetUsd).toBe(0.5);
    expect(options.outputFormat.type).toBe('json_schema');
    expect(options.settingSources).toEqual([]);
    expect(options.allowedTools).toEqual([
      'mcp__portfolio_sources__read_source',
      'StructuredOutput',
    ]);
    await expect(
      options.canUseTool('StructuredOutput', success.structured_output),
    ).resolves.toEqual({ behavior: 'allow', updatedInput: success.structured_output });
    for (const name of [
      'Bash',
      'Write',
      'mcp__other__StructuredOutput',
      'mcp__other__read_source',
    ]) {
      await expect(options.canUseTool(name, {})).resolves.toMatchObject({ behavior: 'deny' });
    }
    const handler = tool.mock.calls[0]![3] as (value: { sourceId: string }) => Promise<any>;
    expect((await handler({ sourceId: 'different-source' })).isError).toBe(true);
    expect(close).toHaveBeenCalled();
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', inputTokens: 10 }),
    );
    expect(JSON.stringify(onAudit.mock.calls)).not.toContain('sensors');
  });
  it.each([
    [
      'invalid_output',
      {
        ...success,
        structured_output: {
          ...success.structured_output,
          subject: { kind: 'prospect', id: subject.id },
        },
      },
    ],
    [
      'invalid_output',
      { ...success, structured_output: { ...success.structured_output, data: { name: 2 } } },
    ],
    [
      'unsupported_evidence',
      {
        ...success,
        structured_output: {
          ...success.structured_output,
          evidence: [{ sourceId: 'source-1', quote: 'invented claim' }],
        },
      },
    ],
    ['forbidden_tool', { ...success, permission_denials: [{ tool_name: 'Write' }] }],
    ['error_during_execution', { ...success, is_error: true }],
    ['invalid_output', { ...success, structured_output: undefined }],
    ['error_max_budget_usd', { ...success, subtype: 'error_max_budget_usd' }],
    ['error_max_turns', { ...success, subtype: 'error_max_turns' }],
    [
      'error_max_structured_output_retries',
      { ...success, subtype: 'error_max_structured_output_retries' },
    ],
  ])('rejects %s with a content-free task audit', async (code, message) => {
    const { service, close } = fixture(message);
    const onAudit = jest.fn();
    await expect(service.extract({ ...request, onAudit })).rejects.toMatchObject({ code });
    expect(onAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: code }));
    expect(close).toHaveBeenCalled();
  });
  it('cancels a stalled native stream and rejects a late result', async () => {
    jest.useFakeTimers();
    const close = jest.fn();
    const sdk = {
      query: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
        close,
      }),
      tool: jest.fn(),
      createSdkMcpServer: jest.fn(),
    };
    const service = new PortfolioAgentService(async () => sdk as never);
    const result = service.extract({ ...request, timeoutMs: 10 });
    const assertion = expect(result).rejects.toMatchObject({ code: 'timeout' });
    await jest.advanceTimersByTimeAsync(11);
    await assertion;
    expect(close).toHaveBeenCalled();
  });
  it('never invokes SDK when cancelled, unconfigured, or missing evidence', async () => {
    const { service, query } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(service.extract({ ...request, signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
    await expect(service.extract({ ...request, sources: [] })).rejects.toMatchObject({
      code: 'invalid_sources',
    });
    delete process.env.PORTFOLIO_AGENT_MODEL;
    await expect(service.extract(request)).rejects.toMatchObject({ code: 'source_unavailable' });
    expect(query).not.toHaveBeenCalled();
  });
  it('does not forward raw provider keys, proxy endpoints or static AWS credentials', () => {
    const env = portfolioAgentEnvironment({
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'secret',
      ANTHROPIC_API_KEY: 'secret',
      ANTHROPIC_BASE_URL: 'https://proxy.invalid',
    });
    expect(env).not.toHaveProperty('AWS_ACCESS_KEY_ID');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
  });
  it('uses explicitly selected Anthropic runtime with only the injected provider credential', async () => {
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: 'synthetic-api-key',
      ANTHROPIC_AUTH_TOKEN: 'synthetic-oauth',
      ANTHROPIC_BASE_URL: 'https://proxy.invalid',
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_ACCESS_KEY_ID: 'synthetic-aws-key',
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/credentials',
      CLAUDE_CODE_USE_VERTEX: '1',
    });
    const { service, query } = fixture();
    const onAudit = jest.fn();
    await service.extract({
      ...request,
      runtime: { provider: 'anthropic', model: 'fixture-anthropic-model' },
      onAudit,
    });
    const options = (query.mock.calls[0] as unknown as [{ options: Record<string, any> }])[0]
      .options;
    expect(options.model).toBe('fixture-anthropic-model');
    expect(options.env.ANTHROPIC_API_KEY).toBe('synthetic-api-key');
    for (const key of [
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'AWS_ACCESS_KEY_ID',
      'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    ])
      expect(options.env).not.toHaveProperty(key);
    expect(options.verbatimPrompts).toBe(true);
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'anthropic', model: 'fixture-anthropic-model' }),
    );
    expect(JSON.stringify(onAudit.mock.calls)).not.toContain('synthetic-api-key');
  });
  it('never falls back to Bedrock when the explicitly selected Anthropic key is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { service, query } = fixture();
    await expect(
      service.extract({ ...request, runtime: { provider: 'anthropic', model: 'fixture' } }),
    ).rejects.toMatchObject({ code: 'source_unavailable' });
    expect(query).not.toHaveBeenCalled();
  });
  it('passes configured SDK output and retry limits to the actual query child', async () => {
    Object.assign(process.env, {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096',
      CLAUDE_CODE_MAX_RETRIES: '0',
      CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: '0',
      AWS_MAX_ATTEMPTS: '1',
    });
    const { service, query } = fixture();
    await service.extract(request);
    const options = (query.mock.calls[0] as unknown as [{ options: Record<string, any> }])[0]
      .options;
    expect(options.env).toMatchObject({
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096',
      CLAUDE_CODE_MAX_RETRIES: '0',
      CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: '0',
      AWS_MAX_ATTEMPTS: '1',
    });
  });
  it.each([
    ['CLAUDE_CODE_MAX_OUTPUT_TOKENS', '0'],
    ['AWS_MAX_ATTEMPTS', '0'],
    ['CLAUDE_CODE_MAX_RETRIES', '-1'],
    ['CLAUDE_CODE_MAX_RETRIES', '1.5'],
    ['CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES', '2oops'],
    ['CLAUDE_CODE_MAX_OUTPUT_TOKENS', '9007199254740992'],
  ])('refuses invalid %s=%s before query invocation', async (key, value) => {
    process.env[key] = value;
    const { service, query } = fixture();
    await expect(service.extract(request)).rejects.toMatchObject({ code: 'source_unavailable' });
    expect(query).not.toHaveBeenCalled();
  });
});
