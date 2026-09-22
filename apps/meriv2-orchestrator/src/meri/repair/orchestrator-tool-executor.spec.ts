import { createOrchestratorToolExecutor, projectRemedyArgs } from './orchestrator-tool-executor';

const schema = {
  name: 'get_bill_status',
  input_schema: { properties: { billId: {}, clientId: {} }, required: ['billId'] },
};

function registry(readOnly = true, metadata = true) {
  return {
    get: jest.fn(() => ({ readOnly })),
    executionMetadata: jest.fn(() => metadata ? { executionMode: 'read' } : undefined),
  } as never;
}

describe('orchestrator repair tool executor', () => {
  it('projects governed identities and refuses unfillable required fields', () => {
    expect(projectRemedyArgs(
      { name: schema.name, args: { claimIds: ['c'] } }, schema,
      { tenantId: 'tenant', identities: { billId: '119-hr-1' } },
    )).toEqual({ billId: '119-hr-1' });
    expect(projectRemedyArgs(
      { name: schema.name, args: { claimIds: ['c'] } }, schema,
      { tenantId: 'tenant' },
    )).toBeNull();
  });

  it.each([
    ['unknown', undefined, true],
    ['write', false, true],
    ['missing metadata', true, false],
  ])('refuses %s tools', async (_label: string, readOnly: boolean | undefined, metadata: boolean) => {
    const invoke = jest.fn();
    const executor = createOrchestratorToolExecutor({
      registry: readOnly === undefined ? { get: () => undefined, executionMetadata: () => undefined } as never : registry(readOnly, metadata),
      schemas: [schema], context: { tenantId: 'tenant', identities: { billId: '119-hr-1' } },
      citations: [], invoke,
    });
    expect(await executor.execute({ name: schema.name, args: {} }, {})).toMatchObject({ ok: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('registers projected evidence with a stable citation marker', async () => {
    const citations: import('@capiro/shared').MeriCitation[] = [];
    const executor = createOrchestratorToolExecutor({
      registry: registry(), schemas: [schema],
      context: { tenantId: 'tenant', identities: { billId: '119-hr-1' } },
      citations,
      invoke: async () => ({ data: [{ id: '119-hr-1', title: 'H.R. 1', url: 'https://example.test/hr1', snippet: 'Status: Enacted' }] }),
    });
    const result = await executor.execute({ name: schema.name, args: {} }, {});
    if (!result.ok) throw new Error(result.reason);
    expect(result).toMatchObject({ ok: true, evidence: [expect.objectContaining({ locator: '[1]' })] });
    expect(citations).toHaveLength(1);
  });
});
