import { describe, expect, it } from 'vitest';
import {
  RESEARCH_PORTFOLIOS_ROOT,
  isVNextResearchPortfolioPath,
  matchResearchPortfolioPath,
} from './research-portfolios-routes.js';

const ID = '12345678-1234-4234-9234-123456789abc';

describe('research-portfolios vNext route contract', () => {
  it('claims the root path', () => {
    expect(isVNextResearchPortfolioPath(RESEARCH_PORTFOLIOS_ROOT)).toBe(true);
    expect(isVNextResearchPortfolioPath(RESEARCH_PORTFOLIOS_ROOT + '/')).toBe(false);
  });

  it('claims a detail path with a UUID', () => {
    expect(matchResearchPortfolioPath(`${RESEARCH_PORTFOLIOS_ROOT}/${ID}`)).toEqual({
      kind: 'detail',
      portfolioId: ID,
    });
    expect(isVNextResearchPortfolioPath(`${RESEARCH_PORTFOLIOS_ROOT}/${ID}/`)).toBe(false);
  });

  it('rejects non-UUID and reserved detail segments', () => {
    expect(isVNextResearchPortfolioPath(`${RESEARCH_PORTFOLIOS_ROOT}/some-id`)).toBe(false);
    expect(isVNextResearchPortfolioPath(`${RESEARCH_PORTFOLIOS_ROOT}/templates`)).toBe(false);
    expect(isVNextResearchPortfolioPath(`${RESEARCH_PORTFOLIOS_ROOT}/taxonomy`)).toBe(false);
  });

  it('rejects extra segments', () => {
    expect(isVNextResearchPortfolioPath(`${RESEARCH_PORTFOLIOS_ROOT}/${ID}/extra`)).toBe(false);
    expect(isVNextResearchPortfolioPath(`${RESEARCH_PORTFOLIOS_ROOT}/${ID}/extra/`)).toBe(false);
  });

  it('rejects encoded slash', () => {
    expect(isVNextResearchPortfolioPath(`${RESEARCH_PORTFOLIOS_ROOT}/${ID}%2Fextra`)).toBe(false);
  });

  it('rejects malformed root', () => {
    expect(isVNextResearchPortfolioPath(`${RESEARCH_PORTFOLIOS_ROOT}s`)).toBe(false);
    expect(isVNextResearchPortfolioPath(`/research-portfolio`)).toBe(false);
    expect(isVNextResearchPortfolioPath(`/research-portfolios/`)).toBe(false);
  });

  it('does not claim unrelated paths', () => {
    expect(isVNextResearchPortfolioPath('/program-elements')).toBe(false);
    expect(isVNextResearchPortfolioPath('/clients')).toBe(false);
  });
});
