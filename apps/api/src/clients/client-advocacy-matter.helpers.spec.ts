import {
  computeMatterClue,
  titleTokens,
  tokenOverlap,
  TITLE_OVERLAP_THRESHOLD,
} from './client-advocacy-matter.helpers.js';

describe('Advocacy Matter clustering', () => {
  test('clusters by Program Element code above any other signal', () => {
    const clue = computeMatterClue({
      recordType: 'client_submission',
      title: 'FY27 ground robotics funding ask',
      metadata: { programElement: '0605053a', billId: '119-hr-1234' },
    });
    expect(clue.key).toBe('pe:0605053A');
    expect(clue.matterType).toBe('program_element');
    expect(clue.primaryPeCode).toBe('0605053A');
    expect(clue.primaryBillId).toBeNull();
  });

  test('clusters by bill id when no Program Element is present', () => {
    const clue = computeMatterClue({
      recordType: 'federal_lobbying',
      title: 'NDAA autonomous systems language',
      metadata: { billId: '119-hr-1234' },
    });
    expect(clue.key).toBe('bill:119-hr-1234');
    expect(clue.matterType).toBe('legislative');
    expect(clue.primaryBillId).toBe('119-hr-1234');
  });

  test('clusters LDA filings by issue code when no PE/bill is present', () => {
    const clue = computeMatterClue({
      recordType: 'federal_lobbying',
      title: '2027 Q1 — DEF',
      metadata: { issueCodes: ['def'] },
    });
    expect(clue.key).toBe('issue:DEF');
    expect(clue.matterType).toBe('legislative');
  });

  test('falls back to a deterministic title hash with no PE/bill/issue signal', () => {
    const a = computeMatterClue({
      recordType: 'client_submission',
      title: 'Community project funding request for the new radar facility',
      metadata: {},
    });
    const b = computeMatterClue({
      recordType: 'client_submission',
      title: 'community project funding request for the new radar facility',
      metadata: {},
    });
    expect(a.key).toBe(b.key);
    expect(a.key.startsWith('auto:')).toBe(true);
  });

  test('two differently-worded titles about the same ask produce high token overlap', () => {
    const overlap = tokenOverlap(
      titleTokens('FY27 Ground Robotics Funding Request'),
      titleTokens('FY27 ground robotics funding increase request'),
    );
    expect(overlap).toBeGreaterThanOrEqual(TITLE_OVERLAP_THRESHOLD);
  });

  test('two unrelated titles produce low token overlap', () => {
    const overlap = tokenOverlap(
      titleTokens('FY27 Ground Robotics Funding Request'),
      titleTokens('AI Procurement Regulation comment letter'),
    );
    expect(overlap).toBeLessThan(TITLE_OVERLAP_THRESHOLD);
  });
});
