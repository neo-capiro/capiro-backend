import {
  MERI_SEMANTIC_COMPATIBILITY_CONTRACTS,
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
        schema('search_funding_opportunities'),
        schema('get_funding_opportunity_requirements'),
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
    expect(names).toContain('search_funding_opportunities');
    expect(names).toContain('get_funding_opportunity_requirements');
    // The wrapper requires a selected opportunity; keep client-only context
    // callable for requests that do not name one.
    expect(names).toContain('get_opportunity_client_context');
    expect(names).toContain('analyze_funding_opportunity');
    expect(names).toContain('compare_funding_opportunities');
    expect(names).toContain('build_opportunity_action_plan');
    expect(names).not.toContain('explain_opportunity_match');
    expect(names).not.toContain('get_opportunity_government_landscape');
  });

  test('funding contract matches its per-source evidence dependencies and preserves separate operations', () => {
    const contract = MERI_SEMANTIC_COMPATIBILITY_CONTRACTS.analyze_funding_opportunity;
    expect(contract).toMatchObject({
      contractRole: 'advisory_only',
      requiredInputs: ['clientId', 'source', 'sourceRecordId'],
      effectClass: 'read_only_evidence',
      availability: {
        featureFlag: 'MERI_FUNDING_SEMANTIC_TOOLS_ENABLED',
        tenantAllowlistFlag: 'MERI_FUNDING_SEMANTIC_TOOLS_TENANTS',
        tenantAllowlistFallbackFlag: 'MERI_SEMANTIC_TOOL_GATEWAY_TENANTS',
        defaultOff: true,
      },
    });
    expect(contract.dependencies).toEqual([
      'get_funding_opportunity',
      'get_opportunity_client_context',
      'explain_opportunity_match',
      'get_opportunity_government_landscape',
      'get_funding_opportunity_requirements for SAM.gov only',
    ]);
    expect(contract.exclusions.join(' ')).toMatch(/Comparing multiple opportunities/);
    expect(contract.exclusions.join(' ')).toMatch(/Building an opportunity action plan/);
    expect(contract.evidenceAuthority.join(' ')).toMatch(
      /Grants.gov receives a notice-body continuation instruction/,
    );
  });

  test('advisory metadata matches the model-facing inputs and artifact type choices', () => {
    const tools = new MeriV3SemanticCompatibilityTools(
      config({
        MERI_FUNDING_SEMANTIC_TOOLS_ENABLED: 'true',
        MERI_FUNDING_SEMANTIC_TOOLS_TENANTS: '*',
        MERI_ARTIFACT_TOOL_V2_ENABLED: 'true',
        MERI_ARTIFACT_TOOL_V2_TENANTS: '*',
      }),
    );
    const schemas = Object.fromEntries(
      tools.prepareSchemas([], 'tenant-1').map((item) => [item.name, item]),
    );
    const fundingSchema = schemas.analyze_funding_opportunity!.input_schema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    const artifactSchema = schemas.create_artifact!.input_schema as {
      required: string[];
      properties: Record<string, { enum?: string[]; additionalProperties?: boolean }>;
    };

    expect(fundingSchema.required).toEqual(
      MERI_SEMANTIC_COMPATIBILITY_CONTRACTS.analyze_funding_opportunity.requiredInputs,
    );
    expect(fundingSchema.properties.source).toMatchObject({
      enum: ['grants_gov', 'sam_gov'],
    });
    expect(artifactSchema.required).toEqual(
      MERI_SEMANTIC_COMPATIBILITY_CONTRACTS.create_artifact.requiredInputs,
    );
    expect(artifactSchema.properties.type?.enum).toEqual(
      MERI_SEMANTIC_COMPATIBILITY_CONTRACTS.create_artifact.typeMappings?.map(({ type }) => type),
    );
    expect(artifactSchema.properties.spec?.additionalProperties).toBe(true);
  });

  test('funding wrapper returns evidence from existing governed reads', async () => {
    const tools = new MeriV3SemanticCompatibilityTools(
      config({
        MERI_FUNDING_SEMANTIC_TOOLS_ENABLED: 'true',
        MERI_FUNDING_SEMANTIC_TOOLS_TENANTS: '*',
      }),
    );
    const invoke = jest.fn(async (name: string, input: Record<string, unknown>) => ({
      tool: name,
      input,
      state: 'available',
    }));

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
      'get_funding_opportunity_requirements',
    ]);
    const packet = result as {
      kind: string;
      analysisOwner: string;
      matchEvidence: unknown;
      governmentLandscape: unknown;
      requirements: unknown;
      coverage: { toolsInvoked: string[] };
    };
    const opportunityInput = {
      clientId: '11111111-1111-4111-8111-111111111111',
      source: 'sam_gov',
      sourceRecordId: 'notice-1',
    };
    expect(packet).toMatchObject({
      kind: 'funding_opportunity_evidence',
      analysisOwner: 'openai',
    });
    expect(packet.matchEvidence).toEqual({
      tool: 'explain_opportunity_match',
      input: opportunityInput,
      state: 'available',
    });
    expect(packet.governmentLandscape).toEqual({
      tool: 'get_opportunity_government_landscape',
      input: opportunityInput,
      state: 'available',
    });
    expect(packet.requirements).toEqual({
      tool: 'get_funding_opportunity_requirements',
      input: opportunityInput,
      state: 'available',
    });
    expect(packet.coverage.toolsInvoked).toEqual(invoke.mock.calls.map((call) => call[0]));
  });

  test('Grants.gov packet keeps notice-body guidance distinct from extracted requirements', async () => {
    const tools = new MeriV3SemanticCompatibilityTools(
      config({
        MERI_FUNDING_SEMANTIC_TOOLS_ENABLED: 'true',
        MERI_FUNDING_SEMANTIC_TOOLS_TENANTS: '*',
      }),
    );
    const invoke = jest.fn(async (name: string, input: Record<string, unknown>) => ({
      tool: name,
      input,
      state: name === 'get_opportunity_government_landscape' ? 'unsupported_source' : 'available',
    }));
    const result = (await tools.execute(
      'analyze_funding_opportunity',
      {
        clientId: '11111111-1111-4111-8111-111111111111',
        source: 'grants_gov',
        sourceRecordId: 'NOFO-1',
      },
      invoke,
    )) as {
      requirements: { state: string; explanation: string };
      coverage: { requestedDomains: string[]; toolsInvoked: string[] };
      opportunity: { tool: string; input: Record<string, unknown> };
      clientEvidence: { tool: string; input: Record<string, unknown> };
      matchEvidence: { tool: string; input: Record<string, unknown> };
      governmentLandscape: { tool: string; input: Record<string, unknown>; state: string };
    };

    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      'get_funding_opportunity',
      'get_opportunity_client_context',
      'explain_opportunity_match',
      'get_opportunity_government_landscape',
    ]);
    expect(result.requirements).toMatchObject({ state: 'notice_body' });
    expect(result.requirements.explanation).toMatch(/summaryRead\.nextOffset/);
    expect(result.coverage.requestedDomains).toContain('mandatory_conditions');
    expect(result.coverage.toolsInvoked).not.toContain('get_funding_opportunity_requirements');
    expect(result.governmentLandscape.tool).toBe('get_opportunity_government_landscape');
    expect(result.governmentLandscape.state).toBe('unsupported_source');
    expect(result.opportunity.input).toEqual({
      clientId: '11111111-1111-4111-8111-111111111111',
      source: 'grants_gov',
      sourceRecordId: 'NOFO-1',
    });
    expect(result.clientEvidence).toEqual({
      tool: 'get_opportunity_client_context',
      input: { clientId: '11111111-1111-4111-8111-111111111111' },
      state: 'available',
    });
    expect(result.matchEvidence).toEqual({
      tool: 'explain_opportunity_match',
      input: {
        clientId: '11111111-1111-4111-8111-111111111111',
        source: 'grants_gov',
        sourceRecordId: 'NOFO-1',
      },
      state: 'available',
    });
  });

  test('artifact contract enumerates distinct backing writers, inputs, and result families', () => {
    const contract = MERI_SEMANTIC_COMPATIBILITY_CONTRACTS.create_artifact;
    expect(contract).toMatchObject({
      contractRole: 'advisory_only',
      requiredInputs: ['type', 'spec'],
      effectClass: 'artifact_write',
      availability: {
        featureFlag: 'MERI_ARTIFACT_TOOL_V2_ENABLED',
        tenantAllowlistFlag: 'MERI_ARTIFACT_TOOL_V2_TENANTS',
        tenantAllowlistFallbackFlag: 'MERI_SEMANTIC_TOOL_GATEWAY_TENANTS',
        defaultOff: true,
      },
    });
    expect(contract.typeMappings).toEqual([
      {
        type: 'word',
        handler: 'create_word',
        requiredBackingInputs: ['title', 'sections'],
        result: 'word_document; this artifact can be downloaded as DOCX or PDF',
      },
      {
        type: 'pdf',
        handler: 'create_word',
        requiredBackingInputs: ['title', 'sections'],
        result: 'pdf_document; this artifact can be downloaded as PDF or DOCX',
      },
      {
        type: 'spreadsheet',
        handler: 'create_excel',
        requiredBackingInputs: ['title', 'sheets'],
        result: 'excel_workbook',
      },
      {
        type: 'presentation',
        handler: 'create_powerpoint',
        requiredBackingInputs: ['title', 'slides'],
        result: 'powerpoint_deck',
      },
      {
        type: 'meeting_brief',
        handler: 'create_meeting_brief',
        requiredBackingInputs: ['meetingId'],
        result: 'meeting_brief artifact or preparation job',
      },
      {
        type: 'policy_memo',
        handler: 'draft_policy_memo',
        requiredBackingInputs: ['clientId'],
        result: 'policy_memo artifact and body text',
      },
    ]);
  });

  test.each([
    ['word', 'create_word', { title: 'Brief', sections: [] }, { title: 'Brief', sections: [] }],
    [
      'pdf',
      'create_word',
      { title: 'Brief', sections: [] },
      { title: 'Brief', sections: [], format: 'pdf' },
    ],
    [
      'spreadsheet',
      'create_excel',
      { title: 'Workbook', sheets: [] },
      { title: 'Workbook', sheets: [] },
    ],
    [
      'presentation',
      'create_powerpoint',
      { title: 'Deck', slides: [] },
      { title: 'Deck', slides: [] },
    ],
    [
      'meeting_brief',
      'create_meeting_brief',
      { meetingId: 'meeting-1' },
      { meetingId: 'meeting-1' },
    ],
    ['policy_memo', 'draft_policy_memo', { clientId: 'client-1' }, { clientId: 'client-1' }],
  ] as const)(
    'artifact type %s delegates to its distinct backing writer',
    async (type, handler, spec, expectedInput) => {
      const tools = new MeriV3SemanticCompatibilityTools(
        config({ MERI_ARTIFACT_TOOL_V2_ENABLED: 'true', MERI_ARTIFACT_TOOL_V2_TENANTS: '*' }),
      );
      const invoke = jest.fn().mockResolvedValue({ artifactId: 'artifact-1' });
      const clientId = type === 'policy_memo' ? 'client-1' : undefined;
      await tools.execute(
        'create_artifact',
        { type, spec, ...(clientId ? { clientId } : {}) },
        invoke,
      );
      expect(invoke).toHaveBeenCalledWith(handler, expectedInput);
    },
  );

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

  test('PDF delegates to the governed Word service with the same client and conversation', async () => {
    const tools = new MeriV3SemanticCompatibilityTools(
      config({ MERI_ARTIFACT_TOOL_V2_ENABLED: 'true', MERI_ARTIFACT_TOOL_V2_TENANTS: '*' }),
    );
    const prepared = tools.prepareSchemas([schema('create_word')], 'tenant-1');
    expect(JSON.stringify(prepared)).toContain('"pdf"');
    const invoke = jest.fn().mockResolvedValue({ format: 'pdf' });
    await tools.execute(
      'create_artifact',
      {
        type: 'pdf',
        clientId: 'client-1',
        conversationId: 'conversation-1',
        spec: { title: 'Brief', sections: [], format: 'docx' },
      },
      invoke,
    );
    expect(invoke).toHaveBeenCalledWith('create_word', {
      title: 'Brief',
      sections: [],
      format: 'pdf',
      clientId: 'client-1',
      conversationId: 'conversation-1',
    });
    invoke.mockClear();
    await tools.execute(
      'create_artifact',
      {
        type: 'pdf',
        clientId: 'client-1',
        spec: { clientId: 'client-2', title: 'Wrong scope', sections: [] },
      },
      invoke,
    );
    expect(invoke).not.toHaveBeenCalled();
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
