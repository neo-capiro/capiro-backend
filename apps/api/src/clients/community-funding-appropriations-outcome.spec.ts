import {
  buildAppropriationsOutcomeFinding,
  isCommunityFundingAdvocacyRecord,
  matchCommunityFundingAppropriationsDeterministically,
  normalizeAppropriationsAccountKey,
  parseFiscalYear,
} from './community-funding-appropriations-outcome.js';

describe('deterministic CPF/CDS appropriations outcome correlation', () => {
  const requestId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const account = 'DOC / NIST—STRS';

  test('isCommunityFundingAdvocacyRecord recognizes cpf/cds shapes', () => {
    expect(isCommunityFundingAdvocacyRecord({ recordType: 'cpf_request' })).toBe(true);
    expect(isCommunityFundingAdvocacyRecord({ recordType: 'cds_request' })).toBe(true);
    expect(isCommunityFundingAdvocacyRecord({ sourceType: 'community_funding' })).toBe(true);
    expect(
      isCommunityFundingAdvocacyRecord({ externalKey: `community_funding:${requestId}` }),
    ).toBe(true);
    expect(isCommunityFundingAdvocacyRecord({ recordType: 'federal_lobbying' })).toBe(false);
  });

  test('exact canonical request id match is strongly_aligned with causationClaimed:false', () => {
    const match = matchCommunityFundingAppropriationsDeterministically(
      {
        externalKey: `community_funding:${requestId}`,
        sourceType: 'community_funding',
        sourceId: requestId,
        communityFundingRequestId: requestId,
        fiscalYear: 2026,
      },
      {
        communityFundingRequestId: requestId,
        fiscalYear: 2026,
        amountStage: 'enacted',
        amountTo: '500000.00',
      },
      {
        attributableActivityDate: new Date('2025-06-01T00:00:00.000Z'),
        outcomeObservedAt: new Date('2026-01-15T00:00:00.000Z'),
      },
    );
    expect(match).toEqual(
      expect.objectContaining({
        matchedOn: 'community_funding_request_id',
        relationship: 'strongly_aligned',
        causationClaimed: false,
        communityFundingRequestId: requestId,
        score: 0.97,
      }),
    );
  });

  test('exact appropriations account + fiscal year match (no request id) works', () => {
    const match = matchCommunityFundingAppropriationsDeterministically(
      {
        recordType: 'cpf_request',
        appropriationsAccountRaw: account,
        fiscalYear: 2026,
      },
      {
        appropriationsAccountRaw: 'doc/nist—strs', // normalization must agree
        fiscalYear: '2026',
        amountStage: 'conference',
      },
    );
    expect(match?.matchedOn).toBe('appropriations_account_fy');
    expect(match?.causationClaimed).toBe(false);
    expect(match?.fiscalYear).toBe(2026);
    expect(match?.accountKey).toBe(normalizeAppropriationsAccountKey(account));
  });

  test('account match without fiscal year fails closed', () => {
    expect(
      matchCommunityFundingAppropriationsDeterministically(
        { recordType: 'cpf_request', appropriationsAccountRaw: account, fiscalYear: 2026 },
        { appropriationsAccountRaw: account },
      ),
    ).toBeNull();
  });

  test('fiscal year match without account fails closed', () => {
    expect(
      matchCommunityFundingAppropriationsDeterministically(
        { recordType: 'cpf_request', fiscalYear: 2026 },
        { fiscalYear: 2026, notes: 'funding increased for lab renovation' },
      ),
    ).toBeNull();
  });

  test('mismatched request ids fail closed even if account/FY agree', () => {
    expect(
      matchCommunityFundingAppropriationsDeterministically(
        {
          communityFundingRequestId: requestId,
          appropriationsAccountRaw: account,
          fiscalYear: 2026,
        },
        {
          communityFundingRequestId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          appropriationsAccountRaw: account,
          fiscalYear: 2026,
        },
      ),
    ).toBeNull();
  });

  test('outcome observed at or before attributable activity is rejected', () => {
    expect(
      matchCommunityFundingAppropriationsDeterministically(
        { communityFundingRequestId: requestId },
        { communityFundingRequestId: requestId },
        {
          attributableActivityDate: new Date('2026-03-01T00:00:00.000Z'),
          outcomeObservedAt: new Date('2026-02-01T00:00:00.000Z'),
        },
      ),
    ).toBeNull();
    expect(
      matchCommunityFundingAppropriationsDeterministically(
        { communityFundingRequestId: requestId },
        { communityFundingRequestId: requestId },
        {
          attributableActivityDate: new Date('2026-03-01T00:00:00.000Z'),
          outcomeObservedAt: new Date('2026-03-01T00:00:00.000Z'),
        },
      ),
    ).toBeNull();
  });

  test('notes/title similarity alone never produces a match', () => {
    expect(
      matchCommunityFundingAppropriationsDeterministically(
        {
          recordType: 'cpf_request',
          // no request id, no account
          fiscalYear: 2026,
        },
        {
          notes: 'Johnson C. Smith University lab renovation was fully funded in the omnibus',
          fiscalYear: 2026,
        },
      ),
    ).toBeNull();
  });

  test('finding builder always sets causationClaimed:false and never claims funding was secured', () => {
    const match = matchCommunityFundingAppropriationsDeterministically(
      { communityFundingRequestId: requestId, fiscalYear: 2026 },
      { communityFundingRequestId: requestId, fiscalYear: 2026 },
    )!;
    const finding = buildAppropriationsOutcomeFinding({
      matterId: 'matter-1',
      advocacyExternalKey: `community_funding:${requestId}`,
      communityFundingRequestId: requestId,
      outcome: {
        id: 'outcome-1',
        kind: 'funding_changed',
        sourceType: 'funding_opportunity',
        observedAt: '2026-04-01T00:00:00.000Z',
        evidence: { communityFundingRequestId: requestId, fiscalYear: 2026 },
      },
      match,
    });
    expect(finding.causationClaimed).toBe(false);
    expect(finding.matchedOn).toBe('community_funding_request_id');
    expect(String(finding.summary).toLowerCase()).toContain('not proof');
    expect(String(finding.summary).toLowerCase()).toContain('identifier');
    // Must not make an affirmative secured-funding claim outside the negation clause.
    expect(String(finding.summary)).toMatch(/not proof the recipient secured the funds/i);
    expect(String(finding.summary)).not.toMatch(
      /\b(successfully secured|client secured|recipient secured the funds because)\b/i,
    );
  });

  test('parseFiscalYear accepts int and 4-digit string only', () => {
    expect(parseFiscalYear(2026)).toBe(2026);
    expect(parseFiscalYear('2026')).toBe(2026);
    expect(parseFiscalYear('FY2026')).toBeNull();
    expect(parseFiscalYear(1800)).toBeNull();
  });
});
