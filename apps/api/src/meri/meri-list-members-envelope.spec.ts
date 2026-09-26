import { envelopeListMembersResult, observeListMembersCall } from './meri-list-members-envelope.js';

const request = { state: 'VA', chamber: 'senate', limit: 2 };
const member = {
  id: 'B000001', name: 'Example Senator', party: 'Independent',
  state: 'Virginia', district: null, chamber: 'senate',
};

function payload(members: unknown[], extra: Record<string, unknown> = {}) {
  return {
    tool: 'list_members', generatedAt: '2026-09-25T12:00:00.000Z',
    filter: { state: 'Virginia', chamber: 'senate' },
    matchesFound: members.length, members, note: 'Current members from the Capiro congressional roster.',
    ...extra,
  };
}

describe('list_members result envelope (dormant success observer)', () => {
  it('reports only the filtered local roster query and stable member IDs', () => {
    const legacy = payload([member]);
    const envelope = envelopeListMembersResult(legacy, request);

    expect(envelope.legacyPayload).toBe(legacy);
    expect(envelope.outcome).toBe('succeeded');
    expect(envelope.sources).toEqual([expect.objectContaining({
      family: 'legislative', sourceId: 'congress_member', availability: 'available',
      observedAt: null,
      scope: { storage: 'capiro_local_database', state: 'Virginia', chamber: 'senate', limit: 2 },
      coverage: {
        completeness: 'complete', continuation: { hasMore: false },
        returnedCount: 1, matchedCount: 1,
      },
      provenance: [{ recordId: member.id, sourceId: 'congress_member' }],
    })]);
    expect(envelope.sources[0]).not.toHaveProperty('sourceVersion');
    expect(envelope.sources[0]).not.toHaveProperty('lastSyncedAt');
  });

  it('treats a cap hit as possible more local rows without claiming actual truncation', () => {
    const legacy = payload([member, { ...member, id: 'B000002', name: 'Second Senator' }]);
    const envelope = envelopeListMembersResult(legacy, request);

    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]?.coverage).toMatchObject({
      completeness: 'partial', returnedCount: 2, matchedCount: null,
    });
    expect(envelope.sources[0]?.coverage).not.toHaveProperty('continuation');
    expect(envelope.truncation).toEqual({ truncated: false });
  });

  it('limits an empty result to the applied local filters', () => {
    const legacy = payload([]);
    const envelope = envelopeListMembersResult(legacy, request);
    expect(envelope.outcome).toBe('not_found_within_scope');
    expect(envelope.sources[0]?.coverage).toMatchObject({
      completeness: 'complete', returnedCount: 0, matchedCount: 0,
    });
  });

  it('records only recognized filters that the handler applies', () => {
    const legacy = payload([member], { filter: { state: 'Virginia', chamber: null } });
    const envelope = envelopeListMembersResult(legacy, { state: 'VA', chamber: 'joint', limit: 2 });
    expect(envelope.sources[0]?.scope).toEqual({
      storage: 'capiro_local_database', state: 'Virginia', limit: 2,
    });
    expect(envelope.sources[0]?.coverage.completeness).toBe('complete');
  });

  it.each([
    [{ state: 'Atlantis', chamber: 'senate' }, 'invalid_state', '"Atlantis" is not a recognized US state or territory — say so.'],
    [{ chamber: 'joint' }, 'missing_filter', 'Provide a state (full name or 2-letter code) and/or a chamber ("house"|"senate").'],
  ] as const)('distinguishes unqueried invalid/missing context (%j)', (input, resolution, note) => {
    const legacy = {
      tool: 'list_members', generatedAt: 'generated', matchesFound: 0, members: [], note,
    };
    const envelope = envelopeListMembersResult(legacy, input);
    expect(envelope.outcome).toBe('needs_input');
    expect(envelope.sources[0]).toMatchObject({
      availability: 'not_queried', scope: { storage: 'capiro_local_database', resolution },
      observedAt: null, coverage: { completeness: 'unknown', matchedCount: null }, provenance: [],
    });
  });

  it('keeps contradictory filters, counts, rows, or foreign payloads unverified', () => {
    const cases = [
      [payload([member], { filter: { state: 'Florida', chamber: 'senate' } }), request],
      [payload([member], { matchesFound: 2 }), request],
      [payload([{ ...member, id: '' }]), request],
      [payload([{ ...member, id: 'not-a-bioguide-id' }]), request],
      [payload([{ ...member, state: 'Atlantis' }]), request],
      [payload([{ ...member, chamber: 'joint' }], {
        filter: { state: 'Virginia', chamber: null },
      }), { state: 'VA', chamber: 'joint', limit: 2 }],
      [{ tool: 'another_tool', members: [], matchesFound: 0 }, request],
    ] as const;
    for (const [legacy, input] of cases) {
      const envelope = envelopeListMembersResult(legacy, input);
      expect(envelope.outcome).toBe('partial');
      expect(envelope.sources[0]?.coverage.completeness).toBe('unknown');
      expect(envelope.sources[0]?.provenance).toEqual([]);
      expect(envelope.errors).toEqual([{ code: 'list_members_observation_unverified' }]);
    }
  });

  it('requires a recognized state even when only chamber is used as the filter', () => {
    const legacy = payload([{ ...member, state: '' }], {
      filter: { state: null, chamber: 'senate' },
    });
    const envelope = envelopeListMembersResult(legacy, { chamber: 'senate', limit: 2 });
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]?.availability).toBe('unknown');
    expect(envelope.sources[0]?.coverage.completeness).toBe('unknown');
    expect(envelope.sources[0]?.provenance).toEqual([]);
  });

  it('preserves exact legacy result and rejection identity across observation', async () => {
    const legacy = payload([member]);
    const observed: unknown[] = [];
    await expect(observeListMembersCall(async () => legacy, request,
      (envelope) => observed.push(envelope))).resolves.toBe(legacy);
    expect(observed).toHaveLength(1);
    await expect(observeListMembersCall(async () => legacy, request,
      () => { throw new Error('observer failure'); })).resolves.toBe(legacy);

    const failure = new Error('roster read failed');
    await expect(observeListMembersCall(async () => { throw failure; }, request,
      () => { throw new Error('should not observe a rejection'); })).rejects.toBe(failure);
  });
});
