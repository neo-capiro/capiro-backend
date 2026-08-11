import {
  capabilitySearchTerms,
  extractJsonObject,
  fillFindingHash,
  isPrivateOrLocalIp,
  normalizeWebsite,
  provisionalPeScore,
  resolveEvidenceUrl,
} from './client-profile-fill.helpers.js';

describe('client-profile-fill helpers', () => {
  it('hashes semantically identical objects deterministically', () => {
    const a = fillFindingHash({ kind: 'person', targetKey: 'person:a', source: 'public_web', proposedValue: { b: 2, a: 1 } });
    const b = fillFindingHash({ kind: 'person', targetKey: 'person:a', source: 'public_web', proposedValue: { a: 1, b: 2 } });
    expect(a).toBe(b);
  });

  it('normalizes public websites and rejects non-http schemes', () => {
    expect(normalizeWebsite('example.com')).toBe('https://example.com/');
    expect(normalizeWebsite('javascript:alert(1)')).toBeNull();
  });

  it('accepts only evidence URLs that were actually gathered', () => {
    expect(resolveEvidenceUrl('https://example.com/about/', ['https://example.com/about'])).toBe('https://example.com/about');
    expect(resolveEvidenceUrl('https://example.com/invented', ['https://example.com'])).toBeNull();
  });

  it('extracts a fenced JSON object', () => {
    expect(extractJsonObject('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('blocks private and loopback addresses', () => {
    expect(isPrivateOrLocalIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrLocalIp('10.1.2.3')).toBe(true);
    expect(isPrivateOrLocalIp('8.8.8.8')).toBe(false);
  });

  it('builds bounded capability terms and scores only real text overlap', () => {
    const terms = capabilitySearchTerms({ name: 'Autonomous Ground Robotics', keywords: ['GPS-denied autonomy'] });
    expect(terms).toContain('autonomous');
    expect(terms).toContain('robotics');
    expect(provisionalPeScore({ title: 'Ground Robotics and Autonomous Systems' }, terms).score).toBeGreaterThan(0);
    expect(provisionalPeScore({ title: 'Military Medical Research' }, terms).score).toBe(0);
  });

  it('extracts PE search terms from thin client descriptions', () => {
    const terms = capabilitySearchTerms({
      name: 'Kiley Associates',
      description: 'Government affairs and lobbying firm',
    });
    expect(terms).toEqual(expect.arrayContaining(['kiley', 'associates', 'affairs', 'lobbying']));
  });
});
