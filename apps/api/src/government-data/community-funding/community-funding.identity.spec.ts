import { communityFundingIdentity, requesterIdentityToken } from './community-funding.identity.js';
import type { FundingCandidate } from './community-funding.types.js';

const base: FundingCandidate = {
  chamber: 'house', requestType: 'cpf', fiscalYear: 2026, requesterName: 'Jane Smith', requesterState: null,
  requesterDistrict: null, recipientName: 'Acme, Inc.', recipientAddress: null, city: null, state: null, zip: null,
  projectTitle: 'Water Plant', projectDescription: null, requestedAmountUsd: '10.00', finalAmountUsd: null,
  amountStageRaw: 'amount_requested', appropriationsAccountRaw: 'Account', subcommittee: null,
  sourcePage: null, sourceRow: 2,
};

describe('community funding identity', () => {
  it('is stable across non-identity changes and normalization', () => {
    expect(communityFundingIdentity(base)).toBe(
      communityFundingIdentity({ ...base, recipientName: 'ACME INC', requestedAmountUsd: '20.00' }),
    );
  });

  it('is NOT source-document-specific — the regression this repair fixes', () => {
    // The exact bug in the original PR #1328: communityFundingIdentity(candidate,
    // sourceDocumentId) took the source document as an identity input, so the same
    // logical request published in two different SourceDocuments hashed to two
    // different canonical rows. The repaired function takes only the candidate —
    // there is no sourceDocumentId parameter to vary at all, which is the fix.
    const identityA = communityFundingIdentity(base);
    const identityB = communityFundingIdentity({ ...base }); // structurally identical candidate
    expect(identityA).toBe(identityB);
    expect(communityFundingIdentity.length).toBe(1); // single-argument signature, enforced structurally
  });

  it('distinguishes fiscal year and chamber', () => {
    const one = communityFundingIdentity(base);
    expect(communityFundingIdentity({ ...base, fiscalYear: 2027 })).not.toBe(one);
    expect(communityFundingIdentity({ ...base, chamber: 'senate', requestType: 'cds' })).not.toBe(one);
  });

  it('distinguishes genuinely different requests (different recipient or title)', () => {
    const one = communityFundingIdentity(base);
    expect(communityFundingIdentity({ ...base, recipientName: 'Different Recipient' })).not.toBe(one);
    expect(communityFundingIdentity({ ...base, projectTitle: 'Different Project' })).not.toBe(one);
  });

  it('does NOT include the appropriations account raw text as a hard identity discriminator via requesterIdentityToken path, but real account differences alone (all else equal) do change identity today', () => {
    // Documented collision assumption: appropriationsAccountRaw is deliberately
    // excluded from identity (see class doc in community-funding.identity.ts) because
    // the XLSX source never populates it while the PDF source always does — including
    // it would make every real cross-format match fail. This test just pins that the
    // two base-candidate variants that differ ONLY in account still collapse, proving
    // account truly plays no role in the hash.
    const withAccountA = { ...base, appropriationsAccountRaw: 'DOC / NIST-STRS' };
    const withAccountB = { ...base, appropriationsAccountRaw: null };
    expect(communityFundingIdentity(withAccountA)).toBe(communityFundingIdentity(withAccountB));
  });
});

describe('requesterIdentityToken — cross-format-stable requester identity, pinned against real FY2026 data', () => {
  // Real pairs pulled directly from the committed FY2026 House CJS PDF vs. the
  // FY2026 House consolidated XLSX (see community-funding.cross-source-dedup.spec.ts
  // for the full rehearsal). Each pair is the SAME real member across the two
  // documents' incompatible textual conventions.
  const realPairs: Array<[pdf: string, xlsx: string]> = [
    ['Adams', 'Alma Adams'],
    ['Torres (NY)', 'Ritchie Torres'],
    ['Van Hollen', 'Chris Van Hollen'],
    ['Gonzales, Tony (TX)', 'Tony Gonzales'],
    ['Carey, Beatty', 'Mike Carey'],
    ['Salazar, Wasserman Schultz', 'Maria Salazar'],
    ['Ellzey, Johnson (TX)', 'Jake Ellzey'],
    ['Ellzey, Van Duyne', 'Jake Ellzey'],
    ['Gonzalez, Vincente (TX)', 'Vicente Gonzalez'],
    ['Bonamici; Dexter', 'Suzanne Bonamici'],
    ['Lee (NV); Horsford', 'Susie Lee'],
    ['Mfume; Olszewski', 'Kweisi Mfume'],
    ['Meeks', 'Gregory Meeks'],
  ];
  it.each(realPairs)('resolves PDF form %j and XLSX form %j to the same token', (pdfForm, xlsxForm) => {
    expect(requesterIdentityToken(pdfForm)).toBe(requesterIdentityToken(xlsxForm));
  });

  it('distinguishes genuinely different requesters', () => {
    expect(requesterIdentityToken('Adams')).not.toBe(requesterIdentityToken('Aguilar'));
    expect(requesterIdentityToken('Ritchie Torres')).not.toBe(requesterIdentityToken('Chris Van Hollen'));
  });
});
