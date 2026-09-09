import { publishedCommitteeIdentity, storedCommitteeIdentity } from './hearing-committee-identity.js';

describe('published hearing committee identity', () => {
  it.each([
    ['ssas14'],
    ['ssas00', 'ssas14'],
    ['ssas14', 'ssas00'],
    ['SSAS14', 'ssas14'],
  ])('recognizes an explicitly published child in %j', (...codes: string[]) => {
    expect(publishedCommitteeIdentity(codes.map((systemCode) => ({ systemCode })))).toEqual({
      committeeSystemCode: 'ssas00', subcommitteeSystemCode: 'ssas14',
    });
  });

  it.each([
    ['ssas00'],
    ['ssas00', 'ssap00'],
    ['ssas14', 'ssap00'],
    ['ssas14', 'ssas15'],
  ])('does not invent a single child from full committees or ambiguous hosts %j', (...codes: string[]) => {
    expect(publishedCommitteeIdentity(codes.map((systemCode) => ({ systemCode }))))
      .toEqual({ committeeSystemCode: 'ssas00', subcommitteeSystemCode: null });
  });

  it('does not create an identity from missing or malformed codes', () => {
    expect(publishedCommitteeIdentity([{ systemCode: 'Airland' }, {}])).toEqual({
      committeeSystemCode: null, subcommitteeSystemCode: null,
    });
  });
});

describe('stored committee identity', () => {
  it('recovers an explicit legacy child and its parent', () => {
    expect(storedCommitteeIdentity({ committeeCode: 'ssas14' })).toEqual({
      committeeSystemCode: 'ssas00', subcommitteeSystemCode: 'ssas14',
    });
  });

  it('preserves the canonical child over a conflicting legacy child', () => {
    expect(storedCommitteeIdentity({
      committeeSystemCode: 'ssas00', subcommitteeSystemCode: 'ssas15', committeeCode: 'ssas14',
    })).toEqual({ committeeSystemCode: 'ssas00', subcommitteeSystemCode: 'ssas15' });
  });

  it('does not attach a legacy child to a different canonical parent', () => {
    expect(storedCommitteeIdentity({ committeeSystemCode: 'ssap00', committeeCode: 'ssas14' }))
      .toEqual({ committeeSystemCode: 'ssap00', subcommitteeSystemCode: null });
  });
});
