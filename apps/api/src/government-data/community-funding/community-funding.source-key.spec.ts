import { communityFundingCampaignSourceKey } from './community-funding.source-key';

describe('communityFundingCampaignSourceKey', () => {
  it('disambiguates same generic title across distinct official URLs (Posted Table collision)', () => {
    const a = communityFundingCampaignSourceKey({
      chamber: 'house',
      fiscalYear: 2025,
      title: 'Posted Table',
      url: 'https://appropriations.house.gov/sites/evo-subsites/republicans-appropriations.house.gov/files/a.pdf',
    });
    const b = communityFundingCampaignSourceKey({
      chamber: 'house',
      fiscalYear: 2025,
      title: 'Posted Table',
      url: 'https://appropriations.house.gov/sites/evo-subsites/republicans-appropriations.house.gov/files/b.pdf',
    });
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^house_fy2025_posted_table_[0-9a-f]{8}$/);
    expect(b).toMatch(/^house_fy2025_posted_table_[0-9a-f]{8}$/);
  });

  it('is stable across reruns for the same official URL (idempotent checkpoint key)', () => {
    const input = {
      chamber: 'senate' as const,
      fiscalYear: 2026,
      title: 'Agriculture, Rural Development, Food and Drug Administration, and Related Agencies',
      url: 'https://www.appropriations.senate.gov/download/fy26-ag-cds',
    };
    expect(communityFundingCampaignSourceKey(input)).toEqual(
      communityFundingCampaignSourceKey(input),
    );
  });

  it('does not change when only a local artifact path would differ (key is URL+title based)', () => {
    // sourceKey must not incorporate local work-dir / temp paths — only chamber, FY, title, URL.
    const key = communityFundingCampaignSourceKey({
      chamber: 'house',
      fiscalYear: 2026,
      title: 'Consolidated Table',
      url: 'https://appropriations.house.gov/files/fy26.xlsx',
    });
    expect(key.includes('C:')).toBe(false);
    expect(key.includes('cache')).toBe(false);
    expect(key.includes('tmp')).toBe(false);
  });

  it('keeps senate download vs imo media variants distinct when titles collide', () => {
    const title = 'Homeland Security';
    const download = communityFundingCampaignSourceKey({
      chamber: 'senate',
      fiscalYear: 2022,
      title,
      url: 'https://www.appropriations.senate.gov/download/fy-22-homeland-cds',
    });
    const imo = communityFundingCampaignSourceKey({
      chamber: 'senate',
      fiscalYear: 2022,
      title,
      url: 'https://www.appropriations.senate.gov/imo/media/doc/fy22_homeland.pdf',
    });
    expect(download).not.toEqual(imo);
  });
});
