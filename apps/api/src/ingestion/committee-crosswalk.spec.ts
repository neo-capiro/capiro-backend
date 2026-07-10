import { normalizeCommitteeName, resolveCommittee, type CommitteeCandidate } from '@capiro/shared';

const HASC: CommitteeCandidate = {
  systemCode: 'hsas00',
  name: 'Committee on Armed Services',
  chamber: 'house',
  parentSystemCode: null,
};
const SASC: CommitteeCandidate = {
  systemCode: 'ssas00',
  name: 'Committee on Armed Services',
  chamber: 'senate',
  parentSystemCode: null,
};
const HASC_TACAIR: CommitteeCandidate = {
  systemCode: 'hsas26',
  name: 'Tactical Air and Land Forces Subcommittee',
  chamber: 'house',
  parentSystemCode: 'hsas00',
};

describe('normalizeCommitteeName', () => {
  it('strips the chamber prefix and "committee"/"committee on" wrapper words', () => {
    expect(normalizeCommitteeName('House Armed Services Committee')).toBe('armed services');
    expect(normalizeCommitteeName('Committee on Armed Services')).toBe('armed services');
    expect(normalizeCommitteeName('Senate Armed Services Committee')).toBe('armed services');
  });
});

describe('resolveCommittee', () => {
  it('resolves directly by code when committeeCode matches a current systemCode', () => {
    const out = resolveCommittee(
      { committeeName: 'irrelevant text', committeeCode: 'hsas00', chamber: 'house' },
      [HASC, SASC],
    );
    expect(out).toMatchObject({ systemCode: 'hsas00', matchedBy: 'code' });
  });

  it('falls back to name+chamber matching when no code is present', () => {
    const out = resolveCommittee(
      { committeeName: 'House Armed Services Committee', committeeCode: null, chamber: 'house' },
      [HASC, SASC],
    );
    expect(out).toMatchObject({ systemCode: 'hsas00', matchedBy: 'name' });
  });

  it('never guesses: same-name-different-chamber disambiguates via the chamber field', () => {
    const out = resolveCommittee(
      { committeeName: 'Committee on Armed Services', committeeCode: null, chamber: 'senate' },
      [HASC, SASC],
    );
    expect(out).toMatchObject({ systemCode: 'ssas00' });
  });

  it('resolves a subcommittee referral to the subcommittee, not its parent', () => {
    const out = resolveCommittee(
      {
        committeeName: 'Tactical Air and Land Forces Subcommittee',
        committeeCode: null,
        chamber: 'house',
      },
      [HASC, SASC, HASC_TACAIR],
    );
    expect(out).toMatchObject({ systemCode: 'hsas26', parentSystemCode: 'hsas00' });
  });

  it('returns null (never a fuzzy guess) when a stale code matches nothing and the name is ambiguous without a chamber hint', () => {
    const out = resolveCommittee(
      {
        committeeName: 'Committee on Armed Services',
        committeeCode: 'stale-code-123',
        chamber: null,
      },
      [HASC, SASC],
    );
    expect(out).toBeNull();
  });

  it('returns null for an unresolvable name', () => {
    const out = resolveCommittee(
      {
        committeeName: 'Some Renamed Committee Nobody Has Heard Of',
        committeeCode: null,
        chamber: 'house',
      },
      [HASC, SASC],
    );
    expect(out).toBeNull();
  });
});
