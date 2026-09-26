import {
  compileFinalOfferedCapabilitySnapshot,
  validateFinalOfferedCapabilitySelection,
  type AuthenticatedFinalToolScope,
  type FinalOfferedToolSchema,
} from './meriv3-final-offered-capability-snapshot.js';

const scope: AuthenticatedFinalToolScope = {
  tenantId: 'tenant-a',
  userId: 'actor-a',
  conversationId: 'conversation-a',
  clientId: 'client-a',
  surface: 'chat',
};
const schema = (name: string, description = name): FinalOfferedToolSchema => ({
  name,
  description,
  input_schema: { type: 'object', properties: {} },
});

describe('final offered capability snapshot', () => {
  it('contains only canonical IDs from the actual final offered schemas', () => {
    const offered = [
      schema('search_research_sources'),
      schema('mcp__meriv3_hubspot__search'),
      schema('send_email'),
    ];
    const snapshot = compileFinalOfferedCapabilitySnapshot({
      authenticatedScope: scope,
      finalOfferedSchemas: offered,
    });
    expect(snapshot.candidateIds).toEqual(['search_research_sources', 'send_email']);
    expect(snapshot.eligibility).toBe('unresolved');
    expect(snapshot.unresolvedChecks).toEqual(['native-user-and-client-permission']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.scope)).toBe(true);
    expect(Object.isFrozen(snapshot.candidateIds)).toBe(true);
    expect(() =>
      validateFinalOfferedCapabilitySelection({
        snapshot,
        authenticatedScope: scope,
        finalOfferedSchemas: offered,
        candidateSetVersion: snapshot.candidateSetVersion,
        selectedIds: ['mcp__meriv3_hubspot__search'],
      }),
    ).toThrow('final_tool_selection_not_offered');
  });

  it('binds exact schema content, versions and authenticated turn scope', () => {
    const offered = [schema('search_research_sources')];
    const snapshot = compileFinalOfferedCapabilitySnapshot({
      authenticatedScope: scope,
      finalOfferedSchemas: offered,
    });
    expect(
      validateFinalOfferedCapabilitySelection({
        snapshot,
        authenticatedScope: scope,
        finalOfferedSchemas: offered,
        candidateSetVersion: snapshot.candidateSetVersion,
        selectedIds: ['search_research_sources'],
      }),
    ).toEqual({
      eligibility: 'unresolved',
      unresolvedChecks: ['native-user-and-client-permission'],
      selectedIds: ['search_research_sources'],
    });
    for (const changedScope of [
      { ...scope, tenantId: 'tenant-b' },
      { ...scope, userId: 'actor-b' },
      { ...scope, conversationId: 'conversation-b' },
      { ...scope, clientId: 'client-b' },
      { ...scope, surface: 'research' as const },
    ]) {
      expect(() =>
        validateFinalOfferedCapabilitySelection({
          snapshot,
          authenticatedScope: changedScope,
          finalOfferedSchemas: offered,
          candidateSetVersion: snapshot.candidateSetVersion,
          selectedIds: ['search_research_sources'],
        }),
      ).toThrow('final_tool_snapshot_stale');
    }
    expect(() =>
      validateFinalOfferedCapabilitySelection({
        snapshot,
        authenticatedScope: scope,
        finalOfferedSchemas: [schema('search_research_sources', 'changed description')],
        candidateSetVersion: snapshot.candidateSetVersion,
        selectedIds: ['search_research_sources'],
      }),
    ).toThrow('final_tool_snapshot_stale');
    expect(() =>
      validateFinalOfferedCapabilitySelection({
        snapshot,
        authenticatedScope: scope,
        finalOfferedSchemas: offered,
        candidateSetVersion: 'old',
        selectedIds: ['search_research_sources'],
      }),
    ).toThrow('final_tool_snapshot_stale');
  });

  it('rejects duplicate, unknown and unoffered selections', () => {
    const offered = [schema('search_research_sources')];
    const snapshot = compileFinalOfferedCapabilitySnapshot({
      authenticatedScope: scope,
      finalOfferedSchemas: offered,
    });
    const selection = (selectedIds: unknown) =>
      validateFinalOfferedCapabilitySelection({
        snapshot,
        authenticatedScope: scope,
        finalOfferedSchemas: offered,
        candidateSetVersion: snapshot.candidateSetVersion,
        selectedIds,
      });
    expect(() => selection(['search_research_sources', 'search_research_sources'])).toThrow(
      'final_tool_selection_duplicate',
    );
    expect(() => selection(['send_email'])).toThrow('final_tool_selection_not_offered');
    expect(() => selection(['nonexistent_tool'])).toThrow('final_tool_selection_not_offered');
    expect(() => selection([42])).toThrow('final_tool_selection_invalid');
    expect(() =>
      validateFinalOfferedCapabilitySelection({
        snapshot: { ...snapshot, candidateIds: ['search_research_sources', 'send_email'] },
        authenticatedScope: scope,
        finalOfferedSchemas: offered,
        candidateSetVersion: snapshot.candidateSetVersion,
        selectedIds: ['search_research_sources'],
      }),
    ).toThrow('final_tool_snapshot_stale');
    expect(() =>
      validateFinalOfferedCapabilitySelection({
        snapshot: { ...snapshot, unresolvedChecks: [] as never },
        authenticatedScope: scope,
        finalOfferedSchemas: offered,
        candidateSetVersion: snapshot.candidateSetVersion,
        selectedIds: ['search_research_sources'],
      }),
    ).toThrow('final_tool_snapshot_stale');
    expect(() =>
      compileFinalOfferedCapabilitySnapshot({
        authenticatedScope: scope,
        finalOfferedSchemas: [...offered, ...offered],
      }),
    ).toThrow('final_tool_schema_duplicate');
  });

  it('keeps overlapping tenant and actor turns isolated', async () => {
    const [a, b] = await Promise.all([
      Promise.resolve().then(() =>
        compileFinalOfferedCapabilitySnapshot({
          authenticatedScope: scope,
          finalOfferedSchemas: [schema('search_research_sources')],
        }),
      ),
      Promise.resolve().then(() =>
        compileFinalOfferedCapabilitySnapshot({
          authenticatedScope: { ...scope, tenantId: 'tenant-b', userId: 'actor-b', clientId: null },
          finalOfferedSchemas: [schema('send_email')],
        }),
      ),
    ]);
    expect(a.candidateIds).toEqual(['search_research_sources']);
    expect(b.candidateIds).toEqual(['send_email']);
    expect(a.candidateSetVersion).not.toBe(b.candidateSetVersion);
    expect(a.schemaFingerprint).not.toBe(b.schemaFingerprint);
  });
});
