import { MERI_HERMES_BROKER_TOOLS } from './hermes-runtime.contracts.js';
import {
  brokerPolicySubsetForToolView,
  MeriHermesBrokerPolicySubsetError,
} from './meri-hermes-broker-policy-subset.js';
import { compileMeriHermesToolViewV1, type MeriHermesToolViewV1 } from './meri-hermes-tool-view.js';

function view(...names: string[]): MeriHermesToolViewV1 {
  return compileMeriHermesToolViewV1({
    catalogVersion: 'synthetic-1', expectedCatalogVersion: 'synthetic-1',
    meriCatalogDigest: 'e'.repeat(64), expectedMeriCatalogDigest: 'e'.repeat(64),
    capabilityMappingVersion: 'synthetic-map-1',
    expectedCapabilityMappingVersion: 'synthetic-map-1',
    capabilityMappingDigest: 'f'.repeat(64),
    expectedCapabilityMappingDigest: 'f'.repeat(64),
    catalogTools: names.map((name) => ({
      type: 'function' as const,
      function: { name, description: `${name} tool`, parameters: { type: 'object' } },
    })), deploymentToolNames: names,
    authorizedToolNames: names, availableToolNames: names,
    requiredToolNames: [], relevantToolNames: names, runLocalToolNames: [],
  });
}

describe('Phase 4 broker subset contract (dormant)', () => {
  test.each([
    'meri_memory_search', 'meri_memory_propose', 'meri_fetch_attachment',
    'meri_publish_artifact', 'meri_request_clarification',
  ])('admits known broker tool %s only when its worker name is selected', (name) => {
    expect(brokerPolicySubsetForToolView(view(name, 'read_file')).allow).toEqual([name]);
    expect(brokerPolicySubsetForToolView(view('read_file')).allow).not.toContain(name);
  });

  test('an empty or native-only view grants no broker tool', () => {
    expect(brokerPolicySubsetForToolView(view()).allow).toEqual([]);
    expect(brokerPolicySubsetForToolView(view('read_file', 'tool_search')).allow).toEqual([]);
  });

  test('all known model-visible broker tools remain a strict subset of the six legacy tools', () => {
    const selected = MERI_HERMES_BROKER_TOOLS.filter((name) => name !== 'meri_record_turn');
    const policy = brokerPolicySubsetForToolView(view(...selected));
    expect(policy.allow).toEqual(selected);
    expect(policy.allow).not.toContain('meri_record_turn');
    expect(policy.deny).toEqual([]);
  });

  test('unknown Meri selection fails before an allow-list can be returned', () => {
    expect(() => brokerPolicySubsetForToolView(view('meri_future_write', 'meri_memory_search')))
      .toThrow(new MeriHermesBrokerPolicySubsetError('unmapped_meri_tool'));
    expect(() => brokerPolicySubsetForToolView(view('meri_record_turn')))
      .toThrow(new MeriHermesBrokerPolicySubsetError('unmapped_meri_tool'));
  });

  test('rejects an uncompiled structural lookalike', () => {
    const forged = Object.freeze({
      version: 1, catalogVersion: 'synthetic-1',
      toolNames: Object.freeze(['meri_memory_search']), requiredToolNames: Object.freeze([]),
    });
    expect(() => brokerPolicySubsetForToolView(forged as unknown as MeriHermesToolViewV1))
      .toThrow(new MeriHermesBrokerPolicySubsetError('invalid_tool_view'));
  });
});
