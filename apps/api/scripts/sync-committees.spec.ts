/**
 * thomas_id -> Congress.gov systemCode mapping (Bucket-#3 C6.P6.1). The
 * mapping was verified live against congress.gov (hsag00's subcommittee list
 * includes hsag16 matching committees-current.json's sub thomas_id "16").
 */
import {
  systemCodeForCommittee,
  systemCodeForSubcommittee,
  membershipKeyToSystemCode,
  resolveCommitteeUrl,
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

/**
 * Generic source-precedence rule for `congress_committee.url`. Uses
 * jslc00/jspr00 as REGRESSION FIXTURES (the two committees whose community
 * feed url actually went stale and 404'd), but resolveCommitteeUrl() itself
 * takes no committee identity as input — the same four branches apply to
 * every committee code.
 */
describe('resolveCommitteeUrl (generic congress_gov > community precedence)', () => {
  const OLD_JSLC00_URL = 'https://cha.house.gov/jointcommittees/joint-committee-library';
  const NEW_JSLC00_URL = 'https://cha.house.gov/joint-committee-on-library';
  const OLD_JSPR00_URL = 'https://cha.house.gov/jointcommittees/joint-committee-on-printing';
  const NEW_JSPR00_URL = 'https://cha.house.gov/joint-committee-on-printing';

  it('a fresh congress_gov-confirmed url always wins and is stamped congress_gov', () => {
    const result = resolveCommitteeUrl({
      communityUrl: OLD_JSLC00_URL,
      existingUrl: OLD_JSLC00_URL,
      existingUrlSource: null,
      congressGovUrl: NEW_JSLC00_URL,
    });
    expect(result).toEqual({ url: NEW_JSLC00_URL, urlSource: 'congress_gov' });
  });

  it('a subsequent community-only sync (no congress_gov answer this run) never reverts an already congress_gov-verified url', () => {
    // Simulates the exact regression: jslc00 was corrected to congress_gov
    // authority on a prior run; today's sync only has the stale community
    // value AND the congress.gov cross-check either wasn't reached (bounded
    // cap) or transiently failed (congressGovUrl: null either way).
    const result = resolveCommitteeUrl({
      communityUrl: OLD_JSLC00_URL,
      existingUrl: NEW_JSLC00_URL,
      existingUrlSource: 'congress_gov',
      congressGovUrl: null,
    });
    expect(result).toEqual({ url: NEW_JSLC00_URL, urlSource: 'congress_gov' });
  });

  it('same regression for jspr00 (second fixture, proving the rule is not jslc00-specific)', () => {
    const result = resolveCommitteeUrl({
      communityUrl: OLD_JSPR00_URL,
      existingUrl: NEW_JSPR00_URL,
      existingUrlSource: 'congress_gov',
      congressGovUrl: null,
    });
    expect(result).toEqual({ url: NEW_JSPR00_URL, urlSource: 'congress_gov' });
  });

  it('a committee never congress_gov-verified still takes the community value (unchanged historical behavior)', () => {
    const result = resolveCommitteeUrl({
      communityUrl: 'https://example.house.gov/some-committee',
      existingUrl: null,
      existingUrlSource: null,
      congressGovUrl: null,
    });
    expect(result).toEqual({
      url: 'https://example.house.gov/some-committee',
      urlSource: 'community',
    });
  });

  it('a null community url with no congress_gov answer and no prior authority yields a null url (never invents one)', () => {
    const result = resolveCommitteeUrl({
      communityUrl: null,
      existingUrl: null,
      existingUrlSource: null,
      congressGovUrl: null,
    });
    expect(result).toEqual({ url: null, urlSource: null });
  });

  it('a congress_gov answer overrides even a differing existing community value on the same run', () => {
    const result = resolveCommitteeUrl({
      communityUrl: OLD_JSLC00_URL,
      existingUrl: OLD_JSLC00_URL,
      existingUrlSource: 'community',
      congressGovUrl: NEW_JSLC00_URL,
    });
    expect(result).toEqual({ url: NEW_JSLC00_URL, urlSource: 'congress_gov' });
  });
});
