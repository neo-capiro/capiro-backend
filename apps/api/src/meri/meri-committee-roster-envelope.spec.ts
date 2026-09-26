import {
  envelopeCommitteeRosterResult,
  observeCommitteeRosterResult,
} from './meri-committee-roster-envelope.js';

describe('get_committee_roster result-envelope observer', () => {
  const request = { committee: 'hsas00', jurisdiction: 'federal' };
  const member = { id: 'B000001', name: 'Member One', party: 'D', state: 'CA' };

  it('preserves the legacy payload and limits claims to returned local membership rows', () => {
    const legacy = {
      tool: 'get_committee_roster', generatedAt: '2026-09-25T12:00:00.000Z',
      committee: { id: 'hsas00', name: 'Armed Services', chamber: 'house', jurisdiction: 'federal' },
      chair: null,
      viceChair: null,
      rankingMember: null,
      members: [member],
    };
    const envelope = envelopeCommitteeRosterResult(legacy, request);
    expect(envelope.legacyPayload).toBe(legacy);
    expect(envelope.outcome).toBe('succeeded');
    expect(envelope.sources[0]).toMatchObject({
      family: 'legislative', sourceId: 'congress_committee_membership',
      availability: 'available', scope: { jurisdiction: 'federal', committeeQuery: 'hsas00' },
      observedAt: null,
      coverage: { completeness: 'partial', returnedCount: 1, matchedCount: null },
      provenance: [{ recordId: 'B000001', sourceId: 'congress_member' }],
    });
    expect(envelope.sources[0]).not.toHaveProperty('observedAt', legacy.generatedAt);
    expect(envelope.outcome).not.toBe('not_found_within_scope');
  });

  it.each([
    ['no-match note', 'No federal committee matched "Rules" — say so explicitly, do not guess.'],
    ['ambiguous resolution note', 'No federal committee matched "Rules" — say so explicitly, do not guess.'],
  ])('does not interpret a legacy %s as proof of absence', (_label, note) => {
    const legacy = {
      tool: 'get_committee_roster', committee: null, members: [], note,
      generatedAt: '2026-09-25T12:00:00.000Z',
    };
    const envelope = envelopeCommitteeRosterResult(legacy, { committee: 'Rules', jurisdiction: 'federal' });
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]).toMatchObject({
      availability: 'available', observedAt: null,
      coverage: { completeness: 'unknown', matchedCount: null }, provenance: [],
    });
    expect(envelope.outcome).not.toBe('not_found_within_scope');
  });

  it('fails closed for missing state context and does not query a source', () => {
    const legacy = { tool: 'get_committee_roster', committee: null, members: [], note: 'state is required' };
    const envelope = envelopeCommitteeRosterResult(legacy, { committee: 'Appropriations', jurisdiction: 'state' });
    expect(envelope.outcome).toBe('needs_input');
    expect(envelope.sources[0]).toMatchObject({
      availability: 'not_queried', scope: { jurisdiction: 'state' },
      coverage: { completeness: 'unknown' }, provenance: [],
    });
  });

  it('records the handler’s normalized filters without asserting valid state or chamber values', () => {
    const legacy = { tool: 'get_committee_roster', committee: null, members: [], note: 'No match' };
    const envelope = envelopeCommitteeRosterResult(legacy, {
      committee: ' Appropriations ', jurisdiction: 'STATE', state: 'florida', chamber: 'odd-chamber',
    });
    expect(envelope.sources[0]?.scope).toEqual({
      storage: 'capiro_local_database', jurisdiction: 'state',
      committeeQuery: 'Appropriations', state: 'FL', chamber: 'odd-chambe',
    });
    expect(envelope.sources[0]?.coverage.completeness).toBe('unknown');
  });

  it('omits provenance when member IDs are not canonical and keeps invalid resolution unknown', () => {
    const legacy = {
      tool: 'get_committee_roster',
      committee: { id: 'hsas00', name: 'Armed Services', chamber: 'house', jurisdiction: 'federal' },
      members: [{ ...member, id: 'member-1' }],
    };
    const envelope = envelopeCommitteeRosterResult(legacy, request);
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]?.coverage.completeness).toBe('unknown');
    expect(envelope.sources[0]?.provenance).toEqual([]);
  });

  it('fails closed when a federal role pointer is not one of the returned members', () => {
    const legacy = {
      tool: 'get_committee_roster',
      committee: { id: 'hsas00', name: 'Armed Services', chamber: 'house', jurisdiction: 'federal' },
      chair: { id: 'B000002', name: 'Unlisted Member' },
      viceChair: null,
      rankingMember: null,
      members: [member],
    };
    const envelope = envelopeCommitteeRosterResult(legacy, request);
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]?.coverage.completeness).toBe('unknown');
    expect(envelope.sources[0]?.provenance).toEqual([]);
  });

  it('fails closed when a role pointer has the right ID and name but contradictory row fields', () => {
    const legacy = {
      tool: 'get_committee_roster',
      committee: { id: 'hsas00', name: 'Armed Services', chamber: 'house', jurisdiction: 'federal' },
      chair: { ...member, party: 'R' },
      viceChair: null,
      rankingMember: null,
      members: [member],
    };
    const envelope = envelopeCommitteeRosterResult(legacy, request);
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]?.coverage.completeness).toBe('unknown');
    expect(envelope.sources[0]?.provenance).toEqual([]);
  });

  it.each([
    ['mismatched', 'senate'],
    ['unsupported', 'committee'],
  ])('rejects %s federal chamber metadata without a chamber request', (_label, chamber) => {
    const legacy = {
      tool: 'get_committee_roster',
      committee: { id: 'hsas00', name: 'Armed Services', chamber, jurisdiction: 'federal' },
      chair: null, viceChair: null, rankingMember: null, members: [],
    };
    const envelope = envelopeCommitteeRosterResult(legacy, request);
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]?.coverage.completeness).toBe('unknown');
    expect(envelope.sources[0]?.provenance).toEqual([]);
  });

  it('requires the state ranking member pointer to remain null per the legacy handler contract', () => {
    const stateRequest = { committee: 'FL-lower-appropriations', jurisdiction: 'state', state: 'FL' };
    const stateMember = { id: 'leg-1', name: 'Rep. Florida Member' };
    const legacy = {
      tool: 'get_committee_roster',
      committee: {
        id: 'FL-lower-appropriations', name: 'Appropriations', chamber: 'lower', jurisdiction: 'state',
      },
      chair: stateMember, viceChair: null, rankingMember: stateMember, members: [stateMember],
    };
    const envelope = envelopeCommitteeRosterResult(legacy, stateRequest);
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]?.coverage.completeness).toBe('unknown');
    expect(envelope.sources[0]?.provenance).toEqual([]);
  });

  it('preserves legacy result and thrown rejection identity even when observation fails', async () => {
    const legacy = { tool: 'get_committee_roster', committee: null, members: [] };
    await expect(observeCommitteeRosterResult(async () => legacy, request, () => {
      throw new Error('observer failed');
    })).resolves.toBe(legacy);
    const rejection = new Error('legacy read failed');
    await expect(observeCommitteeRosterResult(async () => { throw rejection; }, request, () => undefined))
      .rejects.toBe(rejection);
  });
});
