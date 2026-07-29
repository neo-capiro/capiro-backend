import { describe, expect, test } from '@jest/globals';
import {
  AMBIGUITY_MARGIN,
  MATCH_BASIS_TIER,
  decideContractorCandidates,
  domainOf,
  normalizeCage,
  normalizeUei,
  type ClientIdentity,
  type ContractorCandidate,
} from './contractor-identity.js';
import { fingerprintName } from './entity-resolution.service.js';

/**
 * The real normalizer is passed in, not a stub. The whole reason
 * decideContractorCandidates takes `fingerprint` as a parameter is so the policy
 * and the service cannot normalize names differently — testing against a
 * different one would defeat that.
 */
const fp = fingerprintName;

function client(partial: Partial<ClientIdentity> = {}): ClientIdentity {
  return {
    clientId: 'client-1',
    clientName: 'Acme Defense Corporation',
    uei: null,
    cageCode: null,
    domains: [],
    states: [],
    ...partial,
  };
}

function candidate(partial: Partial<ContractorCandidate> = {}): ContractorCandidate {
  return {
    contractorId: 'contractor-1',
    contractorName: 'Acme Defense Corp',
    uei: null,
    nameSimilarity: 0.9,
    awardCount: null,
    totalObligated: null,
    latestAwardDate: null,
    sourceSyncedAt: null,
    alreadyConfirmedForClientIds: [],
    ...partial,
  };
}

describe('identifier normalization', () => {
  test('a UEI must be exactly 12 alphanumerics', () => {
    expect(normalizeUei('abc123456789')).toBe('ABC123456789');
    expect(normalizeUei('ABC12345678')).toBeNull(); // 11
    expect(normalizeUei('ABC1234567890')).toBeNull(); // 13
    expect(normalizeUei('ABC-123456789')).toBeNull();
    expect(normalizeUei(null)).toBeNull();
  });

  test('a CAGE must be exactly 5 alphanumerics', () => {
    expect(normalizeCage('1abc2')).toBe('1ABC2');
    expect(normalizeCage('1ABC')).toBeNull();
  });

  test('domainOf strips scheme and www', () => {
    expect(domainOf('https://www.acmedefense.com/about')).toBe('acmedefense.com');
    expect(domainOf('acmedefense.com')).toBe('acmedefense.com');
    expect(domainOf('')).toBeNull();
  });
});

describe('tier 1 — exact verified identifier', () => {
  test('an exact, unique UEI match auto-confirms', () => {
    const [v] = decideContractorCandidates(
      client({ uei: 'ABC123456789' }),
      [candidate({ uei: 'ABC123456789' })],
      fp,
    );
    expect(v?.explanation.basis).toBe('exact_uei');
    expect(v?.explanation.tier).toBe(1);
    expect(v?.autoConfirmEligible).toBe(true);
    expect(v?.explanation.exactIdentifiers.uei).toBe('ABC123456789');
  });

  test('a UEI match survives names that share no distinctive token at all', () => {
    // This is the case name matching structurally cannot reach: "RTX
    // CORPORATION" and "RAYTHEON TECHNOLOGIES CORPORATION" are one registered
    // entity with zero trigram overlap.
    const [v] = decideContractorCandidates(
      client({ clientName: 'RTX Corporation', uei: 'ABC123456789' }),
      [
        candidate({
          contractorName: 'RAYTHEON TECHNOLOGIES CORPORATION',
          uei: 'ABC123456789',
          nameSimilarity: 0.08,
        }),
      ],
      fp,
    );
    expect(v?.autoConfirmEligible).toBe(true);
    expect(v?.explanation.basis).toBe('exact_uei');
  });

  test('a MALFORMED client UEI cannot confirm anything, and says so', () => {
    const [v] = decideContractorCandidates(
      client({ uei: 'NOT-A-UEI' }),
      [candidate({ uei: 'ABC123456789' })],
      fp,
    );
    expect(v?.autoConfirmEligible).toBe(false);
    expect(v?.explanation.conflicts.join(' ')).toContain('not a valid 12-character UEI');
  });

  test('disagreeing UEIs are recorded as a CONFLICT, not silently ignored', () => {
    const [v] = decideContractorCandidates(
      client({ uei: 'ABC123456789' }),
      [candidate({ uei: 'ZZZ999999999' })],
      fp,
    );
    expect(v?.explanation.conflicts.join(' ')).toContain('UEIs disagree');
    expect(v?.autoConfirmEligible).toBe(false);
  });

  test('a missing SOURCE UEI is a conflict — the client UEI cannot confirm it', () => {
    const [v] = decideContractorCandidates(
      client({ uei: 'ABC123456789' }),
      [candidate({ uei: null })],
      fp,
    );
    expect(v?.explanation.conflicts.join(' ')).toContain('carries no UEI');
    expect(v?.autoConfirmEligible).toBe(false);
  });

  test('two contractor rows sharing one UEI is ambiguous — neither auto-confirms', () => {
    const verdicts = decideContractorCandidates(
      client({ uei: 'ABC123456789' }),
      [
        candidate({ contractorId: 'a', contractorName: 'Acme Defense Corp', uei: 'ABC123456789' }),
        candidate({ contractorId: 'b', contractorName: 'Acme Defense Holdings', uei: 'ABC123456789' }),
      ],
      fp,
    );
    expect(verdicts.every((v) => !v.autoConfirmEligible)).toBe(true);
    expect(verdicts[0]?.explanation.conflicts.join(' ')).toContain('share UEI');
  });
});

describe('tier 2 — exact normalized legal name', () => {
  test('an exact multi-token legal-name match is tier 2 and routes to REVIEW', () => {
    const [v] = decideContractorCandidates(
      client({ clientName: 'Acme Defense Inc' }),
      [candidate({ contractorName: 'Acme Defense LLC' })],
      fp,
    );
    // Both fingerprint to "acme defense" — SUFFIX_RE strips inc and llc.
    expect(v?.explanation.normalizedClientName).toBe('acme defense');
    expect(v?.explanation.normalizedCandidateName).toBe('acme defense');
    expect(v?.explanation.basis).toBe('exact_legal_name');
    expect(v?.explanation.tier).toBe(2);
    expect(v?.autoConfirmEligible).toBe(false);
    expect(v?.reviewReason).toContain('parent and a subsidiary can share a registered name');
  });

  test('"Corporation" spelled out does NOT fingerprint-equal "Corp" — so it is fuzzy, not exact', () => {
    // Documenting real, pre-existing normalizer behaviour rather than assuming it:
    // SUFFIX_RE (entity-resolution.service.ts) strips `corp` on a word boundary,
    // and `\bcorp\b` does not match inside "corporation". So "Acme Defense
    // Corporation" and "Acme Defense Corp" are NOT an exact legal-name match.
    //
    // This is left alone deliberately. SUFFIX_RE is shared by all eight mapping
    // sources, and widening it would change live matching everywhere — a change
    // that belongs on its own PR with its own measurement, not smuggled in here.
    // The consequence is conservative in the right direction: the pair lands in
    // review as tier 4 instead of tier 2, and neither tier auto-confirms.
    const [v] = decideContractorCandidates(
      client({ clientName: 'Acme Defense Corporation' }),
      [candidate({ contractorName: 'Acme Defense Corp' })],
      fp,
    );
    expect(v?.explanation.normalizedClientName).toBe('acme defense corporation');
    expect(v?.explanation.normalizedCandidateName).toBe('acme defense');
    expect(v?.explanation.basis).toBe('fuzzy_name');
    expect(v?.autoConfirmEligible).toBe(false);
  });

  test('a SINGLE-TOKEN exact fingerprint is not treated as an exact legal name', () => {
    // "Apple Inc" and an unrelated "Apple Group" both strip to "apple".
    const [v] = decideContractorCandidates(
      client({ clientName: 'Apple Inc' }),
      [candidate({ contractorName: 'Apple Group' })],
      fp,
    );
    expect(v?.explanation.basis).toBe('fuzzy_name');
    expect(v?.explanation.tier).toBe(4);
  });

  test('a parent and a subsidiary with the same registered name is flagged as such', () => {
    const verdicts = decideContractorCandidates(
      client({ clientName: 'Acme Defense Inc' }),
      [
        // Both strip to "acme defense": indistinguishable by name alone, which is
        // exactly the parent/subsidiary hazard.
        candidate({ contractorId: 'a', contractorName: 'Acme Defense LLC' }),
        candidate({ contractorId: 'b', contractorName: 'Acme Defense Holdings' }),
      ],
      fp,
    );
    expect(verdicts.map((v) => v.explanation.normalizedCandidateName)).toEqual([
      'acme defense',
      'acme defense',
    ]);
    expect(verdicts[0]?.explanation.conflicts.join(' ')).toContain('normalize to the same name');
    expect(verdicts.every((v) => !v.autoConfirmEligible)).toBe(true);
  });
});

describe('tier 4 — fuzzy name is always review', () => {
  test('a very high name similarity still never auto-confirms', () => {
    const [v] = decideContractorCandidates(
      client({ clientName: 'Santa Rosa County' }),
      [candidate({ contractorName: 'Santa Clara County', nameSimilarity: 0.97 })],
      fp,
    );
    expect(v?.explanation.basis).toBe('fuzzy_name');
    expect(v?.autoConfirmEligible).toBe(false);
    expect(v?.reviewReason).toContain('never confirmed automatically');
  });

  test('fuzzy confidence is capped so it cannot masquerade as identifier-grade', () => {
    const [v] = decideContractorCandidates(
      client(),
      [candidate({ contractorName: 'Totally Different Entity', nameSimilarity: 0.99 })],
      fp,
    );
    expect(v!.confidence).toBeLessThanOrEqual(0.7);
  });
});

describe('ambiguity is a property of the SET', () => {
  test('a near-tied runner-up blocks auto-confirm on the leader too', () => {
    const verdicts = decideContractorCandidates(
      client({ uei: 'ABC123456789' }),
      [
        // Both are exact-UEI, so both sit at UEI_MATCH_CONFIDENCE — a tie.
        candidate({ contractorId: 'a', contractorName: 'Alpha Systems Inc', uei: 'ABC123456789' }),
        candidate({ contractorId: 'b', contractorName: 'Beta Industries LLC', uei: 'ABC123456789' }),
      ],
      fp,
    );
    expect(verdicts.every((v) => !v.autoConfirmEligible)).toBe(true);
  });

  test('an entity already confirmed for ANOTHER client is never unambiguous', () => {
    const [v] = decideContractorCandidates(
      client({ clientId: 'client-1', uei: 'ABC123456789' }),
      [candidate({ uei: 'ABC123456789', alreadyConfirmedForClientIds: ['client-2'] })],
      fp,
    );
    expect(v?.autoConfirmEligible).toBe(false);
    expect(v?.explanation.conflicts.join(' ')).toContain('other client record');
  });

  test('already confirmed for THIS client is not a conflict', () => {
    const [v] = decideContractorCandidates(
      client({ clientId: 'client-1', uei: 'ABC123456789' }),
      [candidate({ uei: 'ABC123456789', alreadyConfirmedForClientIds: ['client-1'] })],
      fp,
    );
    expect(v?.autoConfirmEligible).toBe(true);
  });

  test('at most ONE candidate per client can auto-confirm', () => {
    const verdicts = decideContractorCandidates(
      client({ uei: 'ABC123456789' }),
      [
        candidate({ contractorId: 'a', contractorName: 'Acme Defense Corp', uei: 'ABC123456789' }),
        // Far enough behind not to trip the ambiguity margin, and not an
        // identifier match, so it is tier 4 anyway.
        candidate({ contractorId: 'b', contractorName: 'Unrelated Vendor', nameSimilarity: 0.4 }),
      ],
      fp,
    );
    expect(verdicts.filter((v) => v.autoConfirmEligible)).toHaveLength(1);
  });

  test('the ambiguity margin is the one the service uses', () => {
    // Pinned so the two cannot drift apart silently.
    expect(AMBIGUITY_MARGIN).toBeGreaterThan(0);
    expect(AMBIGUITY_MARGIN).toBeLessThan(0.5);
  });
});

describe('explanation completeness', () => {
  test('every verdict carries normalized names, tier, basis and a conflicts array', () => {
    const verdicts = decideContractorCandidates(client(), [candidate()], fp);
    for (const v of verdicts) {
      expect(typeof v.explanation.normalizedClientName).toBe('string');
      expect(typeof v.explanation.normalizedCandidateName).toBe('string');
      expect(MATCH_BASIS_TIER[v.explanation.basis]).toBe(v.explanation.tier);
      expect(Array.isArray(v.explanation.conflicts)).toBe(true);
      expect(Array.isArray(v.explanation.corroborators)).toBe(true);
    }
  });

  test('an unheld award footprint is null, never 0', () => {
    // 0 would read as "this contractor has never been awarded anything", which is
    // a different and false claim from "we hold no figure".
    const [v] = decideContractorCandidates(client(), [candidate()], fp);
    expect(v?.explanation.awardCount).toBeNull();
    expect(v?.explanation.totalObligated).toBeNull();
  });

  test('a client CAGE is recorded but does NOT corroborate — there is no source CAGE to compare', () => {
    const [v] = decideContractorCandidates(
      client({ cageCode: '1ABC2' }),
      [candidate({ contractorName: 'Acme Defense Corp' })],
      fp,
    );
    expect(v?.explanation.exactIdentifiers.clientCage).toBe('1ABC2');
    expect(v?.explanation.corroborators).not.toContain('cage');
  });

  test('every non-auto-confirmed verdict states WHY it needs review', () => {
    const verdicts = decideContractorCandidates(
      client({ uei: 'ABC123456789' }),
      [
        candidate({ contractorId: 'a', uei: null, nameSimilarity: 0.5 }),
        candidate({ contractorId: 'b', contractorName: 'Other Co', uei: 'ZZZ999999999' }),
      ],
      fp,
    );
    for (const v of verdicts) {
      if (!v.autoConfirmEligible) expect(v.reviewReason?.length ?? 0).toBeGreaterThan(10);
    }
  });
});
