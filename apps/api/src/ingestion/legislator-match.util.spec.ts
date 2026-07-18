import {
  normalizeLegislatorName,
  normalizeDistrict,
  normalizeParty,
  personChamber,
  pickLegislatorMatch,
  type MatchCandidate,
} from './legislator-match.util.js';

describe('normalizeLegislatorName', () => {
  it('lowercases, collapses punctuation to spaces', () => {
    expect(normalizeLegislatorName('John A. Smith')).toBe('john a smith');
    expect(normalizeLegislatorName('Smith-Jones, Mary')).toBe('smith jones mary');
  });
  it('drops trailing generational suffixes', () => {
    expect(normalizeLegislatorName('Robert Downey Jr.')).toBe('robert downey');
    expect(normalizeLegislatorName('Henry Ford III')).toBe('henry ford');
  });
  it('keeps a lone token that looks like a suffix', () => {
    expect(normalizeLegislatorName('V')).toBe('v');
  });
  it('handles empty/nullish', () => {
    expect(normalizeLegislatorName('')).toBe('');
    expect(normalizeLegislatorName(null)).toBe('');
    expect(normalizeLegislatorName(undefined)).toBe('');
  });
});

describe('normalizeDistrict', () => {
  it('extracts a digit run, stripping leading zeros', () => {
    expect(normalizeDistrict('HD-034')).toBe('34');
    expect(normalizeDistrict('034')).toBe('34');
    expect(normalizeDistrict('34')).toBe('34');
    expect(normalizeDistrict('District 5')).toBe('5');
  });
  it('falls back to alphanumerics for a purely named district', () => {
    expect(normalizeDistrict('At-Large')).toBe('atlarge');
  });
  it('handles null/empty', () => {
    expect(normalizeDistrict(null)).toBeNull();
    expect(normalizeDistrict('')).toBeNull();
    expect(normalizeDistrict('   ')).toBeNull();
  });
});

describe('normalizeParty', () => {
  it('reduces to a canonical first char', () => {
    expect(normalizeParty('Democratic')).toBe('d');
    expect(normalizeParty('Republican')).toBe('r');
    expect(normalizeParty('D')).toBe('d');
    expect(normalizeParty('Independent')).toBe('i');
  });
  it('handles null/empty', () => {
    expect(normalizeParty(null)).toBeNull();
    expect(normalizeParty('')).toBeNull();
  });
});

describe('personChamber', () => {
  it('maps role_id 1/2 to lower/upper', () => {
    expect(personChamber({ roleId: 1 })).toBe('lower');
    expect(personChamber({ roleId: 2 })).toBe('upper');
  });
  it('falls back to the role string', () => {
    expect(personChamber({ role: 'Sen' })).toBe('upper');
    expect(personChamber({ role: 'Rep' })).toBe('lower');
    expect(personChamber({ role: 'Assembly Member' })).toBe('lower');
    expect(personChamber({ role: 'Delegate' })).toBe('lower');
  });
  it('returns null when unknown', () => {
    expect(personChamber({})).toBeNull();
    expect(personChamber({ role: '' })).toBeNull();
  });
});

describe('pickLegislatorMatch', () => {
  const cands = (rows: MatchCandidate[]) => rows;

  it('matches on exact full name', () => {
    const id = pickLegislatorMatch(
      { name: 'John Smith' },
      cands([{ id: 'os-1', name: 'John Smith' }]),
    );
    expect(id).toBe('os-1');
  });

  it('matches despite a middle initial via last+first tier', () => {
    const id = pickLegislatorMatch(
      { name: 'John A. Smith', firstName: 'John', lastName: 'Smith' },
      cands([{ id: 'os-1', name: 'John Smith' }]),
    );
    expect(id).toBe('os-1');
  });

  it('matches despite a suffix divergence', () => {
    const id = pickLegislatorMatch(
      { name: 'Robert Downey Jr.' },
      cands([{ id: 'os-1', name: 'Robert Downey' }]),
    );
    expect(id).toBe('os-1');
  });

  it('disambiguates two same-name candidates by district', () => {
    const id = pickLegislatorMatch(
      { name: 'John Smith', district: 'HD-12' },
      cands([
        { id: 'os-a', name: 'John Smith', district: '5' },
        { id: 'os-b', name: 'John Smith', district: '12' },
      ]),
    );
    expect(id).toBe('os-b');
  });

  it('disambiguates by chamber when districts collide across chambers', () => {
    const id = pickLegislatorMatch(
      { name: 'John Smith', district: 'SD-34', roleId: 2 },
      cands([
        { id: 'os-house', name: 'John Smith', district: '34', chamber: 'lower' },
        { id: 'os-sen', name: 'John Smith', district: '34', chamber: 'upper' },
      ]),
    );
    expect(id).toBe('os-sen');
  });

  it('disambiguates by party as the last resort', () => {
    const id = pickLegislatorMatch(
      { name: 'John Smith', party: 'Republican' },
      cands([
        { id: 'os-d', name: 'John Smith', party: 'Democratic' },
        { id: 'os-r', name: 'John Smith', party: 'Republican' },
      ]),
    );
    expect(id).toBe('os-r');
  });

  it('returns null when the tie cannot be resolved (PD2 — never guess)', () => {
    const id = pickLegislatorMatch(
      { name: 'John Smith' },
      cands([
        { id: 'os-a', name: 'John Smith' },
        { id: 'os-b', name: 'John Smith' },
      ]),
    );
    expect(id).toBeNull();
  });

  it('matches by district+lastname when the first name differs (nickname)', () => {
    const id = pickLegislatorMatch(
      { name: 'Bob Smith', lastName: 'Smith', district: '12', roleId: 1 },
      cands([{ id: 'os-1', name: 'Robert Smith', district: '12', chamber: 'lower' }]),
    );
    expect(id).toBe('os-1');
  });

  it('does not cross chambers on a district match when both chambers are known', () => {
    const id = pickLegislatorMatch(
      { name: 'Bob Smith', lastName: 'Smith', district: '12', roleId: 2 },
      cands([{ id: 'os-1', name: 'Robert Smith', district: '12', chamber: 'lower' }]),
    );
    expect(id).toBeNull();
  });

  it('returns null on an empty candidate list', () => {
    expect(pickLegislatorMatch({ name: 'John Smith' }, [])).toBeNull();
  });

  it('does not match unrelated people', () => {
    const id = pickLegislatorMatch(
      { name: 'Jane Doe', district: '3' },
      cands([{ id: 'os-1', name: 'John Smith', district: '12' }]),
    );
    expect(id).toBeNull();
  });

  it('prefers the exact full-name candidate over a looser district collision', () => {
    // Exact name (tier 1) should win before district/last-name (tier 2) is tried.
    const id = pickLegislatorMatch(
      { name: 'John Smith', district: '9' },
      cands([
        { id: 'os-exact', name: 'John Smith', district: '9' },
        { id: 'os-other', name: 'Johnny Smith', district: '9' },
      ]),
    );
    expect(id).toBe('os-exact');
  });
});
