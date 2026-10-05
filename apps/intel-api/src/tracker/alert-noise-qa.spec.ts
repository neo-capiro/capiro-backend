import { explainMatch, wholeWordHit, issueAreaHit } from './relevance.util.js';
import { scoreBillFit } from './bill-fit.util.js';

describe('defense alert precision', () => {
  it.each(['Self-defense.', 'Indigent defense.', 'Civil Procedure: recovery of defense costs', 'Criminal procedure: indigent defense compensation'])('rejects ambiguous legal uses: %s', (title) => {
    expect(wholeWordHit(title.toLowerCase(), 'Defense', title)).toBe(false);
    expect(explainMatch({ title }, { tags: [], issueAreas: ['Defense', 'Homeland Security'] }).matchedTags).toEqual([]);
    expect(scoreBillFit({ title }, [], ['Defense'], 0, true).fit).toBe(0);
  });
  it('retains military and explicit legal-interest matches', () => {
    expect(wholeWordHit('national defense authorization', 'Defense')).toBe(true);
    expect(wholeWordHit('indigent defense', 'indigent defense')).toBe(true);
    expect(wholeWordHit('self-defense and national defense', 'Defense')).toBe(true);
  });
  it('does not split Homeland Security into a generic security match', () => {
    expect(issueAreaHit('office of food security and affordability', 'Homeland Security')).toBe(false);
    expect(issueAreaHit('department of homeland security', 'Homeland Security')).toBe(true);
  });
});
