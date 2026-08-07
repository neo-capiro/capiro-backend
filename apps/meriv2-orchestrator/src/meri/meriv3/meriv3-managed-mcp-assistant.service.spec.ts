import { MeriV3AssistantService } from './meriv3-assistant.service.js';
import { MeriV3ManagedMcpAssistantService } from './meriv3-managed-mcp-assistant.service.js';

const HUBSPOT_SEARCH = 'mcp__meriv3_hubspot__search_contacts';

function make(managedOverrides: Record<string, unknown> = {}) {
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
  const service = new MeriV3ManagedMcpAssistantService(
    registryService as never,
    openai as never,
    actionProposals as never,
    prisma as never,
    config as never,
    managed as never,
  );
  return { service, managed };
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
    const { service } = make({ executeRead });
    const events: Array<Record<string, unknown>> = [];
    const steps: Array<Record<string, unknown>> = [];
    const internals = service as unknown as {
      invokeTool: (args: Record<string, unknown>) => Promise<unknown>;
    };
    await expect(
      internals.invokeTool({
        ctx: {},
        name: HUBSPOT_SEARCH,
        input: { query: 'Jane' },
        steps,
        pendingApprovals: [],
        artifacts: [],
        emit: (event: Record<string, unknown>) => events.push(event),
        prePersistRefusal: () => null,
        noteComplianceOutcome: () => undefined,
      }),
    ).resolves.toEqual({ contacts: [{ name: 'Jane' }] });
    expect(executeRead).toHaveBeenCalledWith(HUBSPOT_SEARCH, { query: 'Jane' });
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
});
