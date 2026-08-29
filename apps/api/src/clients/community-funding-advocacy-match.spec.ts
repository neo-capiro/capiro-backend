import { normalizeIdentityText } from '../government-data/community-funding/community-funding.parser.js';
import {
  COMMUNITY_FUNDING_FUZZY_THRESHOLD,
  communityFundingFindingSummary,
  communityFundingFindingTitle,
  communityFundingMatchConfidence,
  filterAmbiguousCommunityFundingMatches,
  recipientTokenOverlap,
  resolveCommunityFundingRecipientMatch,
  type CommunityFundingMatchDecision,
} from './community-funding-advocacy-match.js';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    requestId: '11111111-1111-1111-1111-111111111111',
    recipientName: 'Johnson C. Smith University',
    recipientNormalized: normalizeIdentityText('Johnson C. Smith University'),
    state: 'NC',
    confirmedRequestIds: new Set<string>(),
    clientName: 'Johnson C. Smith University',
    clientStates: new Set<string>(['NC']),
    ...overrides,
  };
}

describe('community-funding advocacy match hierarchy', () => {
  test('confirmed client_intel_mapping always matches at confidence 1', () => {
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const d = resolveCommunityFundingRecipientMatch(
      baseInput({
        requestId: id,
        confirmedRequestIds: new Set([id]),
        clientName: 'Totally Different Name',
        recipientSimilarity: 0,
      }),
    );
    expect(d).toEqual({
      matched: true,
      method: 'confirmed_client_intel_mapping',
      confidence: 1,
      similarity: null,
      geographyCorroborated: false,
    });
    expect(communityFundingMatchConfidence(true, 'confirmed_client_intel_mapping', 0)).toBe(1);
  });

  test('exact normalized recipient name matches without geography', () => {
    const d = resolveCommunityFundingRecipientMatch(
      baseInput({ clientStates: new Set(), recipientSimilarity: undefined }),
    );
    expect(d.matched).toBe(true);
    if (d.matched) {
      expect(d.method).toBe('exact_recipient_normalized');
      expect(d.confidence).toBe(0.98);
    }
  });

  test('exact alias match when alias set is supplied', () => {
    const d = resolveCommunityFundingRecipientMatch(
      baseInput({
        clientName: 'JCSU Holdings',
        clientAliasesNormalized: new Set([
          normalizeIdentityText('Johnson C. Smith University'),
        ]),
        clientStates: new Set(),
      }),
    );
    expect(d.matched).toBe(true);
    if (d.matched) expect(d.method).toBe('exact_alias');
  });

  test('fuzzy + geography corroboration matches', () => {
    const d = resolveCommunityFundingRecipientMatch(
      baseInput({
        clientName: 'Johnson Smith Univ',
        recipientSimilarity: 0.85,
        clientStates: new Set(['NC']),
        state: 'NC',
      }),
    );
    expect(d.matched).toBe(true);
    if (d.matched) {
      expect(d.method).toBe('fuzzy_recipient_with_geography');
      expect(d.geographyCorroborated).toBe(true);
      expect(d.confidence).toBeLessThan(1);
      expect(d.confidence).toBeGreaterThanOrEqual(COMMUNITY_FUNDING_FUZZY_THRESHOLD);
    }
  });

  test('weak fuzzy without geography is skipped (fail closed)', () => {
    const d = resolveCommunityFundingRecipientMatch(
      baseInput({
        clientName: 'Johnson Smith Univ',
        recipientSimilarity: 0.85,
        clientStates: new Set(), // no facility states
        state: 'NC',
      }),
    );
    expect(d).toEqual({ matched: false, reason: 'weak_fuzzy_without_geography' });
  });

  test('fuzzy with mismatched geography is skipped', () => {
    const d = resolveCommunityFundingRecipientMatch(
      baseInput({
        clientName: 'Johnson Smith Univ',
        recipientSimilarity: 0.9,
        clientStates: new Set(['CA']),
        state: 'NC',
      }),
    );
    expect(d).toEqual({ matched: false, reason: 'weak_fuzzy_without_geography' });
  });

  test('below-threshold fuzzy is skipped', () => {
    const d = resolveCommunityFundingRecipientMatch(
      baseInput({
        clientName: 'Acme Robotics',
        recipientName: 'Completely Unrelated Org',
        recipientNormalized: normalizeIdentityText('Completely Unrelated Org'),
        recipientSimilarity: 0.2,
        clientStates: new Set(['NC']),
      }),
    );
    expect(d.matched).toBe(false);
    if (!d.matched) expect(d.reason).toBe('below_threshold');
  });

  test('ambiguous top-tied fuzzy matches are all dropped; exact still kept', () => {
    const exact: CommunityFundingMatchDecision = {
      matched: true,
      method: 'exact_recipient_normalized',
      confidence: 0.98,
      similarity: 1,
      geographyCorroborated: false,
    };
    const fuzzyA: CommunityFundingMatchDecision = {
      matched: true,
      method: 'fuzzy_recipient_with_geography',
      confidence: 0.8,
      similarity: 0.9,
      geographyCorroborated: true,
    };
    const fuzzyB: CommunityFundingMatchDecision = {
      matched: true,
      method: 'fuzzy_recipient_with_geography',
      confidence: 0.8,
      similarity: 0.9,
      geographyCorroborated: true,
    };
    const kept = filterAmbiguousCommunityFundingMatches([
      { requestId: 'exact', decision: exact },
      { requestId: 'a', decision: fuzzyA },
      { requestId: 'b', decision: fuzzyB },
    ]);
    expect(kept.map((k) => k.requestId)).toEqual(['exact']);
  });

  test('unique top fuzzy score is kept along with lower distinct fuzzy hits', () => {
    const top: CommunityFundingMatchDecision = {
      matched: true,
      method: 'fuzzy_recipient_with_geography',
      confidence: 0.85,
      similarity: 0.95,
      geographyCorroborated: true,
    };
    const lower: CommunityFundingMatchDecision = {
      matched: true,
      method: 'fuzzy_recipient_with_geography',
      confidence: 0.75,
      similarity: 0.8,
      geographyCorroborated: true,
    };
    const kept = filterAmbiguousCommunityFundingMatches([
      { requestId: 'top', decision: top },
      { requestId: 'lower', decision: lower },
    ]);
    expect(kept.map((k) => k.requestId).sort()).toEqual(['lower', 'top']);
  });

  test('House CPF and Senate CDS titles/summaries use correct labels and do not claim lobbying/success', () => {
    const cpfTitle = communityFundingFindingTitle({
      chamber: 'house',
      requestType: 'cpf',
      fiscalYear: 2026,
      recipientName: 'Acme Org',
    });
    const cdsTitle = communityFundingFindingTitle({
      chamber: 'senate',
      requestType: 'cds',
      fiscalYear: 2026,
      recipientName: 'Acme Org',
    });
    expect(cpfTitle).toContain('Community Project Funding');
    expect(cdsTitle).toContain('Congressionally Directed Spending');
    expect(cpfTitle).not.toContain('lobbied');
    const summary = communityFundingFindingSummary({
      chamber: 'house',
      requestType: 'cpf',
      fiscalYear: 2026,
      requesterName: 'Adams',
      recipientName: 'Acme Org',
      projectTitle: 'Lab renovation',
      requestedAmountUsd: '1000000.00',
      amountStageRaw: 'house_amount',
      appropriationsAccountRaw: 'DOC / NIST',
      subcommittee: 'CJS',
    });
    expect(summary).toContain('public evidence');
    expect(summary).toMatch(/does not by itself prove/);
    expect(summary).toContain('secured the funds'); // only inside the negation clause
    expect(summary).not.toMatch(/successfully secured|client lobbied|personally submitted the request\./i);
  });

  test('recipientTokenOverlap is symmetric and bounded', () => {
    expect(recipientTokenOverlap('Johnson C Smith University', 'Johnson Smith Univ')).toBeGreaterThan(
      0.3,
    );
    expect(recipientTokenOverlap('A', 'B')).toBe(0);
  });
});
