import { MeriV3AssistantService } from './meriv3-assistant.service.js';
import { MeriV3ManagedMcpAssistantService } from './meriv3-managed-mcp-assistant.service.js';

function make(execute = jest.fn(async () => ({ artifacts: [] }))) {
  const service = new MeriV3ManagedMcpAssistantService(
    { registry: { list: () => [], get: () => undefined } } as never,
    {} as never,
    {} as never,
    {} as never,
    { get: jest.fn(() => 'http://api.test') } as never,
    { schemas: jest.fn(async () => []), executeRead: jest.fn() } as never,
    { available: jest.fn(async () => true), execute } as never,
  );
  return { service, execute };
}

describe('MeriV3 visual work presentation', () => {
  afterEach(() => jest.restoreAllMocks());

  test.each([
    ['Compare request, HASC and HAC-D stage movement', 'Analyzing funding movement'],
    ['Rank the ten largest verified cuts', 'Ranking results'],
    ['Build a heatmap of portfolio exposure', 'Mapping exposure'],
    ['Calculate correlation between awards and funding growth', 'Calculating relationship'],
    ['Build a timeline of hearings and deadlines', 'Building decision timeline'],
    ['Show the FY24-FY31 trajectory over time', 'Analyzing trend'],
  ])('shows a human work label for %s', async (purpose, expected) => {
    jest
      .spyOn(
        MeriV3AssistantService.prototype as unknown as {
          invokeTool: (...args: unknown[]) => Promise<unknown>;
        },
        'invokeTool',
      )
      .mockResolvedValue({ native: true });
    const { service } = make();
    const events: Array<Record<string, unknown>> = [];
    const internals = service as unknown as {
      invokeTool: (args: Record<string, unknown>) => Promise<unknown>;
    };

    await internals.invokeTool({
      ctx: {},
      name: 'run_analysis',
      input: { code: 'print(1)', purpose },
      conversationId: 'conversation-1',
      steps: [],
      pendingApprovals: [],
      artifacts: [],
      emit: (event: Record<string, unknown>) => events.push(event),
      prePersistRefusal: () => null,
      noteComplianceOutcome: () => undefined,
    });

    expect(events[0]).toEqual({ type: 'tool_call', tool: expected, label: expected });
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: 'tool_done',
        tool: expected,
        label: expected,
        status: 'done',
      }),
    );
    expect(JSON.stringify(events)).not.toContain('run_analysis');
  });

  test('the model contract requires claim titles and source citations rather than decorative charts', async () => {
    jest
      .spyOn(
        MeriV3AssistantService.prototype as unknown as {
          fetchToolSchemas: () => Promise<unknown[]>;
        },
        'fetchToolSchemas',
      )
      .mockResolvedValue([
        { name: 'run_analysis', description: 'Execute Python.', input_schema: { type: 'object' } },
      ]);
    const { service } = make();
    const internals = service as unknown as {
      fetchToolSchemas: () => Promise<Array<{ name: string; description: string }>>;
    };
    const schema = (await internals.fetchToolSchemas()).find(
      (item) => item.name === 'run_analysis',
    );
    expect(schema?.description).toContain('title states the claim');
    expect(schema?.description).toContain('Never use a generic title');
    expect(schema?.description).toContain('original Capiro or connected-app retrieval sources');
    expect(schema?.description).toContain('DERIVED analysis');
  });
});
