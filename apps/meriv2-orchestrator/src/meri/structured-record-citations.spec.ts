import { congressGovBillUrl, extractCitationsFromToolResult } from '@capiro/shared';

/**
 * Budget-line and bill-status tools return one structured record, not a row
 * array. Before this change they produced no citable source, so correct budget
 * and bill answers shipped with zero citations (simplified acceptance cases 20
 * to 24, 28, 31 and 32; program plan §1.3 item 1).
 */
describe('structured Capiro records become citable sources', () => {
  const claim = {
    value: 72.149,
    fiscalYear: 2027,
    stage: 'request',
    stageLabel: "President's Budget request",
    semantics:
      "stage=President's Budget request (budget_request vehicle) FY2027 $72.149M enactment=not_enacted source=R-1/DoD p.14",
    source: { sourceUrl: 'https://comptroller.defense.gov/r1.pdf', pageNumber: 14 },
  };

  it('cites a PE budget timeline with its budget exhibit when the claim carries one', () => {
    const [citation, ...rest] = extractCitationsFromToolResult(
      'get_pe_budget_timeline',
      {
        tool: 'get_pe_budget_timeline',
        peCode: '0603203F',
        title: 'Advanced Aerospace Sensors',
        currentCycleFy: 2027,
        currentFundingClaim: claim,
        fundingSummary: 'FY2027 request $72.149M',
        years: [],
      },
      1,
    );
    expect(rest).toEqual([]);
    expect(citation).toEqual(
      expect.objectContaining({
        n: 1,
        type: 'program_element',
        id: 'pe:0603203F',
        title: 'PE 0603203F — Advanced Aerospace Sensors (Capiro budget record)',
        url: 'https://comptroller.defense.gov/r1.pdf',
        tool: 'get_pe_budget_timeline',
      }),
    );
    expect(citation!.snippet).toContain('FY2027 $72.149M');
  });

  it('still cites a projected timeline, using the current-year claim and no invented URL', () => {
    const [citation] = extractCitationsFromToolResult(
      'get_pe_budget_timeline',
      {
        peCode: '0603203F',
        title: 'Advanced Aerospace Sensors',
        currentCycleFy: 2027,
        fundingSummary: 'FY2027 request $72.149M',
        years: [{ fy: 2027, fundingClaim: { ...claim, source: { sourceUrl: null } } }],
        projection: { truncated: true },
      },
      3,
    );
    expect(citation).toEqual(
      expect.objectContaining({ n: 3, id: 'pe:0603203F', url: null }),
    );
    expect(citation!.snippet).toContain('$72.149M');
  });

  it('cites get_program_element from its nested record and falls back to the summary', () => {
    const [citation] = extractCitationsFromToolResult(
      'get_program_element',
      {
        peCode: '0603203F',
        programElement: { peCode: '0603203F', title: 'Advanced Aerospace Sensors', years: [] },
        currentFundingClaim: null,
        fundingSummary: 'FY2027 request $72.149M',
      },
      1,
    );
    expect(citation).toEqual(
      expect.objectContaining({
        id: 'pe:0603203F',
        type: 'program_element',
        snippet: 'FY2027 request $72.149M',
      }),
    );
  });

  it('cites a found bill with its congress.gov page and each roll call that has a source page', () => {
    const citations = extractCitationsFromToolResult(
      'get_bill_status',
      {
        tool: 'get_bill_status',
        found: true,
        billId: '119-hr-8800',
        title: 'Defense Supply Chain Act',
        statusLabel: 'Passed House',
        latestAction: { text: 'Received in the Senate.', date: '2026-09-30T00:00:00.000Z' },
        floorVotes: [
          {
            chamber: 'house',
            rollNumber: 412,
            question: 'On Passage',
            result: 'Passed',
            voteDate: '2026-09-29T00:00:00.000Z',
            sourceUrl: 'https://clerk.house.gov/Votes/2026412',
          },
          { chamber: 'house', rollNumber: 411, question: 'On the Rule', sourceUrl: null },
        ],
      },
      1,
    );
    expect(citations.map((c) => [c.n, c.type, c.url])).toEqual([
      [1, 'bill', 'https://www.congress.gov/bill/119th-congress/house-bill/8800'],
      [2, 'bill', 'https://clerk.house.gov/Votes/2026412'],
    ]);
    expect(citations[0]!.snippet).toBe(
      'Status: Passed House. Latest action (2026-09-30): Received in the Senate.',
    );
    expect(citations[1]!.title).toBe('house roll call 412 (2026-09-29) on 119-hr-8800');
  });

  it('gives no citation for a bill that was not found or a tool error', () => {
    expect(
      extractCitationsFromToolResult(
        'get_bill_status',
        { found: false, billId: '119-hr-1', currentStatus: 'unavailable' },
        1,
      ),
    ).toEqual([]);
    expect(
      extractCitationsFromToolResult('get_pe_budget_timeline', { error: 'not found' }, 1),
    ).toEqual([]);
  });
});

describe('congressGovBillUrl', () => {
  it('maps canonical Capiro bill ids and rejects anything else', () => {
    expect(congressGovBillUrl('119-s-12')).toBe(
      'https://www.congress.gov/bill/119th-congress/senate-bill/12',
    );
    expect(congressGovBillUrl('121-hjres-7')).toBe(
      'https://www.congress.gov/bill/121st-congress/house-joint-resolution/7',
    );
    expect(congressGovBillUrl('112-hconres-3')).toBe(
      'https://www.congress.gov/bill/112th-congress/house-concurrent-resolution/3',
    );
    expect(congressGovBillUrl('122-sres-4')).toBe(
      'https://www.congress.gov/bill/122nd-congress/senate-resolution/4',
    );
    expect(congressGovBillUrl('H.R. 8800')).toBeNull();
    expect(congressGovBillUrl('119-xx-1')).toBeNull();
  });
});
