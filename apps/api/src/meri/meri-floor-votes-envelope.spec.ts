import { envelopeFloorVotesResult, observeFloorVotesCall } from './meri-floor-votes-envelope.js';

const request = { billId: '119-hr-10', chamber: 'house', congress: 119, limit: 2 };
const vote = {
  id: 'vote-1', billId: '119-hr-10', chamber: 'house', congress: 119,
  sourceUrl: 'https://clerk.house.gov/Votes/2025-1',
};

describe('search_floor_votes result envelope', () => {
  it('keeps the legacy object and reports local scope with vote provenance', () => {
    const legacy = { tool: 'search_floor_votes', votesFound: 1, votes: [vote] };
    const envelope = envelopeFloorVotesResult(legacy, request);
    expect(envelope.legacyPayload).toBe(legacy);
    expect(envelope.outcome).toBe('succeeded');
    expect(envelope.sources[0]).toMatchObject({
      sourceId: 'roll_call_vote', availability: 'available', observedAt: null,
      scope: { storage: 'capiro_local_database', billId: request.billId, limit: 2 },
      coverage: { completeness: 'complete', returnedCount: 1, matchedCount: 1 },
      provenance: [{ recordId: vote.id, sourceId: 'roll_call_vote', url: vote.sourceUrl }],
    });
  });

  it('treats a full page as possibly capped without asserting truncation', () => {
    const legacy = { tool: 'search_floor_votes', votesFound: 2,
      votes: [vote, { ...vote, id: 'vote-2' }] };
    const envelope = envelopeFloorVotesResult(legacy, request);
    expect(envelope.outcome).toBe('partial');
    expect(envelope.truncation).toEqual({ truncated: false });
    expect(envelope.sources[0]?.coverage.completeness).toBe('partial');
    expect(envelope.sources[0]?.coverage.matchedCount).toBeNull();
  });

  it('does not report an ignored chamber as applied scope', () => {
    const legacy = { tool: 'search_floor_votes', votesFound: 1, votes: [vote] };
    const envelope = envelopeFloorVotesResult(legacy, { ...request, chamber: 'joint' });
    expect(envelope.sources[0]?.scope).not.toHaveProperty('chamber');
    expect(envelope.sources[0]?.coverage.completeness).toBe('unknown');
  });

  it('requires a selected member vote on each returned member-filtered row', () => {
    const legacy = { tool: 'search_floor_votes', votesFound: 1, votes: [vote],
      member: { bioguideId: 'B000001', fullName: 'Test Member' } };
    const envelope = envelopeFloorVotesResult(legacy, { ...request, member: 'B000001' });
    expect(envelope.sources[0]?.coverage.completeness).toBe('unknown');
    expect(envelope.sources[0]?.provenance).toEqual([]);
  });

  it('reports only a scoped local miss', () => {
    const legacy = { tool: 'search_floor_votes', votesFound: 0, votes: [] };
    expect(envelopeFloorVotesResult(legacy, request).outcome).toBe('not_found_within_scope');
    expect(envelopeFloorVotesResult(legacy, { ...request, member: 'unresolved' }).outcome)
      .toBe('needs_input');
  });

  it('does not call an unexpected member-scoped empty result a local miss', () => {
    const legacy = { tool: 'search_floor_votes', votesFound: 0, votes: [],
      member: { bioguideId: 'B000001', fullName: 'Unexpected Member' } };
    const envelope = envelopeFloorVotesResult(legacy, request);
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]?.coverage.completeness).toBe('unknown');
    expect(envelope.sources[0]?.scope).not.toHaveProperty('memberBioguideId');
  });

  it('does not promote conflicting counts or scope to complete', () => {
    const legacy = { tool: 'search_floor_votes', votesFound: 2, votes: [vote] };
    const envelope = envelopeFloorVotesResult(legacy, request);
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]?.coverage.completeness).toBe('unknown');
    expect(envelope.sources[0]?.provenance).toEqual([]);
    expect(envelopeFloorVotesResult({ ...legacy, votesFound: 1 },
      { ...request, billId: '119-hr-11' }).outcome).toBe('partial');
    expect(envelopeFloorVotesResult({ ...legacy, votesFound: 1,
      votes: [{ ...vote, memberVotes: [{ voteCast: 'Yea' }] }],
      member: { bioguideId: 'B000001', fullName: 'Another Member' } },
      { ...request, member: 'B000002' }).sources[0]?.coverage.completeness).toBe('unknown');
  });

  it('does not let an observer change the result or a thrown error', async () => {
    const legacy = { tool: 'search_floor_votes', votesFound: 0, votes: [] };
    const observed: unknown[] = [];
    await expect(observeFloorVotesCall(async () => legacy, request,
      (envelope) => { observed.push(envelope); })).resolves.toBe(legacy);
    expect(observed).toHaveLength(1);
    await expect(observeFloorVotesCall(async () => legacy, request,
      () => { throw new Error('observer'); })).resolves.toBe(legacy);
    const error = new Error('read failed');
    await expect(observeFloorVotesCall(async () => { throw error; }, request,
      () => { throw new Error('unexpected observer'); })).rejects.toBe(error);
  });
});
