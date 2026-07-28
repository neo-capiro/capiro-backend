import { packetVerificationFor } from './alert-packet.js';

/**
 * MP-11 (Gate L phase d). Previously ANY absolute http(s) URL was labelled
 * 'official', regardless of domain. Now delegates to the shared
 * classifySourceVerification (@capiro/shared): 'official' only on an
 * allowlisted government domain (.gov/.mil), 'extracted' for a relative
 * internal link, and 'unverified' for a null URL or any other absolute URL.
 * Never 'verified' — the type no longer even admits that value.
 */
describe('packetVerificationFor', () => {
  it('labels a .gov URL "official"', () => {
    expect(packetVerificationFor('https://www.congress.gov/bill/119th-congress/house-bill/8800')).toBe(
      'official',
    );
  });

  it('labels a .mil URL "official"', () => {
    expect(packetVerificationFor('https://www.army.mil/article/12345')).toBe('official');
  });

  it('labels a non-government absolute URL "unverified", never "official"', () => {
    expect(packetVerificationFor('https://www.defensenews.com/story/hr8800')).toBe('unverified');
    expect(packetVerificationFor('https://www.legiscan.com/US/bill/HR8800/2026')).toBe('unverified');
  });

  it('labels a relative internal link "extracted"', () => {
    expect(packetVerificationFor('/program-elements/0603286F')).toBe('extracted');
  });

  it('labels a null/undefined URL "unverified"', () => {
    expect(packetVerificationFor(null)).toBe('unverified');
    expect(packetVerificationFor(undefined)).toBe('unverified');
  });
});
