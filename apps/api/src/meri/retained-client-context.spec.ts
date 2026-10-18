import {
  projectRetainedClientContext03,
  RETAINED_CLIENT_CONTEXT_OPERATION_03,
  type ClientContextProjection03Input,
} from './retained-client-context';

const gatewayAsOf = '2026-10-18T12:00:00.000Z';
const startedAt = '2026-10-18T12:00:01.000Z';
const sourceAt = '2026-10-18T12:00:02.000Z';
const completedAt = '2026-10-18T12:00:03.000Z';
const tenantId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';

function fixture(): ClientContextProjection03Input {
  return {
    operation: { ...RETAINED_CLIENT_CONTEXT_OPERATION_03 },
    source: {
      tool: 'get_client_context', generatedAt: sourceAt,
      profileSections: {}, coverageNote: 'Authorized coverage', profile: {}, profileSources: {},
      context: {
        client: { id: clientId, tenantId }, recentActivity: [], keyStakeholders: [],
        openThreads: [], openTasks: [], summary: {},
      },
    },
    readWindow: { startedAt, completedAt },
    gatewayAsOf,
    expectedTenantId: tenantId,
    expectedClientId: clientId,
    assertOutput03: jest.fn(),
  };
}

describe('inert retained client-context 0.3.0 projection', () => {
  it('reports Core collection time while preserving the distinct gateway observation in validation', () => {
    const input = fixture();
    const result = projectRetainedClientContext03(input);
    expect(result.generatedAt).toBe(completedAt);
    expect(result.readWindow).toEqual({ startedAt, completedAt });
    expect((input.source as { generatedAt: string }).generatedAt).toBe(sourceAt);
    expect(input.gatewayAsOf).toBe(gatewayAsOf);
    expect(input.assertOutput03).toHaveBeenCalledWith(result, {
      operation: RETAINED_CLIENT_CONTEXT_OPERATION_03,
      gatewayAsOf, tenantId, clientId,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.readWindow)).toBe(true);
  });

  it.each([
    { operation: { id: 'get_client_context', version: '0.2.0' } },
    { operation: { id: 'read_client_documents', version: '0.3.0' } },
    { operation: { id: 'get_client_context', version: '0.3.0', extra: true } },
  ])('refuses an operation other than exact get_client_context@0.3.0', ({ operation }) => {
    const input = fixture();
    input.operation = operation;
    expect(() => projectRetainedClientContext03(input)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
    expect(input.assertOutput03).not.toHaveBeenCalled();
  });

  it.each([
    { readWindow: { startedAt: '2026-10-18T12:00:02.500Z', completedAt } },
    { readWindow: { startedAt, completedAt: '2026-10-18T12:00:01.500Z' } },
    { readWindow: { startedAt, completedAt, invented: true } },
  ])('refuses unsupported or untruthful collection clocks', (change) => {
    const input = { ...fixture(), ...change } as ClientContextProjection03Input;
    expect(() => projectRetainedClientContext03(input)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
    expect(input.assertOutput03).not.toHaveBeenCalled();
  });

  it('leaves gateway spelling and bounded cross-host skew to the pinned Meri validator', () => {
    const input = fixture();
    input.gatewayAsOf = '2026-10-18T12:00:02Z';
    projectRetainedClientContext03(input);
    expect(input.assertOutput03).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ gatewayAsOf: '2026-10-18T12:00:02Z' }));
  });

  it('refuses a foreign client or tenant before invoking the external validator', () => {
    for (const identity of [{ expectedClientId: 'foreign' }, { expectedTenantId: 'foreign' }]) {
      const input = { ...fixture(), ...identity };
      expect(() => projectRetainedClientContext03(input)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
      expect(input.assertOutput03).not.toHaveBeenCalled();
    }
  });

  it('refuses unexpected canonical wrapper fields and accessor effects', () => {
    const extra = fixture();
    extra.source = { ...(extra.source as Record<string, unknown>), unauthorized: true };
    expect(() => projectRetainedClientContext03(extra)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
    const accessor = fixture();
    let evaluated = false;
    Object.defineProperty(accessor.source, 'tool', {
      enumerable: true,
      get() { evaluated = true; return 'get_client_context'; },
    });
    expect(() => projectRetainedClientContext03(accessor)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
    expect(evaluated).toBe(false);
  });

  it('requires the pinned validator and fails closed without exposing its diagnostics', () => {
    const absent = fixture();
    absent.assertOutput03 = undefined as unknown as ClientContextProjection03Input['assertOutput03'];
    expect(() => projectRetainedClientContext03(absent)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
    const rejected = fixture();
    rejected.assertOutput03 = () => { throw new Error('private schema details'); };
    expect(() => projectRetainedClientContext03(rejected)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
  });
});
