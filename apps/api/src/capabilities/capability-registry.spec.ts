import { CapabilityRegistry } from './capability-registry.js';
import type { CapabilityDefinition } from './capability-definition.js';

const schema = { name: 'test', parse: (value: unknown) => value };

function definition(name: string): CapabilityDefinition<unknown, unknown> {
  return {
    name,
    description: name,
    version: 1,
    readOnly: true,
    riskClass: 'read',
    surfaces: ['internal'],
    supportsClientScope: false,
    requiresClientScope: false,
    timeoutMs: 100,
    maxResultCount: 1,
    maxResultBytes: 1024,
    provenanceRequired: false,
    inputSchema: schema,
    outputSchema: schema as CapabilityDefinition<unknown, unknown>['outputSchema'],
    execute: async () => ({
      capability: name,
      schemaVersion: 1,
      data: null,
      provenance: [],
      exclusions: [],
      scope: { tenantId: '00000000-0000-4000-8000-000000000000' },
      freshness: { asOf: new Date(0).toISOString(), degraded: false, reasons: [] },
      authorization: { filtered: false, restrictedCount: 0 },
    }),
  };
}

describe('CapabilityRegistry', () => {
  it('rejects duplicate semantic capability names', () => {
    const registry = new CapabilityRegistry();
    registry.register(definition('get_client_context'));
    expect(() => registry.register(definition('get_client_context'))).toThrow(/duplicate capability/);
  });

  it('lists definitions deterministically for a surface', () => {
    const registry = new CapabilityRegistry();
    registry.register(definition('zeta'));
    registry.register(definition('alpha'));
    expect(registry.listForSurface('internal').map((entry) => entry.name)).toEqual(['alpha', 'zeta']);
  });
});
