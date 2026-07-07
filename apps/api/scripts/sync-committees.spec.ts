/**
 * thomas_id -> Congress.gov systemCode mapping (Bucket-#3 C6.P6.1). The
 * mapping was verified live against congress.gov (hsag00's subcommittee list
 * includes hsag16 matching committees-current.json's sub thomas_id "16").
 */
import {
  systemCodeForCommittee,
  systemCodeForSubcommittee,
  membershipKeyToSystemCode,
} from './sync-committees';

describe('systemCode derivation', () => {
  it('full committees: lowercase + "00"', () => {
    expect(systemCodeForCommittee('HSAG')).toBe('hsag00');
    expect(systemCodeForCommittee('SSAF')).toBe('ssaf00');
    expect(systemCodeForCommittee('JSPR')).toBe('jspr00');
  });

  it('subcommittees: lowercase parent + 2-digit sub id', () => {
    expect(systemCodeForSubcommittee('HSAG', '16')).toBe('hsag16');
    expect(systemCodeForSubcommittee('HLIG', '01')).toBe('hlig01');
  });
});

describe('membershipKeyToSystemCode', () => {
  it.each([
    ['HSAG', 'hsag00'],
    ['HSAG16', 'hsag16'],
    ['SSAF', 'ssaf00'],
    ['SPAG', 'spag00'],
    ['SCNC', 'scnc00'],
    ['HLIG11', 'hlig11'],
  ])('%s -> %s', (key, expected) => {
    expect(membershipKeyToSystemCode(key)).toBe(expected);
  });

  it('rejects keys that fit neither shape', () => {
    expect(membershipKeyToSystemCode('HS')).toBeNull();
    expect(membershipKeyToSystemCode('HSAG1')).toBeNull();
    expect(membershipKeyToSystemCode('hsag')).toBeNull();
    expect(membershipKeyToSystemCode('HSAG167')).toBeNull();
  });
});
