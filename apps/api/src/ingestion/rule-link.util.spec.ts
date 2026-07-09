import { isRuleResolutionTitle, parseRuleTargets, parseRuleFromBillAction } from './rule-link.util';

// The verbatim prod title of H.Res. 1398 (the FY2027 NDAA rule) — the exact
// case that blinded Meri. It enumerates four target measures.
const HRES_1398_TITLE =
  'Providing for consideration of the bill (H.R. 8800) to authorize appropriations for fiscal year 2027 for military activities of the Department of Defense, for military construction, and for defense activities of the Department of Energy, to prescribe military personnel strengths for such fiscal year, and for other purposes; providing for consideration of the bill (H.R. 8595) making appropriations for national security, Department of State, and related programs for the fiscal year ending September 30, 2027, and for other purposes; providing for consideration of the bill (H.R. 8884) to amend title II of the Social Security Act to reauthorize demonstration authority for the disability insurance program; providing for consideration of the resolution (H. Res. 1383) commemorating the one-year anniversary of the enactment of the Working Families Tax Cuts; and for other purposes.';

describe('isRuleResolutionTitle', () => {
  it('recognizes a providing-for-consideration rule title', () => {
    expect(isRuleResolutionTitle(HRES_1398_TITLE)).toBe(true);
    expect(isRuleResolutionTitle('National Defense Authorization Act for FY2027')).toBe(false);
    expect(isRuleResolutionTitle(null)).toBe(false);
  });
});

describe('parseRuleTargets', () => {
  it('extracts every target measure from the H.Res. 1398 title', () => {
    const targets = parseRuleTargets(HRES_1398_TITLE, 119);
    expect(targets).toContain('119-hr-8800');
    expect(targets).toContain('119-hr-8595');
    expect(targets).toContain('119-hr-8884');
    expect(targets).toContain('119-hres-1383');
    expect(targets).toHaveLength(4);
  });
  it('ignores non-bill parentheticals and dedupes', () => {
    expect(
      parseRuleTargets('Providing for consideration of the bill (H.R. 10) (as amended)', 119),
    ).toEqual(['119-hr-10']);
  });
});

describe('parseRuleFromBillAction', () => {
  it('recovers the rule hres from a target bill rule-report action', () => {
    expect(
      parseRuleFromBillAction(
        'Rules Committee Resolution H. Res. 1398 Reported to House. Rule provides for consideration of H.R. 8800, H.R. 8595, H.R. 8884 and H. Res. 1383.',
        119,
      ),
    ).toBe('119-hres-1398');
  });
  it('returns null for a non-rule action', () => {
    expect(
      parseRuleFromBillAction('Referred to the House Committee on Armed Services.', 119),
    ).toBeNull();
    expect(parseRuleFromBillAction(null, 119)).toBeNull();
  });
});
