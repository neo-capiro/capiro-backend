import {
  BRIEF_SECTION_KEYS,
  type BriefCitation,
  type BriefSections,
} from './bizdev-brief.types.js';
import {
  buildSourceSnapshot,
  canonicalJson,
  checkClaimDeterministic,
  citationsFromEvidence,
  diffSections,
  generateSections,
  hashSections,
  preserveUserEdits,
  sha256Hex,
  validateCitations,
  validateSections,
} from './bizdev-brief.util.js';
import type { EvidenceItem } from './bizdev-evidence.types.js';

/**
 * Deterministic unit coverage for the pure brief helpers: the exact five
 * section keys, canonical hashing, generation from evidence, diffing,
 * user-edit preservation, and citation validation (authorized identity,
 * no date contradictions, invented dates rejected).
 */

const ev = (over: Partial<EvidenceItem> = {}): EvidenceItem =>
  ({
    sourceFamily: 'usaspending_award',
    recordId: 'AWD-1',
    originalSourceName: 'USAspending',
    originalSourceId: 'AWD-1',
    locator: 'https://example.test/awd-1',
    eventDate: '2026-01-15',
    sourceUpdatedAt: '2026-01-20',
    fetchedAt: '2026-02-01T00:00:00Z',
    title: 'Award for infrastructure work',
    relationshipStrength: 'direct',
    stage: 'obligated',
    ...over,
  }) as EvidenceItem;

describe('BRIEF_SECTION_KEYS', () => {
  test('exactly the five contract keys in order', () => {
    expect([...BRIEF_SECTION_KEYS]).toEqual([
      'companyAndFirmImplication',
      'verifiedEvidence',
      'judgment',
      'practicalAction',
      'missingInformation',
    ]);
  });
});

describe('canonicalJson / sha256Hex', () => {
  test('key order does not change the hash', () => {
    expect(sha256Hex({ a: 1, b: 2 })).toBe(sha256Hex({ b: 2, a: 1 }));
  });
  test('canonicalJson sorts keys and drops whitespace', () => {
    expect(canonicalJson({ z: 1, a: [3, { y: null }] })).toBe(
      '{"a":[3,{"y":null}],"z":1}',
    );
  });
  test('different content → different hash', () => {
    expect(sha256Hex({ a: 1 })).not.toBe(sha256Hex({ a: 2 }));
  });
});

describe('generateSections', () => {
  test('five sections, all generated provenance, citation indexes bounded', () => {
    const sections = generateSections({
      identityName: 'Acme LLC',
      identityBasis: 'uei_exact',
      evidence: [ev()],
    });
    expect(Object.keys(sections).sort()).toEqual([...BRIEF_SECTION_KEYS].sort());
    for (const key of BRIEF_SECTION_KEYS) {
      expect(sections[key].provenance).toBe('generated');
      expect(sections[key].text.length).toBeGreaterThan(0);
    }
    expect(sections.verifiedEvidence.citationIndexes).toEqual([0]);
  });

  test('no evidence → honest scope wording, no invented facts', () => {
    const sections = generateSections({
      identityName: null,
      identityBasis: 'none',
      evidence: [],
    });
    expect(sections.verifiedEvidence.citationIndexes).toEqual([]);
    expect(sections.missingInformation.text).toContain('no dossier evidence matched');
  });
});

describe('validateSections', () => {
  const good = (): BriefSections =>
    generateSections({ identityName: 'X', identityBasis: 'uei_exact', evidence: [ev()] });

  test('valid generated payload passes', () => {
    expect(validateSections(good(), 1)).toEqual([]);
  });

  test('missing section rejected', () => {
    const bad = good() as Record<string, unknown>;
    delete bad.judgment;
    expect(validateSections(bad, 1).map((i) => i.section)).toContain('judgment');
  });

  test('unexpected extra key rejected', () => {
    const bad = { ...good(), extra: { text: 'x', provenance: 'generated', citationIndexes: [] } };
    expect(validateSections(bad, 1).some((i) => i.reason.includes('unexpected section'))).toBe(true);
  });

  test('bad provenance rejected (generated vs edited distinction enforced)', () => {
    const bad = good();
    (bad.judgment as { provenance: string }).provenance = 'authored';
    expect(validateSections(bad, 1).map((i) => i.reason)).toContain(
      'provenance must be generated or edited',
    );
  });

  test('out-of-range citation index rejected', () => {
    const bad = good();
    bad.verifiedEvidence.citationIndexes = [5];
    expect(validateSections(bad, 1).some((i) => i.reason.includes('out of range'))).toBe(true);
  });
});

describe('citationsFromEvidence / validateCitations', () => {
  test('citation preserves identity, locator, and separated dates', () => {
    const [c0] = citationsFromEvidence([ev()]);
    const c = c0!;
    expect(c.sourceFamily).toBe('usaspending_award');
    expect(c.recordId).toBe('AWD-1');
    expect(c.locator).toContain('example.test');
    expect(c.eventDate).toBe('2026-01-15');
    expect(c.sourceUpdatedAt).toBe('2026-01-20');
    expect(c.retrievedAt).toBe('2026-02-01T00:00:00Z');
  });

  test('missing dates stay null, never invented', () => {
    const [c0] = citationsFromEvidence([ev({ eventDate: null, sourceUpdatedAt: null, fetchedAt: null })]);
    const c = c0!;
    expect(c.eventDate).toBeNull();
    expect(c.sourceUpdatedAt).toBeNull();
    expect(c.retrievedAt).toBeNull();
  });

  test('authorized citation passes', () => {
    const authorized = citationsFromEvidence([ev()]);
    expect(validateCitations([authorized[0]!], authorized)).toEqual([]);
  });

  test('fabricated citation id rejected', () => {
    const authorized = citationsFromEvidence([ev()]);
    const fake: BriefCitation = { ...authorized[0]!, recordId: 'AWD-999' };
    expect(validateCitations([fake], authorized).length).toBeGreaterThan(0);
  });

  test('eventDate mismatch rejected rather than pretending support', () => {
    const authorized = citationsFromEvidence([ev()]);
    const tampered: BriefCitation = { ...authorized[0]!, eventDate: '2030-12-31' };
    const issues = validateCitations([tampered], authorized);
    expect(issues.some((i) => i.reason.includes('eventDate'))).toBe(true);
  });

  test('retrievedAt/sourceUpdatedAt mismatches also rejected', () => {
    const authorized = citationsFromEvidence([ev()]);
    const tampered: BriefCitation = { ...authorized[0]!, retrievedAt: '2030-01-01T00:00:00Z' };
    expect(validateCitations([tampered], authorized).length).toBeGreaterThan(0);
    const tampered2: BriefCitation = { ...authorized[0]!, sourceUpdatedAt: '2030-01-01' };
    expect(validateCitations([tampered2], authorized).length).toBeGreaterThan(0);
  });
});

describe('diffSections / preserveUserEdits', () => {
  const base = generateSections({ identityName: 'X', identityBasis: 'uei_exact', evidence: [ev()] });
  const fresh = generateSections({
    identityName: 'X',
    identityBasis: 'uei_exact',
    evidence: [ev({ title: 'Different title', eventDate: '2026-06-01' })],
  });

  test('diff flags changed sections only', () => {
    const diff = diffSections(base, fresh);
    expect(diff).toHaveLength(5);
    for (const d of diff) {
      expect(d.changed).toBe(d.baseText !== d.proposedText);
    }
  });

  test('user-edited sections survive a refresh overlay', () => {
    const edited = { ...base, judgment: { ...base.judgment, text: 'My own judgment.', provenance: 'edited' as const } };
    const merged = preserveUserEdits(edited, fresh);
    expect(merged.judgment.text).toBe('My own judgment.');
    expect(merged.judgment.provenance).toBe('edited');
    // untouched generated sections take the fresh text
    expect(merged.companyAndFirmImplication.text).toBe(fresh.companyAndFirmImplication.text);
  });
});

describe('buildSourceSnapshot', () => {
  test('snapshot is bounded and carries identity + verbatim evidence', () => {
    const snap = buildSourceSnapshot(
      '2026-03-01T00:00:00Z',
      { canonicalEntityId: 'e1', canonicalName: 'Acme', identityBasis: 'uei_exact' },
      [ev()],
    );
    expect(snap.generatedAt).toBe('2026-03-01T00:00:00Z');
    expect(snap.evidence[0]!.recordId).toBe('AWD-1');
  });
});

describe('checkClaimDeterministic (BD-CLAIM stays dark — no Jev)', () => {
  const [citation] = citationsFromEvidence([ev()]);

  test('identity: resolves to the stable source identity', () => {
    const out = checkClaimDeterministic({ claimType: 'identity', citation });
    expect(out.outcome.kind).toBe('supported');
  });

  test('date: exact match supported, mismatch qualified with the real date', () => {
    expect(
      checkClaimDeterministic({ claimType: 'date', citation, expected: '2026-01-15' }).outcome.kind,
    ).toBe('supported');
    const mismatch = checkClaimDeterministic({ claimType: 'date', citation, expected: '2020-01-01' });
    expect(mismatch.outcome.kind).toBe('qualified');
    expect(JSON.stringify(mismatch.outcome)).toContain('2026-01-15');
  });

  test('stage: exact match supported, mismatch qualified', () => {
    expect(
      checkClaimDeterministic({ claimType: 'stage', citation, expected: 'obligated' }).outcome.kind,
    ).toBe('supported');
    const m = checkClaimDeterministic({ claimType: 'stage', citation, expected: 'planned' });
    expect(m.outcome.kind).toBe('qualified');
  });

  test('exact_amount: appears verbatim in record text → supported; otherwise unsupported (no pretending)', () => {
    expect(
      checkClaimDeterministic({ claimType: 'exact_amount', citation, expected: 'infrastructure' })
        .outcome.kind,
    ).toBe('supported');
    const m = checkClaimDeterministic({ claimType: 'exact_amount', citation, expected: '$9,999,999' });
    expect(m.outcome.kind).toBe('unsupported');
  });

  test('missing citation → unsupported, never invented', () => {
    const out = checkClaimDeterministic({ claimType: 'date', citation: null, expected: '2026-01-15' });
    expect(out.outcome.kind).toBe('unsupported');
  });
});

describe('hashSections stability', () => {
  test('same sections → same hash', () => {
    const a = generateSections({ identityName: 'X', identityBasis: 'uei_exact', evidence: [ev()] });
    const b = generateSections({ identityName: 'X', identityBasis: 'uei_exact', evidence: [ev()] });
    expect(hashSections(a)).toBe(hashSections(b));
  });
});
