import {
  MeriV3SemanticCompatibilityTools,
  type MeriSemanticCompatibilitySchema,
} from './meriv3-semantic-compatibility-tools.js';

const schema = (name: string): MeriSemanticCompatibilitySchema => ({
  name,
  description: name,
  input_schema: { type: 'object', properties: {} },
});

function config(values: Record<string, string | undefined> = {}) {
  return {
    get: jest.fn((key: string) => values[key]),
  } as never;
}

describe('MeriV3SemanticCompatibilityTools', () => {
  test('is default-off and leaves legacy schemas untouched', () => {
    const tools = new MeriV3SemanticCompatibilityTools(config());
    const input = [schema('get_funding_opportunity'), schema('create_word')];

    expect(tools.prepareSchemas(input, 'tenant-1')).toEqual(input);
    expect(tools.isEnabledTool('analyze_funding_opportunity', 'tenant-1')).toBe(false);
    expect(tools.isEnabledTool('create_artifact', 'tenant-1')).toBe(false);
  });

  test('funding wrapper hides redundant reasoning schemas but keeps atomic get', () => {
    const tools = new MeriV3SemanticCompatibilityTools(
      config({
        MERI_FUNDING_SEMANTIC_TOOLS_ENABLED: 'true',
        MERI_FUNDING_SEMANTIC_TOOLS_TENANTS: 'tenant-1',
      }),
    );
    const prepared = tools.prepareSchemas(
      [
        schema('get_funding_opportunity'),
        schema('explain_opportunity_match'),
        schema('get_opportunity_client_context'),
        schema('get_opportunity_government_landscape'),
        schema('compare_funding_opportunities'),
        schema('build_opportunity_action_plan'),
      ],
      'tenant-1',
    );
    const names = prepared.map((item) => item.name);

    expect(names).toContain('get_funding_opportunity');
    expect(names).toContain('analyze_funding_opportunity');
    expect(names).not.toContain('compare_funding_opportunities');
    expect(names).not.toContain('build_opportunity_action_plan');
    expect(names).not.toContain('explain_opportunity_match');
  });

  test('funding wrapper returns evidence from existing governed reads', async () => {
    const tools = new MeriV3SemanticCompatibilityTools(
      config({
        MERI_FUNDING_SEMANTIC_TOOLS_ENABLED: 'true',
        MERI_FUNDING_SEMANTIC_TOOLS_TENANTS: '*',
      }),
    );
    const invoke = jest.fn(async (name: string) => ({ tool: name, state: 'available' }));

    const result = await tools.execute(
      'analyze_funding_opportunity',
      {
        clientId: '11111111-1111-4111-8111-111111111111',
        source: 'sam_gov',
        sourceRecordId: 'notice-1',
      },
      invoke,
    );

    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      'get_funding_opportunity',
      'get_opportunity_client_context',
      'explain_opportunity_match',
      'get_opportunity_government_landscape',
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        kind: 'funding_opportunity_evidence',
        analysisOwner: 'openai',
      }),
    );
  });

  test('artifact wrapper hides legacy schemas and delegates through the same write tool', async () => {
    const tools = new MeriV3SemanticCompatibilityTools(
      config({
        MERI_ARTIFACT_TOOL_V2_ENABLED: 'true',
        MERI_ARTIFACT_TOOL_V2_TENANTS: 'tenant-1',
      }),
    );
    const prepared = tools.prepareSchemas(
      [schema('create_word'), schema('create_excel'), schema('draft_policy_memo')],
      'tenant-1',
    );
    expect(prepared.map((item) => item.name)).toEqual(['create_artifact']);

    const artifactSchema = prepared[0]?.input_schema as {
      properties?: Record<string, unknown>;
    };
    expect(artifactSchema.properties).toEqual(
      expect.objectContaining({ clientId: expect.any(Object), conversationId: expect.any(Object) }),
    );

    const invoke = jest.fn(async (name: string, input: Record<string, unknown>) => ({
      name,
      input,
    }));
    const result = await tools.execute(
      'create_artifact',
      {
        type: 'word',
        clientId: '11111111-1111-4111-8111-111111111111',
        conversationId: 'conversation-1',
        spec: { title: 'Strategy', sections: [] },
      },
      invoke,
    );

    expect(invoke).toHaveBeenCalledWith('create_word', {
      title: 'Strategy',
      sections: [],
      clientId: '11111111-1111-4111-8111-111111111111',
      conversationId: 'conversation-1',
    });
    expect(result).toEqual({
      name: 'create_word',
      input: {
        title: 'Strategy',
        sections: [],
        clientId: '11111111-1111-4111-8111-111111111111',
        conversationId: 'conversation-1',
      },
    });
  });

  test('artifact wrapper blocks a nested client override before delegation', async () => {
    const tools = new MeriV3SemanticCompatibilityTools(
      config({
        MERI_ARTIFACT_TOOL_V2_ENABLED: 'true',
        MERI_ARTIFACT_TOOL_V2_TENANTS: '*',
      }),
    );
    const invoke = jest.fn();

    const result = await tools.execute(
      'create_artifact',
      {
        type: 'word',
        clientId: '11111111-1111-4111-8111-111111111111',
        spec: {
          clientId: '22222222-2222-4222-8222-222222222222',
          title: 'Wrong client',
          sections: [],
        },
      },
      invoke,
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        blocked: true,
        error: expect.stringContaining('pinned to this conversation'),
      }),
    );
  });

  test('policy memo requires a client while meeting brief only inherits the conversation', async () => {
    const tools = new MeriV3SemanticCompatibilityTools(
      config({
        MERI_ARTIFACT_TOOL_V2_ENABLED: 'true',
        MERI_ARTIFACT_TOOL_V2_TENANTS: '*',
      }),
    );
    const invoke = jest.fn(async (name: string, input: Record<string, unknown>) => ({
      name,
      input,
    }));

    const missingClient = await tools.execute(
      'create_artifact',
      {
        type: 'policy_memo',
        spec: { title: 'Memo', body: 'Body' },
      },
      invoke,
    );
    expect(missingClient).toEqual({ error: 'policy_memo requires an authorized clientId.' });
    expect(invoke).not.toHaveBeenCalled();

    const meetingBrief = await tools.execute(
      'create_artifact',
      {
        type: 'meeting_brief',
        clientId: '11111111-1111-4111-8111-111111111111',
        conversationId: 'conversation-1',
        spec: { meetingId: 'meeting-1' },
      },
      invoke,
    );
    expect(invoke).toHaveBeenCalledWith('create_meeting_brief', {
      meetingId: 'meeting-1',
      conversationId: 'conversation-1',
    });
    expect(meetingBrief).toEqual({
      name: 'create_meeting_brief',
      input: { meetingId: 'meeting-1', conversationId: 'conversation-1' },
    });
  });

  test('wrapper flags cannot widen beyond their tenant allowlists', () => {
    const tools = new MeriV3SemanticCompatibilityTools(
      config({
        MERI_FUNDING_SEMANTIC_TOOLS_ENABLED: 'true',
        MERI_FUNDING_SEMANTIC_TOOLS_TENANTS: 'tenant-2',
        MERI_ARTIFACT_TOOL_V2_ENABLED: 'true',
        MERI_ARTIFACT_TOOL_V2_TENANTS: 'tenant-2',
      }),
    );

    expect(tools.isEnabledTool('analyze_funding_opportunity', 'tenant-1')).toBe(false);
    expect(tools.isEnabledTool('create_artifact', 'tenant-1')).toBe(false);
  });
});
