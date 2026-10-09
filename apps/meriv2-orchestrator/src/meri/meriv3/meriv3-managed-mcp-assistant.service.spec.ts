import { MeriV3AssistantService } from './meriv3-assistant.service.js';
import { MeriV3ManagedMcpAssistantService } from './meriv3-managed-mcp-assistant.service.js';
import { runWithGovernedMeriContext } from '../meri-governed-context.runtime.js';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';

const HUBSPOT_SEARCH = 'mcp__meriv3_hubspot__search_contacts';

/** A current real API managed-catalog read schema (validated authority fields). */
const HUBSPOT_READ_SCHEMA = {
  name: HUBSPOT_SEARCH,
  description: 'Search HubSpot contacts',
  input_schema: { type: 'object', properties: { query: { type: 'string' } } },
  source: 'managed_mcp',
  appId: 'hubspot',
  appName: 'HubSpot',
  readOnly: true,
} as const;

function make(
  managedOverrides: Record<string, unknown> = {},
  visualOverrides: Record<string, unknown> = {},
) {
  const registryService = { registry: { list: () => [], get: () => undefined } };
  const openai = {};
  const actionProposals = {};
  const prisma = {};
  const config = { get: jest.fn(() => 'http://api.test') };
  const managed = {
    schemas: jest.fn(async () => []),
    executeRead: jest.fn(async () => ({ rows: [] })),
    ...managedOverrides,
  };
  const visual = {
    available: jest.fn(async () => true),
    execute: jest.fn(async () => ({ artifacts: [] })),
    ...visualOverrides,
  };
  const service = new MeriV3ManagedMcpAssistantService(
    registryService as never,
    openai as never,
    actionProposals as never,
    prisma as never,
    config as never,
    managed as never,
    visual as never,
  );
  return { service, managed, visual };
}

describe('MeriV3ManagedMcpAssistantService', () => {
  afterEach(() => jest.restoreAllMocks());

  test('appends only current-user managed schemas and marks them optional/relevance-driven', async () => {
    jest
      .spyOn(
        MeriV3AssistantService.prototype as unknown as {
          fetchToolSchemas: () => Promise<unknown[]>;
        },
        'fetchToolSchemas',
      )
      .mockResolvedValue([
        { name: 'search_memory', description: 'Search memory', input_schema: { type: 'object' } },
      ]);
    const external = {
      name: HUBSPOT_SEARCH,
      description: 'Search HubSpot contacts',
      input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      source: 'managed_mcp',
      appId: 'hubspot',
      appName: 'HubSpot',
      readOnly: true,
    };
    const { service, managed } = make({ schemas: jest.fn(async () => [external]) });
    const internals = service as unknown as { fetchToolSchemas: () => Promise<unknown[]> };
    const schemas = (await internals.fetchToolSchemas()) as Array<{
      name: string;
      description: string;
      input_schema: Record<string, unknown>;
    }>;
    expect(schemas[0]).toEqual({
      name: 'search_memory',
      description: 'Search memory',
      input_schema: { type: 'object' },
    });
    expect(schemas[1]).toMatchObject({
      name: external.name,
      input_schema: external.input_schema,
    });
    expect(schemas[1]?.description).toContain(
      '[Connected app: HubSpot; optional external evidence source.]',
    );
    expect(schemas[1]?.description).toContain('only when its data is materially relevant');
    expect(managed.schemas).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['hubspot', 'meriv3_hubspot', 'HubSpot', 'search_crm_objects'],
    ['airtable', 'meriv3_airtable', 'Airtable', 'list_bases'],
    ['monday', 'meriv3_monday', 'monday.com', 'get_board_info'],
    ['google-drive', 'meriv3_google_drive', 'Google Drive', 'read_file_content'],
  ])(
    '%s schemas reach the model and route through the managed read bridge',
    async (appId, server, appName, tool) => {
      const nativeFetch = jest
        .spyOn(MeriV3AssistantService.prototype as never, 'fetchToolSchemas' as never)
        .mockResolvedValue([] as never);
      const nativeInvoke = jest
        .spyOn(MeriV3AssistantService.prototype as never, 'invokeTool' as never)
        .mockResolvedValue({ native: true } as never);
      const nativeAugment = jest
        .spyOn(MeriV3AssistantService.prototype as never, 'augmentToolInput' as never)
        .mockReturnValue({ input: { clientId: 'rewritten' } } as never);
      const name = `mcp__${server}__${tool}`;
      const external = {
        name,
        appId,
        appName,
        readOnly: true,
        source: 'managed_mcp',
        description: 'Read fixture',
        input_schema: { type: 'object' },
      };
      const { service, managed } = make({
        schemas: jest.fn(async () => [
          external,
          { ...external, name: 'mcp__unreviewed__read_file' },
        ]),
      });
      const internals = service as unknown as {
        fetchToolSchemas: () => Promise<Array<{ name: string; description: string }>>;
        augmentToolInput: (dto: unknown, input: unknown, schema: unknown) => unknown;
        invokeTool: (args: Record<string, unknown>) => Promise<unknown>;
      };
      const schemas = await internals.fetchToolSchemas();
      expect(schemas.map((s) => s.name)).toEqual([name]);
      expect(schemas[0]?.description).toContain(`[Connected app: ${appName};`);
      const input = { fileId: 'fixture-file', clientId: 'provider-client' };
      expect(internals.augmentToolInput({ clientId: 'capiro-client' }, input, external)).toEqual({
        input,
      });
      expect(nativeAugment).not.toHaveBeenCalled();
      const events: Array<Record<string, unknown>> = [];
      await internals.invokeTool({
        ctx: {},
        dto: {},
        name,
        input,
        schema: external,
        steps: [],
        pendingApprovals: [],
        artifacts: [],
        emit: (event: Record<string, unknown>) => events.push(event),
        prePersistRefusal: () => null,
        noteComplianceOutcome: () => undefined,
      });
      expect(managed.executeRead).toHaveBeenCalledWith(name, input, undefined);
      expect(nativeInvoke).not.toHaveBeenCalled();
      expect(nativeFetch).toHaveBeenCalledTimes(1);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool_done',
            status: 'done',
            label: expect.stringContaining(`${appName}:`),
          }),
        ]),
      );
    },
  );

  test('adds visual-output rules only to an available native run_analysis schema', async () => {
    jest
      .spyOn(
        MeriV3AssistantService.prototype as unknown as {
          fetchToolSchemas: () => Promise<unknown[]>;
        },
        'fetchToolSchemas',
      )
      .mockResolvedValue([
        {
          name: 'run_analysis',
          description: 'Execute Python.',
          input_schema: { type: 'object' },
        },
        { name: 'search_memory', description: 'Search memory.', input_schema: { type: 'object' } },
      ]);
    const { service, visual } = make();
    const internals = service as unknown as { fetchToolSchemas: () => Promise<unknown[]> };
    const schemas = (await internals.fetchToolSchemas()) as Array<{
      name: string;
      description: string;
    }>;
    expect(schemas.find((schema) => schema.name === 'run_analysis')?.description).toContain(
      'results.visuals',
    );
    expect(schemas.find((schema) => schema.name === 'run_analysis')?.description).toContain(
      'Do not make decorative charts',
    );
    expect(schemas.find((schema) => schema.name === 'search_memory')?.description).toBe(
      'Search memory.',
    );
    expect(visual.available).toHaveBeenCalledTimes(1);
  });

  test('removes run_analysis entirely when apps/api reports the tenant sandbox unavailable', async () => {
    jest
      .spyOn(
        MeriV3AssistantService.prototype as unknown as {
          fetchToolSchemas: () => Promise<unknown[]>;
        },
        'fetchToolSchemas',
      )
      .mockResolvedValue([
        {
          name: 'run_analysis',
          description: 'Execute Python.',
          input_schema: { type: 'object' },
        },
        { name: 'search_memory', description: 'Search memory.', input_schema: { type: 'object' } },
      ]);
    const { service } = make({}, { available: jest.fn(async () => false) });
    const internals = service as unknown as { fetchToolSchemas: () => Promise<unknown[]> };
    const schemas = (await internals.fetchToolSchemas()) as Array<{ name: string }>;
    expect(schemas.map((schema) => schema.name)).toEqual(['search_memory']);
  });

  test('does not rewrite an external provider clientId with the Capiro conversation client', () => {
    jest
      .spyOn(
        MeriV3AssistantService.prototype as unknown as {
          augmentToolInput: (...args: unknown[]) => unknown;
        },
        'augmentToolInput',
      )
      .mockReturnValue({ input: { native: true } });
    const { service } = make();
    const internals = service as unknown as {
      augmentToolInput: (
        dto: { clientId?: string },
        input: Record<string, unknown>,
        schema: { name: string; input_schema: Record<string, unknown> },
      ) => { input: Record<string, unknown> };
    };
    expect(
      internals.augmentToolInput(
        { clientId: 'capiro-client-uuid' },
        { clientId: 'hubspot-object-client-id' },
        {
          name: HUBSPOT_SEARCH,
          input_schema: { type: 'object', properties: { clientId: { type: 'string' } } },
        },
      ),
    ).toEqual({ input: { clientId: 'hubspot-object-client-id' } });
  });

  test('warns that monday reads require an explicit board association', async () => {
    jest
      .spyOn(MeriV3AssistantService.prototype as never, 'fetchToolSchemas' as never)
      .mockResolvedValue([] as never);
    const schema = {
      name: 'mcp__meriv3_monday__get_board_items_page',
      appId: 'monday',
      appName: 'monday.com',
      readOnly: true,
      source: 'managed_mcp',
      description: 'Read board items',
      input_schema: { type: 'object' },
    };
    const { service } = make({ schemas: jest.fn(async () => [schema]) });
    const internals = service as unknown as {
      fetchToolSchemas: () => Promise<Array<{ description: string }>>;
    };

    const [exposed] = await internals.fetchToolSchemas();
    expect(exposed?.description).toContain('explicit server-authorized client-board mapping');
    expect(exposed?.description).toContain('report monday.com as unmapped');
  });

  test('routes managed reads through the API bridge but shows only the app name to users', async () => {
    const nativeInvoke = jest
      .spyOn(
        MeriV3AssistantService.prototype as unknown as {
          invokeTool: (...args: unknown[]) => Promise<unknown>;
        },
        'invokeTool',
      )
      .mockResolvedValue({ native: true });
    const executeRead = jest.fn(async () => ({ contacts: [{ name: 'Jane' }] }));
    const hubspotSchema = {
      name: HUBSPOT_SEARCH,
      description: 'Search HubSpot contacts',
      input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      source: 'managed_mcp',
      appId: 'hubspot',
      appName: 'HubSpot',
      readOnly: true,
    };
    const { service } = make({
      executeRead,
      schemas: jest.fn(async () => [hubspotSchema]),
    });
    const events: Array<Record<string, unknown>> = [];
    const steps: Array<Record<string, unknown>> = [];
    const internals = service as unknown as {
      invokeTool: (args: Record<string, unknown>) => Promise<unknown>;
    };
    await expect(
      internals.invokeTool({
        ctx: {},
        dto: {},
        name: HUBSPOT_SEARCH,
        input: { query: 'Jane' },
        schema: hubspotSchema,
        steps,
        pendingApprovals: [],
        artifacts: [],
        emit: (event: Record<string, unknown>) => events.push(event),
        prePersistRefusal: () => null,
        noteComplianceOutcome: () => undefined,
      }),
    ).resolves.toEqual({ contacts: [{ name: 'Jane' }] });
    expect(executeRead).toHaveBeenCalledWith(HUBSPOT_SEARCH, { query: 'Jane' }, undefined);
    expect(nativeInvoke).not.toHaveBeenCalled();
    expect(steps).toEqual([
      expect.objectContaining({
        tool: HUBSPOT_SEARCH,
        status: 'done',
        label: 'HubSpot: Search Contacts',
      }),
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool_call', label: 'HubSpot: Search Contacts' }),
        expect.objectContaining({
          type: 'tool_done',
          status: 'done',
          label: 'HubSpot: Search Contacts',
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain('meriv3_hubspot');
  });

  test('routes run_analysis through the persistence bridge and emits stable chart artifacts', async () => {
    const nativeInvoke = jest
      .spyOn(
        MeriV3AssistantService.prototype as unknown as {
          invokeTool: (...args: unknown[]) => Promise<unknown>;
        },
        'invokeTool',
      )
      .mockResolvedValue({ native: true });
    const execute = jest.fn(async () => ({
      findings: { delta: -22.7 },
      artifacts: [
        {
          id: 'chart-1',
          title: 'FY27 movement',
          kind: 'analysis_chart',
          persisted: true,
        },
      ],
    }));
    const { service } = make({}, { execute });
    const events: Array<Record<string, unknown>> = [];
    const steps: Array<Record<string, unknown>> = [];
    const artifacts: Array<Record<string, unknown>> = [];
    const internals = service as unknown as {
      invokeTool: (args: Record<string, unknown>) => Promise<unknown>;
    };
    await internals.invokeTool({
      ctx: {},
      name: 'run_analysis',
      input: { code: 'print(1)', purpose: 'Show funding movement' },
      conversationId: 'conversation-1',
      steps,
      pendingApprovals: [],
      artifacts,
      emit: (event: Record<string, unknown>) => events.push(event),
      prePersistRefusal: () => null,
      noteComplianceOutcome: () => undefined,
    });

    expect(execute).toHaveBeenCalledWith(
      {
        code: 'print(1)',
        purpose: 'Show funding movement',
        conversationId: 'conversation-1',
      },
      undefined,
    );
    expect(nativeInvoke).not.toHaveBeenCalled();
    expect(artifacts).toEqual([{ id: 'chart-1', title: 'FY27 movement', kind: 'analysis_chart' }]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'artifact',
          artifact: expect.objectContaining({ id: 'chart-1' }),
        }),
        expect.objectContaining({ type: 'tool_done', status: 'done' }),
      ]),
    );
  });

  test('adds bounded per-turn visual steering without forcing charts on writing-only prompts', async () => {
    const run = jest.spyOn(MeriV3AssistantService.prototype, 'run').mockResolvedValue({
      reply: 'ok',
      runtime: 'meriv3',
      model: 'test',
      reasoningMode: 'standard',
      reasoningEffort: 'medium',
    });
    const { service } = make();

    await service.run({} as never, {
      messages: [{ role: 'user', text: 'Chart FY24 through FY27 funding.' }],
      skillAddendum: 'Firm style.',
    });
    expect(run).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({
        skillAddendum: expect.stringContaining('The user explicitly requested a visual'),
      }),
      expect.objectContaining({ onEvent: expect.any(Function) }),
    );
    const explicitCall = run.mock.calls[run.mock.calls.length - 1];
    expect((explicitCall?.[1] as { skillAddendum: string }).skillAddendum).toContain('Firm style.');

    await service.run({} as never, {
      messages: [{ role: 'user', text: 'Rewrite this sentence more professionally.' }],
    });
    const writingCall = run.mock.calls[run.mock.calls.length - 1];
    expect((writingCall?.[1] as { skillAddendum: string }).skillAddendum).toContain(
      'Do not call run_analysis merely to decorate',
    );
  });

  test('ordinary Capiro and non-managed MCP tools stay on the original V3 path', async () => {
    const nativeInvoke = jest
      .spyOn(
        MeriV3AssistantService.prototype as unknown as {
          invokeTool: (...args: unknown[]) => Promise<unknown>;
        },
        'invokeTool',
      )
      .mockResolvedValue({ native: true });
    const { service, managed } = make();
    const internals = service as unknown as {
      invokeTool: (value: Record<string, unknown>) => Promise<unknown>;
    };

    for (const name of ['search_memory', 'mcp__legacy_hubspot__search_contacts']) {
      const args = {
        ctx: {},
        name,
        input: { query: 'client priorities' },
        steps: [],
        pendingApprovals: [],
        artifacts: [],
        emit: () => undefined,
        prePersistRefusal: () => null,
        noteComplianceOutcome: () => undefined,
      };
      await expect(internals.invokeTool(args)).resolves.toEqual({ native: true });
      expect(nativeInvoke).toHaveBeenCalledWith(args);
    }
    expect(managed.executeRead).not.toHaveBeenCalled();
  });

  test('refuses a managed read at final dispatch when a research plan does not admit it, before catalog fetch or owner I/O', async () => {
    const executeRead = jest.fn(async () => ({ contacts: [] }));
    const schemas = jest.fn(async () => [HUBSPOT_READ_SCHEMA]);
    const { service } = make({ executeRead, schemas });
    const internals = service as unknown as {
      invokeTool: (args: Record<string, unknown>) => Promise<unknown>;
    };

    const result = await internals.invokeTool({
      ctx: {},
      dto: {},
      name: HUBSPOT_SEARCH,
      input: { query: 'Jane' },
      schema: HUBSPOT_READ_SCHEMA,
      // The admitted research read set does not include this managed tool: the
      // final assertMeriV3ResearchCapability guard must refuse it.
      admittedReadCapabilities: new Set(['search_memory']),
      steps: [],
      pendingApprovals: [],
      artifacts: [],
      emit: () => undefined,
      prePersistRefusal: () => null,
      noteComplianceOutcome: () => undefined,
    });

    expect(executeRead).not.toHaveBeenCalled();
    // The guard runs BEFORE the current-catalog fetch and owner I/O.
    expect(schemas).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      connectedApp: true,
      error: expect.stringContaining('meri_research_plan_execution_envelope_invalid'),
    });
  });

  test('refuses a managed read under a governed procedure before catalog fetch or owner I/O', async () => {
    const executeRead = jest.fn(async () => ({ contacts: [] }));
    const schemas = jest.fn(async () => [HUBSPOT_READ_SCHEMA]);
    const { service } = make({ executeRead, schemas });
    const internals = service as unknown as {
      invokeTool: (args: Record<string, unknown>) => Promise<unknown>;
    };

    // A governed procedure binding that does not allow the managed tool: the
    // final dispatch must refuse before any catalog fetch or owner I/O.
    const governed = {
      version: 1,
      operationId: 'meri.chat',
      prompt: '',
      contextPacket: { clientId: null },
      retrieval: { plan: { subjectScope: 'general' } },
      procedure: {
        version: 1,
        validUntil: Date.now() + 60_000,
        policy: { effectMode: 'read_only', allowedTools: ['search_memory'] },
      },
    } as unknown as MeriGovernedTurnContext;

    const result = await runWithGovernedMeriContext(governed, () =>
      internals.invokeTool({
        ctx: {},
        dto: {},
        name: HUBSPOT_SEARCH,
        input: { query: 'Jane' },
        schema: HUBSPOT_READ_SCHEMA,
        admittedReadCapabilities: null,
        steps: [],
        pendingApprovals: [],
        artifacts: [],
        emit: () => undefined,
        prePersistRefusal: () => null,
        noteComplianceOutcome: () => undefined,
      }),
    );

    expect(executeRead).not.toHaveBeenCalled();
    expect(schemas).not.toHaveBeenCalled();
    expect(result).toMatchObject({ connectedApp: true });
  });
});
